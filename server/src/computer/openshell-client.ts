import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as loader from "@grpc/proto-loader";
import type { OpenShellComputerConfig } from "../config";
import {
  OPEN_SHELL_REQUIRED_CAPABILITIES,
  type OpenShellAdminClient,
  type OpenShellSandboxEvidence,
  type OpenShellSandboxView,
  type OpenShellScope,
} from "./openshell";
import { ProviderError } from "./provider";

/*
 * The gateway API this client speaks is vendored verbatim from the OpenShell release this substrate
 * was probed on (v0.1.6; the run's evidence directory records the digests). Every RPC and field
 * used here was exercised against that release before this file existed, so nothing below is a
 * guess. Requests use the loader's camelCase names (keepCase: false).
 */

const PROTO_DIR = join(import.meta.dirname, "openshell-proto");
const READY_PHASE = "SANDBOX_PHASE_READY";
const ACTIVE_PHASES = new Set([
  "SANDBOX_PHASE_PROVISIONING",
  "SANDBOX_PHASE_STARTING",
  "SANDBOX_PHASE_READY",
]);
const STOPPED_PHASES = new Set([
  "SANDBOX_PHASE_STOPPING",
  "SANDBOX_PHASE_STOPPED",
  "SANDBOX_PHASE_SUSPENDING",
  "SANDBOX_PHASE_SUSPENDED",
  "SANDBOX_PHASE_COMPLETED",
]);
/** The read-only filesystem surface a computer needs, exactly as the live probe proved it. */
const FILESYSTEM = {
  includeWorkdir: true,
  readOnly: [
    "/usr",
    "/lib",
    "/lib64",
    "/etc",
    "/bin",
    "/sbin",
    "/var/log",
    "/proc",
    // Chromium reads /sys for CPU and GPU facts and aborts at start-up without it. The policy is
    // fixed when the sandbox is created, so it has to be here from the first revision.
    "/sys",
    "/dev/urandom",
    // The image's own application directory: the service starts with `cd /app`, and a directory the
    // policy cannot read is a service that cannot start.
    "/app",
    // The Playwright browser tree the image installs, outside /usr on purpose.
    "/ms-playwright",
    // The shared sources the image lays beside /app (../../shared/… imports) and the root-level
    // node_modules symlink the image creates so those sources resolve their dependencies.
    "/shared",
    "/node_modules",
  ],
  readWrite: ["/tmp", "/dev/null"],
};
/**
 * The destination the deny probe dials from inside the sandbox: routable, granted to no sandbox
 * this deployment creates, and named by DNS — the only form the substrate's policy vocabulary can
 * grant, so the probe measures exactly what a policy decision (or a broken enforcement of one)
 * could open. A connection that succeeds means the default deny is not holding for this sandbox,
 * which is the one thing this substrate may never hand out.
 */
const DENY_PROBE = { host: "one.one.one.one", port: 443, timeoutSeconds: 8 };
/**
 * Control-plane material that must not be readable from a workload. The probe reads nothing: it
 * only asks the shell whether each path opens, which is exactly what a real workload would try.
 */
export const CREDENTIAL_PATHS = [
  "/.openshell",
  "/var/run/secrets/kubernetes.io/serviceaccount/token",
  "/run/openshell-supervisor-ca/ca.crt",
];

/**
 * The command that starts the Bot's computer service inside its sandbox.
 *
 * The gateway's exec API has no environment map, so the launch is one shell command and everything
 * the service needs is inline. The token is spliced as adjacent 16-character single-quoted segments:
 * the gateway's log sentinel rewrites longer contiguous strings, and `sh` concatenates neighbours,
 * so the service still reads the whole token. The token is charset-checked first and refused rather
 * than escaped when it could break out of the quotes. Nothing from the control plane (Kubernetes
 * service account, gateway PKI, OpenShell paths) appears here: the workload authenticates callers
 * with the Bot's own token and nothing else.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._~+/=-]+$/;

export function computerServiceStartSpec(input: {
  token: string;
  port?: number;
  workdir?: string;
}): { argv: string[]; healthUrl: string } {
  if (!SHELL_SAFE_TOKEN.test(input.token)) {
    throw new ProviderError(
      "The computer token contains characters that cannot be placed in a shell command; refusing to start the in-sandbox service.",
    );
  }
  const port = input.port ?? 4100;
  const workdir = input.workdir ?? "/app";
  const token = (input.token.match(/.{1,16}/g) ?? [])
    .map((part) => `'${part}'`)
    .join("");
  const launch = [
    `COMPUTER_TOKEN=${token}`,
    `PORT=${port}`,
    "HOME=/tmp",
    "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright",
    "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
    "WORKSPACE_DIR=/tmp/workspace",
    "PROFILES_DIR=/tmp/profiles",
    "COMPUTER_BROWSER_MODE=headless",
    "COMPUTER_ISOLATION_RUNTIME=openshell",
    "nohup bun src/index.ts >/tmp/computer.log 2>&1 &",
  ].join(" ");
  return {
    argv: ["/bin/sh", "-c", `cd ${workdir} && ${launch}`],
    healthUrl: `http://127.0.0.1:${port}/health`,
  };
}

/**
 * A sandbox named by its whole ownership, so one Bot cannot collide with another team's.
 *
 * The gateway caps names at 19 characters (live-verified: a 37-character name was rejected with
 * INVALID_ARGUMENT), so the name is a digest of the scope and the readable attribution lives in the
 * labels. Deterministic, so `ensure` finds what an earlier run created.
 */
