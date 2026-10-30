#!/usr/bin/env bun
/*
 * The OpenShell foundation acceptance run (T01, plan Task 2 Step 3).
 *
 * It proves, on a real cluster, through the real provider and gateway client — not through
 * configuration text or mocked policy setters — that a restricted probe sandbox can be created,
 * accessed and stopped inside one team's workspace, and that every boundary the substrate claims
 * actually holds: cross-workspace denial, default-deny egress, the policy receipt being true
 * (allowed destination reachable, unlisted destination still denied), no control-plane credentials
 * inside the workload, a provider that refuses to place a computer on a substrate whose
 * capabilities were not proven, no sandbox created when the deployment has no service address,
 * a sandbox from another generation being replaced rather than adopted, and a sandbox whose
 * default deny was taken away being detected live and stopped rather than handed out.
 *
 * The run ends by writing the probe receipt a deployment mounts: the gateway, image and
 * capabilities this run actually proved. Values text cannot stand in for that receipt.
 *
 * Refuses to run against the wrong cluster: the kubectl context must equal OPENSHELL_ACCEPT_CONTEXT.
 * Cleans up only what it created — the two workspaces it named — and verifies they are gone.
 *
 * Usage (all paths absolute):
 *   OPENSHELL_ACCEPT_CONTEXT=openshell-t01-2133adeb \
 *   OPENSHELL_ACCEPT_CA=… OPENSHELL_ACCEPT_CERT=… OPENSHELL_ACCEPT_KEY=… \
 *   OPENSHELL_ACCEPT_OPERATOR_CERT=… OPENSHELL_ACCEPT_OPERATOR_KEY=… \
 *   OPENSHELL_ACCEPT_IMAGE=nvcr.io/nvidia/base/ubuntu@sha256:… \
 *   bun scripts/openshell-foundation-acceptance.ts --report <path.json>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as requestHttps } from "node:https";
import { dirname } from "node:path";
import {
  createOpenShellComputerProvider,
  OPEN_SHELL_REQUIRED_CAPABILITIES,
  type OpenShellScope,
  openShellProviderOptions,
} from "../server/src/computer/openshell";
import {
  createOpenShellGatewayClient,
  type OpenShellGatewayClient,
  parseProbeReceipt,
} from "../server/src/computer/openshell-client";
import type { ComputerConfig } from "../server/src/config";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required.`);
    process.exit(2);
  }
  return value;
}

const env = {
  context: requireEnv("OPENSHELL_ACCEPT_CONTEXT"),
  endpoint: process.env.OPENSHELL_ACCEPT_ENDPOINT ?? "https://localhost:17670",
  ca: requireEnv("OPENSHELL_ACCEPT_CA"),
  cert: requireEnv("OPENSHELL_ACCEPT_CERT"),
  key: requireEnv("OPENSHELL_ACCEPT_KEY"),
  operatorCert: requireEnv("OPENSHELL_ACCEPT_OPERATOR_CERT"),
  operatorKey: requireEnv("OPENSHELL_ACCEPT_OPERATOR_KEY"),
  /** Digest-pinned: the product refuses an unpinned image, and so does this run. */
  image: requireEnv("OPENSHELL_ACCEPT_IMAGE"),
  exposureImage:
    process.env.OPENSHELL_ACCEPT_EXPOSURE_IMAGE ??
    "docker.io/library/python:3.12-slim",
  port: Number.parseInt(process.env.OPENSHELL_ACCEPT_PORT ?? "8765", 10),
  report: process.env.OPENSHELL_ACCEPT_REPORT,
};
if (!/@sha256:[0-9a-f]{64}$/.test(env.image)) {
  console.error(
    `OPENSHELL_ACCEPT_IMAGE must be digest-pinned (…@sha256:<64 hex>), got ${env.image}.`,
  );
  process.exit(2);
}

/** Run one command and answer its trimmed stdout plus exit code; the probe's kubectl channel. */
function kubectl(...args: string[]): { stdout: string; status: number } {
  const run = spawnSync("kubectl", args, { encoding: "utf8" });
  return { stdout: run.stdout.trim(), status: run.status ?? -1 };
}