function sandboxName(scope: OpenShellScope): string {
  const digest = createHash("sha256")
    .update(
      [scope.tenantId, scope.workspaceId, scope.botId, scope.environment].join(
        "\n",
      ),
    )
    .digest("hex");
  return `ob-${digest.slice(0, 14)}`;
}

/** The short label form of an image reference, so a sandbox's image survives in its labels. */
export function imageLabel(image: string): string {
  return `sha256-${createHash("sha256").update(image).digest("hex").slice(0, 12)}`;
}

/**
 * Whether an existing sandbox may be reused for this scope. A sandbox from another deployment
 * generation, or one still running the previous image, is a computer this deployment never
 * verified: it is replaced, not adopted.
 */
export function needsReplacement(
  labels: Record<string, string> | undefined,
  scope: OpenShellScope,
  image: string,
): boolean {
  return (
    labels?.generation !== scope.generation ||
    labels?.["image-digest"] !== imageLabel(image)
  );
}

type SandboxMetadata = {
  name?: string;
  uid?: string;
  labels?: Record<string, string>;
};
type Sandbox = {
  metadata?: SandboxMetadata;
  status?: { phase?: string };
};
/**
 * The gRPC surface the client dials, in grpc-js 1.14 call shape: unary methods take options as
 * their second argument, `ExecSandbox` answers a server stream the client reads as an async
 * iterable.
 */
export type OpenShellGrpcClient = {
  [method: string]: (
    request: unknown,
    options: { deadline: number },
    callback: (error: grpc.ServiceError | null, response: unknown) => void,
  ) => void;
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: number }).code === grpc.status.NOT_FOUND
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `https://host:port` → the `host:port` authority gRPC dials. */
function grpcTarget(endpoint: string): string {
  const url = new URL(endpoint);
  const port =
    url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return `${url.hostname}:${port}`;
}

/** The mTLS dial the deployment uses: the chart-mounted PKI against the gateway endpoint. */
function dialMtlsGateway(
  options: OpenShellGatewayClientOptions,
): OpenShellGrpcClient {
  let credentials: grpc.ChannelCredentials;
  let definition: loader.PackageDefinition;
  try {
    credentials = grpc.credentials.createSsl(
      readFileSync(options.caPath),
      readFileSync(options.keyPath),
      readFileSync(options.certPath),
    );
    definition = loader.loadSync(join(PROTO_DIR, "openshell.proto"), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [PROTO_DIR],
    });
  } catch (error) {
    throw new ProviderError(
      `The OpenShell gateway credentials or API definition could not be loaded: ${describeError(error)}`,
    );
  }
  const api = grpc.loadPackageDefinition(definition) as unknown as {
    openshell: {
      v1: {
        OpenShell: new (
          endpoint: string,
          credentials: grpc.ChannelCredentials,
        ) => OpenShellGrpcClient;
      };
    };
  };
  return new api.openshell.v1.OpenShell(
    grpcTarget(options.endpoint),
    credentials,
  );
}

/** One command run inside a sandbox, as the acceptance probe runs them. */
export type OpenShellExecResult = {
  stdout: string;
  stderr: string;
  exitCode?: number;
};

/** The policy receipt the gateway answered an update with. */
export type OpenShellPolicyReceipt = {
  status: string;
  activeVersion: number;
};

export type OpenShellGatewayClientOptions = {
  endpoint: string;
  /** The one OpenShell workspace this deployment's sandboxes live in. */
  workspace: string;
  /** The digest-pinned sandbox image; an existing sandbox on another image is replaced. */
  image: string;
  /** The operator-supplied PKI the chart mounted (the verified install path for v0.1.6). */
  caPath: string;
  certPath: string;
  keyPath: string;
  /**
   * The port the computer service listens on inside the sandbox. Absent means this deployment has
   * no in-sandbox service yet, and `locate` has no address to return — which is a refusal, not a
   * guess at a URL.
   */
  servicePort?: number;
  /**
   * The Bot-facing secret the in-sandbox computer service authenticates its caller with. Required
   * once `servicePort` is set: the service refuses to start without it, and a sandbox whose service
   * cannot start is not a computer.
   */
  computerToken?: string;
  /** How long to wait for a sandbox to become ready and its policy to load. */
  settleMs?: number;
  /**
   * The gRPC dial, overridable so the client's own sequencing (delete-then-create, readiness,
   * probe caching) can be tested against a stub instead of a live gateway.
   */
  dial?: () => OpenShellGrpcClient;
};

/**
 * The OpenShell admin client the provider runs on: mTLS to the gateway and the sandbox operations
 * the probe exercised, nothing wider. It holds no Kubernetes credentials of its own.
 *
 * The two methods past `OpenShellAdminClient` — `exec` and `updatePolicy` — are the probe surface
 * the acceptance script drives; the provider itself never calls them.
 */
export type OpenShellGatewayClient = OpenShellAdminClient & {
  /** Run one command inside the sandbox and collect its output and exit code. */
  exec(scope: OpenShellScope, command: string[]): Promise<OpenShellExecResult>;
  /** Apply a policy revision and answer with the receipt the gateway gave. */
  updatePolicy(
    scope: OpenShellScope,
    policy: Record<string, unknown>,
  ): Promise<OpenShellPolicyReceipt>;
  /** Create a workspace; needs the operator certificate, which only the acceptance run holds. */
  createWorkspace(name: string, labels: Record<string, string>): Promise<void>;
  /** Remove a workspace by name; `allowMissing` makes an absent one a no-op answer. */
  deleteWorkspace(name: string): Promise<"gone" | "absent">;
};

export function createOpenShellGatewayClient(
  options: OpenShellGatewayClientOptions,
): OpenShellGatewayClient {
  const settleMs = options.settleMs ?? 120_000;
  const client: OpenShellGrpcClient = options.dial
    ? options.dial()
    : dialMtlsGateway(options);
  const workspaceScope = () => ({ workspace: options.workspace });
  const serviceToken = options.computerToken;
  // A token is what lets the provider start the service; without one, `servicePort` only says a
  // service may be exposed (the acceptance probe starts its own). The deployment assembly refuses
  // the combination before a provider is built, so a real deployment never reaches this state.
  const serviceSpec =
    options.servicePort !== undefined && serviceToken !== undefined
      ? computerServiceStartSpec({ token: serviceToken, port: options.servicePort })
      : undefined;

  /**
   * One bounded unary RPC. grpc-js never times a call out on its own, so every wait this client
   * builds around a call would be unbounded without a deadline of its own: a hung gateway would
   * hold locate, status and stop open forever. The deadline shares the settle budget. grpc-js
   * 1.14 takes options as the second argument — an `undefined` metadata placeholder makes it
   * throw "Incorrect arguments passed" before anything reaches the wire.
   */
  function call<T>(method: string, request: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      client[method](
        request,
        { deadline: Date.now() + settleMs },
        (error, response) => {
          if (error) reject(error);
          else resolve(response as T);
        },
      );
    });
  }

  type ExecEvent = {
    stdout?: { data?: Uint8Array | string };
    stderr?: { data?: Uint8Array | string };
    exit?: { code?: number };
  };

  function textOf(data: Uint8Array | string | undefined): string {
    if (data === undefined) return "";
    // The loader hands bytes over as Buffer; a base64 string is the protobufjs fallback shape.
    return typeof data === "string"
      ? Buffer.from(data, "base64").toString("utf8")
      : Buffer.from(data).toString("utf8");
  }

  async function exec(
    scope: OpenShellScope,
    command: string[],
  ): Promise<OpenShellExecResult> {
    // grpc-js hands a server-streaming call back as its return value, not through a callback; the
    // stream is the async iterable of stdout/stderr/exit events until it ends. Bounded like every
    // unary call: a gateway that stops mid-stream must not hold the probe open.
    const streamer = client as unknown as {
      ExecSandbox: (
        request: unknown,
        options: { deadline: number },
      ) => AsyncIterable<ExecEvent>;
    };
    const stream = streamer.ExecSandbox(
      {
        sandbox: sandboxName(scope),
        command,
        noLoginShell: true,
        workspaceScope: workspaceScope(),
      },
      { deadline: Date.now() + settleMs },
    );
    const result: OpenShellExecResult = { stdout: "", stderr: "" };
    try {
      for await (const event of stream) {
        if (event.stdout) result.stdout += textOf(event.stdout.data);
        if (event.stderr) result.stderr += textOf(event.stderr.data);
        if (event.exit) result.exitCode = event.exit.code;
      }
      return result;
    } catch (streamError) {
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} could not run a command: ${describeError(streamError)}`,
      );
    }
  }

  async function updatePolicy(
    scope: OpenShellScope,
    policy: Record<string, unknown>,
  ): Promise<OpenShellPolicyReceipt> {
    // UpdateConfig only acknowledges the write ({version, policyHash}); the load receipt — the
    // sandbox saying it applied the revision — is a separate read, polled the way the probe did.
    await call("UpdateConfig", {
      sandbox: sandboxName(scope),
      policy,
      workspaceScope: workspaceScope(),
    }).catch((error: unknown) => {
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} policy could not be updated: ${describeError(error)}`,
      );
    });
    const deadline = Date.now() + settleMs;
    for (;;) {
      const status = await readPolicyStatus<{
        activeVersion?: number;
        revision?: { status?: string };
      }>(scope);
      const load = status.revision?.status ?? "";
      const settled =
        load !== "POLICY_STATUS_PENDING" &&
        load !== "POLICY_STATUS_UNSPECIFIED";
      if (settled || Date.now() > deadline) {
        return { status: load, activeVersion: status.activeVersion ?? 0 };
      }
      await sleep(1_000);
    }
  }

  async function rawSandbox(
    scope: OpenShellScope,
  ): Promise<Sandbox | undefined> {
    try {
      const response = await call<{ sandbox?: Sandbox }>("GetSandbox", {
        name: sandboxName(scope),
        workspaceScope: workspaceScope(),
      });
      return response.sandbox;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw new ProviderError(
        `The OpenShell gateway could not be asked for ${JSON.stringify(sandboxName(scope))}: ${describeError(error)}`,
      );
    }
  }

  /** The policy receipt one read of GetSandboxPolicyStatus answers with. */
  type PolicyReading = {
    state: OpenShellSandboxEvidence["policy"];
    activeVersion: number;
  };

  async function readPolicyStatus<
    T extends { activeVersion?: number; revision?: { status?: string } },
  >(scope: OpenShellScope): Promise<T> {
    return call<T>("GetSandboxPolicyStatus", {
      sandbox: sandboxName(scope),
      version: 0,
      workspaceScope: workspaceScope(),
    }).catch((error: unknown) => {
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} policy status could not be read: ${describeError(error)}`,
      );
    });
  }

  async function policyEvidence(scope: OpenShellScope): Promise<PolicyReading> {
    const status = await readPolicyStatus<{
      activeVersion?: number;
      revision?: { status?: string };
    }>(scope);
    const revision = status.revision?.status;
    if (revision === "POLICY_STATUS_LOADED" && (status.activeVersion ?? 0) > 0)
      return { state: "loaded", activeVersion: status.activeVersion ?? 0 };
    if (revision === "POLICY_STATUS_FAILED")
      return { state: "failed", activeVersion: status.activeVersion ?? 0 };
    return { state: "pending", activeVersion: status.activeVersion ?? 0 };
  }

  function viewOf(
    scope: OpenShellScope,
    sandbox: Sandbox | undefined,
  ): OpenShellSandboxView {
    if (sandbox === undefined)
      return { name: sandboxName(scope), state: "missing" };
    const phase = sandbox.status?.phase ?? "SANDBOX_PHASE_UNKNOWN";
    // A phase this client does not know is reported as failed, not ready: an unknown state is not
    // permission to hand the sandbox out.
    const state: OpenShellSandboxView["state"] =
      phase === READY_PHASE
        ? "ready"
        : STOPPED_PHASES.has(phase) || ACTIVE_PHASES.has(phase)
          ? "stopped"
          : "failed";
    return {
      name: sandbox.metadata?.name ?? sandboxName(scope),
      state,
      // The run identity: a replacement sandbox is a new run, and the uid says so.
      generation: sandbox.metadata?.uid,
    };
  }

  async function waitUntilReady(scope: OpenShellScope): Promise<void> {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const sandbox = await rawSandbox(scope);
      if (sandbox?.status?.phase === READY_PHASE) return;
      if (sandbox === undefined) {
        throw new ProviderError(
          `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} disappeared while starting.`,
        );
      }
      const phase = sandbox.status?.phase ?? "";
      if (phase !== "" && !ACTIVE_PHASES.has(phase)) {
        // A sandbox that already came to rest (failed, stopped, suspended, completed) will never
        // become ready; failing fast names the phase instead of polling to the deadline.
        throw new ProviderError(
          `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} came to rest at ${phase} without becoming ready.`,
        );
      }
      if (Date.now() > deadline) {
        throw new ProviderError(
          `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} did not become ready within ${settleMs}ms (phase ${sandbox.status?.phase ?? "unknown"}).`,
        );
      }
      await sleep(2_000);
    }
  }

  /**
   * A gateway that ACCEPTED a deletion has only promised it. The name is free to create on once
   * GetSandbox stops answering for it, and creating before that is refused by the gateway itself.
   */
  async function waitUntilAbsent(scope: OpenShellScope): Promise<void> {
    const deadline = Date.now() + settleMs;
    for (;;) {
      if ((await rawSandbox(scope)) === undefined) return;
      if (Date.now() > deadline) {
        throw new ProviderError(
          `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} was still being deleted when its replacement was due.`,
        );
      }
      await sleep(1_000);
    }
  }

  /**
   * Start the Bot's computer service inside a ready sandbox and wait until it answers its health
   * check. A service already running (a re-ensure, or a resume that kept it) is left alone, so this
   * neither restarts a working browser nor fails on a second launch.
   */
  async function ensureService(
    scope: OpenShellScope,
    spec: { argv: string[]; healthUrl: string },
  ): Promise<void> {
    const healthy = async (): Promise<{ ok: boolean; detail: string }> => {
      /*
       * The gateway's exec stream carries stdout/stderr but no exit status (measured on v0.1.6), so
       * the health check's own output is the verdict: `-w '%{http_code}'` prints 200 only when curl
       * really spoke HTTP to a healthy service.
       */
      const probe = await exec(scope, [
        "/bin/sh",
        "-c",
        `curl -fsS -m 5 -o /dev/null -w '%{http_code}' ${spec.healthUrl}`,
      ]).catch((error: unknown) => ({
        stdout: "",
        stderr: describeError(error),
      }));
      return {
        ok: probe.stdout.trim() === "200",
        detail: `${probe.stderr}${probe.stdout}`.slice(0, 300),
      };
    };
    if ((await healthy()).ok) return;
    const started = await exec(scope, spec.argv);
    const deadline = Date.now() + settleMs;
    let detail = started.stderr;
    for (;;) {
      const health = await healthy();
      if (health.ok) return;
      detail = health.detail || detail;
      if (Date.now() > deadline) {
        throw new ProviderError(
          `The computer service in the OpenShell sandbox ${JSON.stringify(sandboxName(scope))} did not become healthy within ${settleMs}ms: ${detail}`,
        );
      }
      await sleep(2_000);
    }
  }

  async function waitUntilLoaded(
    scope: OpenShellScope,
  ): Promise<PolicyReading> {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const policy = await policyEvidence(scope);
      if (policy.state !== "pending" || Date.now() > deadline) return policy;
      await sleep(2_000);
    }
  }

  async function serviceUrl(
    scope: OpenShellScope,
  ): Promise<string | undefined> {
    if (options.servicePort === undefined) return undefined;
    const exposed = await call<{ url?: string }>("ExposeService", {
      sandbox: sandboxName(scope),
      name: "computer",
      targetPort: options.servicePort,
      workspaceScope: workspaceScope(),
    }).catch((error: unknown) => {
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} could not expose its computer service: ${describeError(error)}`,
      );
    });
    return exposed.url;
  }

  /**
   * The isolation and credential evidence of one running sandbox, measured now.
   *
   * v0.1.6 exposes no isolation-health RPC on the gateway (`GetSandboxProviderStatus` answers about
   * attached providers, `IsolationBackend.Describe` is the supervisor's own protocol), so the only
   * honest status is behavioural: this sandbox must refuse the connection its policy never granted,
   * and it must not be able to read the control plane. Both are measured from inside, with the same
   * shell a workload would have. A probe that cannot produce an answer refuses rather than guesses.
   */
  async function liveProbes(
    scope: OpenShellScope,
  ): Promise<
    Pick<
      OpenShellSandboxEvidence,
      "isolation" | "credentials" | "unauthorizedDestination"
    >
  > {
    /*
     * Both probes answer with markers on stdout rather than exit codes: the gateway's exit event
     * may arrive without a code (live-verified in this run's evidence), so a marker is the only
     * channel the probe can trust. No marker at all is an unmeasured sandbox, which refuses.
     */
    const denial = await exec(scope, [
      "bash",
      "-c",
      `timeout ${DENY_PROBE.timeoutSeconds} bash -c 'exec 3<>/dev/tcp/${DENY_PROBE.host}/${DENY_PROBE.port}' && echo OPENBOT-REACHED || echo OPENBOT-DENIED`,
    ]);
    if (
      !denial.stdout.includes("OPENBOT-REACHED") &&
      !denial.stdout.includes("OPENBOT-DENIED")
    ) {
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} produced no verdict for its network denial probe.`,
      );
    }
    const boundary = await exec(scope, [
      "bash",
      "-c",
      `for path in ${CREDENTIAL_PATHS.join(" ")}; do if test -f "$path" && test -r "$path"; then echo "OPENBOT-EXPOSED:$path"; fi; if test -d "$path" && ls "$path" >/dev/null 2>&1; then echo "OPENBOT-EXPOSED:$path"; fi; done; echo OPENBOT-BOUNDARY-DONE`,
    ]);
    if (!boundary.stdout.includes("OPENBOT-BOUNDARY-DONE")) {
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} produced no verdict for its credential boundary probe.`,
      );
    }
    const reached = denial.stdout.includes("OPENBOT-REACHED");
    return {
      // One measurement, two names: the boundary that let a connection through is the same
      // boundary that stopped enforcing the default deny.
      isolation: reached ? "broken" : "enforced",
      credentials: boundary.stdout.includes("OPENBOT-EXPOSED")
        ? "exposed"
        : "hidden",
      unauthorizedDestination: reached ? "reachable" : "denied",
    };
  }

  async function deleteByName(
    scope: OpenShellScope,
  ): Promise<"cleared" | "absent"> {
    const outcome = await call<{ outcome?: string }>("DeleteSandbox", {
      name: sandboxName(scope),
      workspaceScope: workspaceScope(),
    }).catch((error: unknown) => {
      if (isNotFound(error))
        return { outcome: "DELETION_OUTCOME_ALREADY_ABSENT" };
      throw new ProviderError(
        `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} could not be deleted: ${describeError(error)}`,
      );
    });
    if (outcome.outcome === "DELETION_OUTCOME_ALREADY_ABSENT") return "absent";
    // The live gateway answers COMPLETED for a finished deletion and ACCEPTED for one it started;
    // either way the name is on its way out. Anything else is treated as not cleared.
    return outcome.outcome === "DELETION_OUTCOME_COMPLETED" ||
      outcome.outcome === "DELETION_OUTCOME_ACCEPTED"
      ? "cleared"
      : "absent";
  }

  /**
   * Probe evidence as it holds for one sandbox under one policy revision. The same uid under the
   * same activeVersion answers the same policy, so re-measuring it would put the deny probe's
   * worst-case timeout on every read of a running sandbox; a new revision or a replacement sandbox
   * (a new uid) re-measures. Unproven states never enter here — those are refused before this.
   */
  let measured:
    | {
        key: string;
        evidence: Pick<
          OpenShellSandboxEvidence,
          "isolation" | "credentials" | "unauthorizedDestination"
        >;
      }
    | undefined;
  async function evidenceOf(
    scope: OpenShellScope,
    uid: string | undefined,
    policy: PolicyReading,
  ): Promise<OpenShellSandboxEvidence> {
    const key = `${uid ?? ""}:${policy.activeVersion}`;
    if (measured?.key !== key) {
      measured = { key, evidence: await liveProbes(scope) };
    }
    return { policy: policy.state, ...measured.evidence };
  }

  return {
    hasServiceAddress() {
      return options.servicePort !== undefined;
    },

    async ensureSandbox(scope) {
      let existing = await rawSandbox(scope);
      if (
        existing !== undefined &&
        needsReplacement(existing.metadata?.labels, scope, options.image)
      ) {
        // A sandbox this deployment did not build at this generation, on this image, is not one it
        // proved; it goes away before a replacement is created in its place. A deletion the
        // gateway only accepted must finish before the name is offered to CreateSandbox again.
        if ((await deleteByName(scope)) === "cleared") {
          await waitUntilAbsent(scope);
        }
        existing = undefined;
      }
      if (existing === undefined) {
        await call("CreateSandbox", {
          name: sandboxName(scope),
          workspaceScope: workspaceScope(),
          labels: {
            "managed-by": "openbot",
            tenant: scope.tenantId,
            workspace: scope.workspaceId,
            bot: scope.botId,
            environment: scope.environment,
            generation: scope.generation,
            "image-digest": imageLabel(options.image),
          },
          spec: {
            template: { image: options.image },
            policy: {
              version: 1,
              filesystem: FILESYSTEM,
              // No network grants: the sandbox starts default-deny and only a later, explicit
              // policy decision may open anything.
              networkPolicies: {},
            },
            command: ["sleep", "infinity"],
          },
        }).catch((error: unknown) => {
          throw new ProviderError(
            `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} could not be created: ${describeError(error)}`,
          );
        });
      } else if (existing.status?.phase !== READY_PHASE) {
        await call("StartSandbox", {
          name: sandboxName(scope),
          workspaceScope: workspaceScope(),
        }).catch((error: unknown) => {
          throw new ProviderError(
            `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} could not be started: ${describeError(error)}`,
          );
        });
      }
      await waitUntilReady(scope);
      const policy = await waitUntilLoaded(scope);
      // The sandbox command is `sleep infinity`; the computer service is started inside it once the
      // policy that permits it has loaded, and only handed out after it answers.
      if (serviceSpec !== undefined) await ensureService(scope, serviceSpec);
      const settled = await rawSandbox(scope);
      return {
        ...viewOf(scope, settled),
        url: await serviceUrl(scope),
        evidence: await evidenceOf(scope, settled?.metadata?.uid, policy),
      };
    },

    async inspectSandbox(scope) {
      const sandbox = await rawSandbox(scope);
      if (sandbox === undefined) return viewOf(scope, undefined);
      const view = viewOf(scope, sandbox);
      // Probes run inside a running sandbox only: a stopped or missing one has nothing to measure,
      // and the missing evidence says so.
      if (view.state !== "ready") return view;
      return {
        ...view,
        evidence: await evidenceOf(
          scope,
          sandbox.metadata?.uid,
          await policyEvidence(scope),
        ),
      };
    },

    async stopSandbox(scope) {
      const sandbox = await rawSandbox(scope);
      if (sandbox === undefined) return { wasRunning: false };
      const wasRunning = ACTIVE_PHASES.has(sandbox.status?.phase ?? "");
      await call("StopSandbox", {
        name: sandboxName(scope),
        workspaceScope: workspaceScope(),
      }).catch((error: unknown) => {
        if (isNotFound(error)) return;
        throw new ProviderError(
          `The OpenShell sandbox ${JSON.stringify(sandboxName(scope))} could not be stopped: ${describeError(error)}`,
        );
      });
      return { wasRunning };
    },

    async resetSandbox(scope) {
      return { cleared: (await deleteByName(scope)) === "cleared" };
    },

    async listSandboxes() {
      const listed = await call<{ sandboxes?: Sandbox[] }>("ListSandboxes", {
        labelSelector: "managed-by=openbot",
        workspaceScope: workspaceScope(),
      }).catch((error: unknown) => {
        throw new ProviderError(
          `The OpenShell gateway could not list sandboxes in ${JSON.stringify(options.workspace)}: ${describeError(error)}`,
        );
      });
      const owned: { scope: OpenShellScope; view: OpenShellSandboxView }[] = [];
      for (const sandbox of listed.sandboxes ?? []) {
        const labels = sandbox.metadata?.labels;
        // Only what this deployment attributed, and only whole attributions: a sandbox missing any
        // ownership label belongs to no Bot this deployment could act on.
        if (labels?.["managed-by"] !== "openbot") continue;
        if (
          !labels.tenant ||
          !labels.workspace ||
          !labels.bot ||
          !labels.generation ||
          !labels.environment
        ) {
          continue;
        }
        const scope: OpenShellScope = {
          tenantId: labels.tenant,
          workspaceId: labels.workspace,
          botId: labels.bot,
          environment: labels.environment === "coding" ? "coding" : "computer",
          generation: labels.generation,
        };
        owned.push({ scope, view: viewOf(scope, sandbox) });
      }
      return owned;
    },

    exec,
    updatePolicy,

    async createWorkspace(name, labels) {
      await call("CreateWorkspace", { name, labels }).catch(
        (error: unknown) => {
          throw new ProviderError(
            `The OpenShell workspace ${JSON.stringify(name)} could not be created: ${describeError(error)}`,
          );
        },
      );
    },

    async deleteWorkspace(name) {
      const outcome = await call<{ outcome?: string }>("DeleteWorkspace", {
        name,
        allowMissing: true,
      }).catch((error: unknown) => {
        throw new ProviderError(
          `The OpenShell workspace ${JSON.stringify(name)} could not be deleted: ${describeError(error)}`,
        );
      });
      return outcome.outcome === "DELETION_OUTCOME_ALREADY_ABSENT"
        ? "absent"
        : "gone";
    },
  };
}