const suffix = Date.now().toString(36);
const workspaceA = `t01acc-a-${suffix}`.slice(0, 19);
const workspaceB = `t01acc-b-${suffix}`.slice(0, 19);
const outcomes: {
  id: string;
  claim: string;
  pass: boolean;
  evidence: string;
}[] = [];

function record(id: string, claim: string, pass: boolean, evidence: unknown) {
  outcomes.push({
    id,
    claim,
    pass,
    evidence:
      typeof evidence === "string" ? evidence : JSON.stringify(evidence),
  });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} — ${claim}`);
  if (!pass) console.log(`      ${JSON.stringify(evidence).slice(0, 600)}`);
}

function clientFor(workspace: string): OpenShellGatewayClient {
  return createOpenShellGatewayClient({
    endpoint: env.endpoint,
    workspace,
    image: env.image,
    caPath: env.ca,
    certPath: env.cert,
    keyPath: env.key,
    servicePort: env.port,
    settleMs: 180_000,
  });
}

const operator = createOpenShellGatewayClient({
  endpoint: env.endpoint,
  workspace: "default",
  image: env.image,
  caPath: env.ca,
  certPath: env.operatorCert,
  keyPath: env.operatorKey,
  settleMs: 60_000,
});

const config: Extract<ComputerConfig, { provider: "openshell" }> = {
  provider: "openshell",
  gatewayEndpoint: env.endpoint,
  executionScope: { tenantId: "t01-acceptance", workspaceId: workspaceA },
  allowPrivateHosts: false,
};

/** The generation sandboxes are attributed to this run; the replacement case advances it. */
let generation = `acceptance-${suffix}`;
process.env.OPENSHELL_SANDBOX_IMAGE = env.image;
process.env.OPENBOT_DEPLOYMENT_GENERATION = generation;
process.env.OPENSHELL_SANDBOX_SERVICE_PORT = String(env.port);
process.env.OPENSHELL_CA_CERT = env.ca;
process.env.OPENSHELL_CLIENT_CERT = env.cert;
process.env.OPENSHELL_CLIENT_KEY = env.key;

/**
 * The bootstrap receipt for this run: the four capabilities the cases below go on to prove live.
 * The run ends by re-stating exactly this receipt from what it measured, so a deployment mounts
 * what was actually demonstrated, on this gateway and this image.
 */
function receiptJson(capabilities: readonly string[]): string {
  return JSON.stringify({
    gatewayEndpoint: config.gatewayEndpoint,
    sandboxImage: env.image,
    capabilities: [...capabilities],
  });
}
process.env.OPENSHELL_PROBE_RECEIPT = receiptJson(
  OPEN_SHELL_REQUIRED_CAPABILITIES,
);

/** Rebuild the provider options from the deployment environment exactly as the server would. */
const optionsFromEnv = () => openShellProviderOptions(config);

const scopeOf = (workspaceId: string, botId: string): OpenShellScope => ({
  tenantId: "t01-acceptance",
  workspaceId,
  botId,
  environment: "computer",
  generation,
});

/** One exec probe: bash connecting to host:port, `REACHED` only if the connect succeeded. */
const reach = (host: string, port: number) => [
  "/bin/bash",
  "-c",
  `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port} && echo REACHED' 2>&1; echo "exit=$?"`,
];

/** The local port this run's gateway port-forward listens on. */
const FORWARD_PORT = Number.parseInt(
  process.env.OPENSHELL_ACCEPT_FORWARD_PORT ?? "17670",
  10,
);

/** GET an https URL the gateway issued, through the port-forward, verifying it with the run's CA. */
function httpsThroughForward(rawUrl: string, caPath: string): Promise<string> {
  const url = new URL(rawUrl);
  return new Promise((resolve) => {
    const request = requestHttps(
      {
        host: "127.0.0.1",
        port: FORWARD_PORT,
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        headers: { host: url.host },
        ca: readFileSync(caPath),
      },
      (response) => resolve(`HTTP-${response.statusCode}`),
    );
    // A port-forward that accepts the connection but never answers must not hang the run.
    request.setTimeout(15_000, () => request.destroy(new Error("timed out")));
    request.on("error", (error: Error) =>
      resolve(`fetch-failed:${String(error.message).slice(0, 80)}`),
    );
    request.end();
  });
}