/** The environment a deployment's OpenShell mode is assembled from (the chart sets these). */
export const OPEN_SHELL_ENV = {
  receipt: "OPENSHELL_PROBE_RECEIPT",
  image: "OPENSHELL_SANDBOX_IMAGE",
  servicePort: "OPENSHELL_SANDBOX_SERVICE_PORT",
  ca: "OPENSHELL_CA_CERT",
  cert: "OPENSHELL_CLIENT_CERT",
  key: "OPENSHELL_CLIENT_KEY",
  generation: "OPENBOT_DEPLOYMENT_GENERATION",
} as const;

/** An image is acceptable only pinned: a moving tag is a computer nobody verified. */
const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

/**
 * The receipt a recorded probe run wrote, read back at assembly.
 *
 * The receipt names the gateway and image it measured and the capabilities it actually proved; a
 * list of capability names in values is not proof of anything, which is why nothing else is read
 * here. Unknown capability names are refused: a receipt from a different probe is not this probe.
 */
export function parseProbeReceipt(
  raw: string | undefined,
  expected: { gatewayEndpoint: string; sandboxImage: string },
): string[] {
  let receipt: {
    gatewayEndpoint?: unknown;
    sandboxImage?: unknown;
    capabilities?: unknown;
  };
  try {
    receipt = JSON.parse(raw ?? "");
  } catch {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} must hold the JSON receipt the acceptance probe wrote for this substrate.`,
    );
  }
  if (receipt.gatewayEndpoint !== expected.gatewayEndpoint) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} names the gateway ${JSON.stringify(String(receipt.gatewayEndpoint))}, not this deployment's ${JSON.stringify(expected.gatewayEndpoint)}.`,
    );
  }
  if (receipt.sandboxImage !== expected.sandboxImage) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} was written for the sandbox image ${JSON.stringify(String(receipt.sandboxImage))}, not this deployment's.`,
    );
  }
  if (
    !Array.isArray(receipt.capabilities) ||
    !receipt.capabilities.every((name) => typeof name === "string")
  ) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} must list the capabilities the probe proved, as strings.`,
    );
  }
  const unknown = receipt.capabilities.filter(
    (name) => !OPEN_SHELL_REQUIRED_CAPABILITIES.includes(name as never),
  );
  if (unknown.length > 0) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} names capabilities no OpenShell probe reports (${unknown.join(", ")}).`,
    );
  }
  return receipt.capabilities as string[];
}

/** The receipt's capabilities for the fleet's substrate line; an unusable receipt proves nothing. */
export function probeReceiptCapabilities(
  raw: string | undefined,
  expected: { gatewayEndpoint: string; sandboxImage: string },
): string[] {
  try {
    return parseProbeReceipt(raw, expected);
  } catch {
    return [];
  }
}

export function missingCapabilities(capabilities: readonly string[]): string[] {
  return OPEN_SHELL_REQUIRED_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );
}

/** Everything a deployment's OpenShell mode needs from its environment, validated in one place. */
export function openShellDeploymentInputs(
  config: OpenShellComputerConfig,
  read: (name: string) => string | undefined,
): {
  capabilities: string[];
  image: string;
  generation: string;
  paths: { caPath: string; certPath: string; keyPath: string };
  servicePort?: number;
} {
  const image = read(OPEN_SHELL_ENV.image)?.trim();
  if (!image || !PINNED_IMAGE.test(image)) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.image} must name the digest-pinned sandbox image the acceptance probe verified; refusing to run a computer on an unpinned image.`,
    );
  }
  const capabilities = parseProbeReceipt(read(OPEN_SHELL_ENV.receipt), {
    gatewayEndpoint: config.gatewayEndpoint,
    sandboxImage: image,
  });
  const missing = missingCapabilities(capabilities);
  if (missing.length > 0) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.receipt} must record every capability the live probe proved for this substrate; missing ${missing.join(", ")}.`,
    );
  }
  const generation = read(OPEN_SHELL_ENV.generation)?.trim();
  if (!generation) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.generation} must name this deployment's generation, so a sandbox can be attributed to the run that created it.`,
    );
  }
  const paths = {
    caPath: read(OPEN_SHELL_ENV.ca)?.trim(),
    certPath: read(OPEN_SHELL_ENV.cert)?.trim(),
    keyPath: read(OPEN_SHELL_ENV.key)?.trim(),
  };
  const missingPaths = Object.entries(paths)
    .filter(([, value]) => !value)
    .map(
      ([name]) =>
        OPEN_SHELL_ENV[
          name === "caPath" ? "ca" : name === "certPath" ? "cert" : "key"
        ],
    );
  if (missingPaths.length > 0) {
    throw new ProviderError(
      `The OpenShell client certificates are not mounted: set ${missingPaths.join(", ")}.`,
    );
  }
  const port = read(OPEN_SHELL_ENV.servicePort)?.trim();
  const parsedPort =
    port === undefined || port === "" ? undefined : Number.parseInt(port, 10);
  if (
    parsedPort !== undefined &&
    (!/^\d+$/.test(port ?? "") ||
      !Number.isInteger(parsedPort) ||
      parsedPort <= 0 ||
      parsedPort > 65535)
  ) {
    throw new ProviderError(
      `${OPEN_SHELL_ENV.servicePort} must be a TCP port number, got ${JSON.stringify(port)}.`,
    );
  }
  return {
    capabilities,
    image,
    generation,
    paths: paths as { caPath: string; certPath: string; keyPath: string },
    ...(parsedPort !== undefined ? { servicePort: parsedPort } : {}),
  };
}