async function main() {
  const startedAt = new Date().toISOString();

  // Preflight: the cluster must be the one this run was authorized for, and this run's names free.
  const context = kubectl("config", "current-context");
  if (context.status !== 0 || context.stdout !== env.context) {
    throw new Error(
      `Refusing to run: kubectl context is ${JSON.stringify(context.stdout)}, expected ${JSON.stringify(env.context)}.`,
    );
  }
  const existing = kubectl("get", "sandboxes", "-A", "--no-headers");
  if (
    existing.stdout.includes(workspaceA) ||
    existing.stdout.includes(workspaceB)
  ) {
    throw new Error(
      `Refusing to run: sandboxes named for this run's workspaces already exist (${workspaceA} / ${workspaceB}).`,
    );
  }
  const serverVersion = (() => {
    try {
      return (
        JSON.parse(kubectl("version", "-o", "json").stdout || "{}") as {
          serverVersion?: string;
        }
      ).serverVersion;
    } catch {
      return undefined;
    }
  })();

  await operator.createWorkspace(workspaceA, {
    "managed-by": "t01-acceptance",
  });
  await operator.createWorkspace(workspaceB, {
    "managed-by": "t01-acceptance",
  });
  const clientA = clientFor(workspaceA);
  const clientB = clientFor(workspaceB);

  // The provider under test is the product path: options read from the deployment environment.
  let options = await optionsFromEnv();
  let provider = createOpenShellComputerProvider(options);

  // 0 — no address, no sandbox: a deployment without a service port may not create one, and the
  // refusal must come before anything exists to clean up afterwards.
  const noAddressBot = `noaddr-${suffix}`;
  const noAddress = await (async () => {
    const savedPort = process.env.OPENSHELL_SANDBOX_SERVICE_PORT;
    delete process.env.OPENSHELL_SANDBOX_SERVICE_PORT;
    try {
      const bare = createOpenShellComputerProvider(await optionsFromEnv());
      return await bare.locate(noAddressBot).then(
        () => "placed",
        (error: unknown) => String(error),
      );
    } finally {
      if (savedPort) process.env.OPENSHELL_SANDBOX_SERVICE_PORT = savedPort;
    }
  })();
  const noAddressCreated = (await clientA.listSandboxes()).find(
    ({ scope }) => scope.botId === noAddressBot,
  );
  record(
    "no-address-refuses-before-creating",
    "without a service port the provider refuses and leaves no sandbox behind",
    noAddress.includes("no address") && noAddressCreated === undefined,
    { refusal: noAddress.slice(0, 240), noAddressCreated },
  );

  // 1 — create: the probe sandbox comes up ready inside team A's workspace, attributed to it,
  // with its policy receipt and its live isolation and credential probes all holding.
  const bot = `bot-${suffix}`;
  const url = await provider.locate(bot);
  const inspected = await clientA.inspectSandbox(scopeOf(workspaceA, bot));
  const listed = await clientA.listSandboxes();
  const attributed = listed.find(
    ({ scope }) => scope.botId === bot && scope.workspaceId === workspaceA,
  );
  record(
    "create-probe-sandbox",
    "locate answers a URL and the sandbox is ready, attributed, with every live receipt holding",
    url.length > 0 &&
      inspected.state === "ready" &&
      inspected.evidence?.policy === "loaded" &&
      inspected.evidence.isolation === "enforced" &&
      inspected.evidence.credentials === "hidden" &&
      inspected.evidence.unauthorizedDestination === "denied" &&
      attributed !== undefined,
    { url, inspected, attributed },
  );

  // 2 — access: a command really runs inside it, as the non-root workload user.
  const access = await clientA.exec(scopeOf(workspaceA, bot), [
    "/bin/bash",
    "-c",
    "echo T01-ACCESS-$(id -u)",
  ]);
  record(
    "access-probe-sandbox",
    "exec reaches the sandbox and the workload is not root",
    /T01-ACCESS-\d+/.test(access.stdout) &&
      !access.stdout.includes("T01-ACCESS-0\n"),
    access,
  );

  // 3 — the receipt is true: a receipt alone changes nothing on the wire. First an endpoint without
  // the binary identity: the receipt loads and the connection is still denied. Then with the
  // identity the substrate actually matches (canonical real path): reached. An unlisted host stays
  // denied throughout — a loaded receipt never becomes a blanket allow.
  const filesystem = {
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
      "/dev/urandom",
    ],
    readWrite: ["/tmp", "/dev/null"],
  };
  const allowedHost = "openshell.openshell.svc.cluster.local";
  const receiptBefore = await clientA.updatePolicy(scopeOf(workspaceA, bot), {
    version: 1,
    filesystem,
    networkPolicies: {
      "allow-gateway-api": {
        name: "allow-gateway-api",
        endpoints: [{ host: allowedHost, port: 8080, protocol: "tcp" }],
      },
    },
  });
  const deniedWithReceipt = await clientA.exec(
    scopeOf(workspaceA, bot),
    reach(allowedHost, 8080),
  );
  const receipt = await clientA.updatePolicy(scopeOf(workspaceA, bot), {
    version: 1,
    filesystem,
    networkPolicies: {
      "allow-gateway-api": {
        name: "allow-gateway-api",
        endpoints: [{ host: allowedHost, port: 8080, protocol: "tcp" }],
        binaries: [{ path: "/usr/bin/bash" }],
      },
    },
  });
  const allowed = await clientA.exec(
    scopeOf(workspaceA, bot),
    reach(allowedHost, 8080),
  );
  const denied = await clientA.exec(
    scopeOf(workspaceA, bot),
    reach("1.1.1.1", 443),
  );
  record(
    "policy-receipt-is-true",
    "a loaded receipt matches behaviour: without the binary identity it does not open the host, with it the one host is reached, and unlisted hosts stay denied",
    receiptBefore.status === "POLICY_STATUS_LOADED" &&
      !deniedWithReceipt.stdout.includes("REACHED") &&
      receipt.status === "POLICY_STATUS_LOADED" &&
      receipt.activeVersion > 0 &&
      allowed.stdout.includes("REACHED") &&
      !denied.stdout.includes("REACHED"),
    { receiptBefore, deniedWithReceipt, receipt, allowed, denied },
  );

  // 4 — cross-workspace: team B's sandbox is invisible to team A's API, and a listener really
  // running inside it is not reachable from team A's sandbox. With the listener up, a DENIED
  // verdict can only come from the network boundary, not from nothing listening. Granting team A
  // the pod address outright would separate the workspace boundary from A's own default deny; the
  // live gateway refuses IP-literal policy endpoints, so that attempt is made and its refusal is
  // recorded as the API's own answer — if a gateway ever accepts it, the probe below measures the
  // boundary with the grant in force.
  const otherBot = `other-${suffix}`;
  const scopeB = scopeOf(workspaceB, otherBot);
  await clientB.ensureSandbox(scopeB);
  const viewB = await clientB.inspectSandbox(scopeB);
  // `missing` is the gateway's NotFound as this client reports it: no metadata of B's sandbox
  // reaches a caller scoped to workspace A.
  const crossApi = await clientA.inspectSandbox(scopeB);
  const podIp = kubectl(
    "-n",
    "openshell",
    "get",
    "pod",
    `${workspaceB}--${viewB.name}`,
    "-o",
    "jsonpath={.status.podIP}",
  );
  type ExecResult = Awaited<ReturnType<typeof clientA.exec>>;
  let listener: ExecResult | undefined;
  let lateral: ExecResult | undefined;
  let grantAttempt: string | undefined;
  if (podIp.stdout) {
    listener = await clientB.exec(scopeB, [
      "/bin/sh",
      "-c",
      `nohup python3 -m http.server 5500 >/tmp/http.log 2>&1 & sleep 1; echo LISTENER-UP`,
    ]);
    grantAttempt = await clientA
      .updatePolicy(scopeOf(workspaceA, bot), {
        version: 1,
        filesystem,
        networkPolicies: {
          "probe-lateral": {
            name: "probe-lateral",
            endpoints: [{ host: podIp.stdout, port: 5500, protocol: "tcp" }],
            binaries: [{ path: "/usr/bin/bash" }],
          },
        },
      })
      .then(
        (receipt) => `granted: ${JSON.stringify(receipt)}`,
        (error: unknown) => String(error),
      );
    lateral = await clientA.exec(
      scopeOf(workspaceA, bot),
      reach(podIp.stdout, 5500),
    );
  }
  record(
    "cross-workspace-denied",
    "another team's sandbox is not visible through team A's client, its listener is up, and the wire to it stays denied",
    crossApi.state === "missing" &&
      podIp.stdout.length > 0 &&
      listener?.stdout.includes("LISTENER-UP") === true &&
      !lateral?.stdout.includes("REACHED"),
    { crossApi, podIp: podIp.stdout, listener, grantAttempt, lateral },
  );

  // 5 — credential boundary: the workload cannot read control-plane or gateway credentials, and
  // the boundary says so in the words the shell reports, not just by absence of token material.
  const credentials = await clientA.exec(scopeOf(workspaceA, bot), [
    "/bin/bash",
    "-c",
    "ls /.openshell 2>&1 | head -1; cat /var/run/secrets/kubernetes.io/serviceaccount/token 2>&1 | head -c 80; echo; cat /run/openshell-supervisor-ca/ca.crt 2>&1 | head -1; env | grep -iE 'openshell|kubernetes|kube|token|cert' | head -5; echo ENV-DONE",
  ]);
  const boundaryHolds =
    !credentials.stdout.includes("eyJ") &&
    !credentials.stdout.includes("BEGIN CERTIFICATE") &&
    credentials.stdout.includes("Permission denied") &&
    credentials.stdout.includes("No such file") &&
    credentials.stdout.includes("ENV-DONE");
  record(
    "credential-boundary-holds",
    "no service-account token, no certificate material, no gateway credentials in the workload, and the control-plane directory refuses the workload",
    boundaryHolds,
    {
      ...credentials,
      // The verdict is decided on the raw output above; the artifact only ever sees it redacted,
      // so a boundary that failed cannot leak the very material it failed to hide.
      stdout: credentials.stdout
        .replace(/[A-Za-z0-9_-]{20,}/g, "<redacted>")
        .slice(0, 400),
      stderr: credentials.stderr.slice(0, 200),
    },
  );

  // 5.5 — generation replacement: a sandbox attributed to an earlier deployment generation is not
  // adopted by the next one; it is replaced, and the replacement carries the new generation.
  // The name is the scope digest; the client computes it, so read it from the attribution itself.
  const before = (await clientA.listSandboxes()).find(
    ({ scope }) => scope.botId === bot,
  );
  const oldUid = before
    ? kubectl(
        "-n",
        "openshell",
        "get",
        "sandbox",
        `${workspaceA}--${before.view.name}`,
        "-o",
        "jsonpath={.metadata.uid}",
      ).stdout
    : "";
  generation = `acceptance-${suffix}-g2`;
  process.env.OPENBOT_DEPLOYMENT_GENERATION = generation;
  options = await optionsFromEnv();
  provider = createOpenShellComputerProvider(options);
  const replacedUrl = await provider.locate(bot);
  const after = (await clientA.listSandboxes()).find(
    ({ scope }) => scope.botId === bot,
  );
  const newUid = after
    ? kubectl(
        "-n",
        "openshell",
        "get",
        "sandbox",
        `${workspaceA}--${after.view.name}`,
        "-o",
        "jsonpath={.metadata.uid}",
      ).stdout
    : "";
  record(
    "generation-replaces-not-adopts",
    "a new deployment generation replaces the old sandbox instead of reusing it, and the new one carries the new generation label",
    oldUid.length > 0 &&
      newUid.length > 0 &&
      newUid !== oldUid &&
      after?.scope.generation === generation &&
      replacedUrl.length > 0,
    {
      oldUid,
      newUid,
      attributedGeneration: after?.scope.generation,
      replacedUrl,
    },
  );

  // 5.6 — a deny that stopped working is detected live: this sandbox's policy grants the one
  // destination the probe dials, which is exactly what a failed default deny looks like from
  // inside. The provider must refuse to hand the sandbox out and stop it.
  const denyBreakBot = `denybreak-${suffix}`;
  const denyBreakScope = scopeOf(workspaceA, denyBreakBot);
  await clientA.ensureSandbox(denyBreakScope);
  const opened = await clientA.updatePolicy(denyBreakScope, {
    version: 1,
    filesystem,
    networkPolicies: {
      "allow-everything-probe": {
        name: "allow-everything-probe",
        endpoints: [{ host: "one.one.one.one", port: 443, protocol: "tcp" }],
        binaries: [{ path: "/usr/bin/bash" }],
      },
    },
  });
  const detected = await provider.locate(denyBreakBot).then(
    () => "placed",
    (error: unknown) => String(error),
  );
  const detectedState = await clientA.inspectSandbox(denyBreakScope);
  record(
    "broken-deny-detected-and-stopped",
    "a sandbox whose policy grants the probe destination is refused live and stopped, not handed out",
    opened.status === "POLICY_STATUS_LOADED" &&
      detected.includes("may not be used") &&
      /reachable|isolation/.test(detected) &&
      detectedState.state !== "ready",
    { opened, refusal: detected.slice(0, 240), detectedState },
  );

  // 6 — fail closed on an unproven substrate: a missing capability is a refusal, not a warning.
  const unproven = await (async () => {
    try {
      const stripped = createOpenShellComputerProvider({
        ...options,
        capabilities: OPEN_SHELL_REQUIRED_CAPABILITIES.filter(
          (capability) => capability !== "default-deny-network",
        ),
      });
      return await stripped.locate(bot).then(() => "placed");
    } catch (error) {
      return String(error);
    }
  })();
  record(
    "unproven-substrate-refused",
    "the provider refuses to exist when default-deny-network was not proven",
    unproven.includes("default-deny-network"),
    unproven,
  );

  // 6.5 — the receipt is earned, not written: exactly the capabilities this run demonstrated go
  // into it, it round-trips through the same parser the server boots with, and a receipt with one
  // capability struck out is refused for placement.
  const passed = (id: string) =>
    outcomes.find((outcome) => outcome.id === id)?.pass === true;
  const proven = [
    passed("policy-receipt-is-true") ? "default-deny-network" : null,
    passed("create-probe-sandbox") ? "policy-load-receipt" : null,
    passed("cross-workspace-denied") ? "cross-workspace-denial" : null,
    passed("credential-boundary-holds") ? "credential-boundary" : null,
  ].filter((name): name is string => name !== null);
  const finalReceipt = receiptJson(proven);
  const roundTrip = parseProbeReceipt(finalReceipt, {
    gatewayEndpoint: config.gatewayEndpoint,
    sandboxImage: env.image,
  });
  const tampered = await (async () => {
    const saved = process.env.OPENSHELL_PROBE_RECEIPT;
    process.env.OPENSHELL_PROBE_RECEIPT = receiptJson(
      proven.filter((name) => name !== "default-deny-network"),
    );
    try {
      return await optionsFromEnv().then(
        () => "assembled",
        (error: unknown) => String(error),
      );
    } finally {
      process.env.OPENSHELL_PROBE_RECEIPT = saved;
    }
  })();
  record(
    "receipt-earned-and-enforced",
    "the receipt lists only what this run proved, round-trips through the boot parser, and a capability struck out is refused",
    roundTrip.length === proven.length &&
      proven.every((name) => roundTrip.includes(name)) &&
      tampered.includes("default-deny-network"),
    { proven, roundTrip, tampered: tampered.slice(0, 240) },
  );

  // 7 — stop: the sandbox stops, and reading it afterwards does not wake it up.
  const stopped = await provider.stop(bot);
  const afterStop = await provider.status(bot);
  const stillStopped = await clientA.inspectSandbox(scopeOf(workspaceA, bot));
  record(
    "stop-probe-sandbox",
    "stop reports it was running, status reads absent, and the sandbox stays stopped",
    stopped.wasRunning === true &&
      afterStop.state === "absent" &&
      stillStopped.state === "stopped",
    { stopped, afterStop, stillStopped },
  );

  // 8 — the exposed address is real: a service inside a sandbox answers through the gateway URL.
  // The pinned base image ships no listener, so this one case runs the exposure image.
  const exposureClient = createOpenShellGatewayClient({
    endpoint: env.endpoint,
    workspace: workspaceA,
    image: env.exposureImage,
    caPath: env.ca,
    certPath: env.cert,
    keyPath: env.key,
    servicePort: env.port,
    settleMs: 180_000,
  });
  const expoScope = scopeOf(workspaceA, `expo-${suffix}`);
  const expoUrl = await exposureClient
    .ensureSandbox(expoScope)
    .then((view) => view.url)
    .catch((error: unknown) => String(error));
  const server = await exposureClient.exec(expoScope, [
    "/bin/sh",
    "-c",
    `nohup python3 -m http.server ${env.port} >/tmp/http.log 2>&1 & sleep 1; echo SERVER-UP`,
  ]);
  const localCheck = await exposureClient.exec(expoScope, [
    "python3",
    "-c",
    `import urllib.request;print("LOCAL-" + str(urllib.request.urlopen("http://127.0.0.1:${env.port}").status))`,
  ]);
  // The exposed URL names the in-cluster gateway port; off-cluster this run reaches the same
  // listener through the port-forward, keeping the hostname (SNI and routing) exactly as issued.
  const through = await httpsThroughForward(String(expoUrl), env.ca);
  record(
    "exposed-address-reachable",
    "the URL locate hands out routes to a service really running inside the sandbox",
    server.stdout.includes("SERVER-UP") &&
      localCheck.stdout.includes("LOCAL-200") &&
      // The listener answers "/" with 200; anything else (a gateway error page included) is not
      // the sandbox's own service answering.
      through === "HTTP-200",
    { expoUrl, server, localCheck, through },
  );

  // Cleanup — only this run's two workspaces, verified gone by name afterwards.
  const cleanupNotes: string[] = [];
  // Structured failures, not message matching: a reset that answers `cleared: false` or throws is
  // a failure this case must be able to report, so the receipts it writes stay trustworthy.
  const cleanupFailures: string[] = [];
  for (const scope of [
    scopeOf(workspaceA, bot),
    denyBreakScope,
    scopeB,
    expoScope,
  ]) {
    const client = scope.workspaceId === workspaceB ? clientB : exposureClient;
    try {
      const { cleared } = await client.resetSandbox(scope);
      if (!cleared) cleanupFailures.push(`reset ${scope.botId}: not cleared`);
    } catch (error) {
      cleanupFailures.push(
        `reset ${scope.botId}: ${String(error).slice(0, 120)}`,
      );
    }
  }
  for (const workspace of [workspaceA, workspaceB]) {
    cleanupNotes.push(
      `${workspace}: ${await operator.deleteWorkspace(workspace)}`,
    );
  }
  const remaining = kubectl("get", "sandboxes", "-A", "--no-headers");
  const residue = remaining.stdout
    .split("\n")
    .filter((line) => line.includes(workspaceA) || line.includes(workspaceB));
  record(
    "cleanup-verified",
    "this run's sandboxes and workspaces are gone from the cluster",
    residue.length === 0 && cleanupFailures.length === 0,
    { cleanupFailures, cleanupNotes, residue },
  );

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    cluster: {
      context: env.context,
      serverVersion,
      endpoint: env.endpoint,
      image: env.image,
      exposureImage: env.exposureImage,
    },
    generation,
    /** Mount this in the chart's computers.openshell.probeReceipt: it is what this run proved. */
    receipt: finalReceipt,
    workspaces: { teamA: workspaceA, teamB: workspaceB },
    cases: outcomes,
    verdict: outcomes.every((outcome) => outcome.pass)
      ? "PASS"
      : `FAIL (${outcomes.filter((outcome) => !outcome.pass).length} of ${outcomes.length})`,
  };
  const json = JSON.stringify(report, null, 2);
  if (env.report) {
    mkdirSync(dirname(env.report), { recursive: true });
    writeFileSync(env.report, json);
    console.log(`report: ${env.report}`);
  } else {
    console.log(json);
  }
  if (report.verdict !== "PASS") process.exit(1);
}

await main().catch((error: unknown) => {
  console.error(
    `acceptance aborted: ${error instanceof Error ? error.stack : String(error)}`,
  );
  if (env.report) {
    mkdirSync(dirname(env.report), { recursive: true });
    writeFileSync(
      env.report,
      JSON.stringify({ aborted: String(error), cases: outcomes }, null, 2),
    );
  }
  process.exit(1);
});
