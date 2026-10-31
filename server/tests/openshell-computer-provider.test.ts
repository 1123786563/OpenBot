import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  createOpenShellComputerProvider,
  OPEN_SHELL_REQUIRED_CAPABILITIES,
  type OpenShellAdminClient,
  type OpenShellProviderOptions,
  type OpenShellSandboxEvidence,
  type OpenShellSandboxView,
  type OpenShellScope,
} from "../src/computer/openshell";
import {
  createOpenShellGatewayClient,
  imageLabel,
  needsReplacement,
  OPEN_SHELL_ENV,
  type OpenShellGrpcClient,
  openShellDeploymentInputs,
} from "../src/computer/openshell-client";
import { ProviderError } from "../src/computer/provider";
import type { OpenShellComputerConfig } from "../src/config";

/**
 * The fail-closed half of the OpenShell provider.
 *
 * A sandbox is only usable while the receipts the gateway itself reports still hold: its policy
 * revision must be loaded, the substrate probes must still say the isolation holds, and no
 * unauthorized destination may have been reachable. A sandbox that fails any of that is stopped,
 * not handed out, and nothing may act on a scope that is not the Bot it was asked about.
 */
describe("OpenShell fail-closed lifecycle", () => {
  function goodEvidence(): OpenShellSandboxEvidence {
    return {
      policy: "loaded",
      isolation: "enforced",
      credentials: "hidden",
      unauthorizedDestination: "denied",
    };
  }

  /**
   * A client that answers from a table the tests can rewrite between calls, so each case shows the
   * exact evidence the provider refused on and every lifecycle call is recorded.
   */
  function fakeClient() {
    const calls = {
      ensured: [] as OpenShellScope[],
      inspected: [] as OpenShellScope[],
      stopped: [] as OpenShellScope[],
      reset: [] as OpenShellScope[],
    };
    const answers = {
      evidence: goodEvidence(),
      state: "ready" as OpenShellSandboxView["state"],
      failure: undefined as unknown,
      serviceAddress: true,
      stopFailure: undefined as unknown,
    };
    const client: OpenShellAdminClient = {
      hasServiceAddress() {
        return answers.serviceAddress;
      },
      async ensureSandbox(scope) {
        calls.ensured.push(scope);
        if (answers.failure) throw answers.failure;
        return {
          name: `${scope.tenantId}--${scope.workspaceId}--${scope.botId}`,
          state: answers.state,
          url: `https://sandbox.internal/${scope.workspaceId}/${scope.botId}`,
          generation: scope.generation,
          evidence: answers.evidence,
        };
      },
      async inspectSandbox(scope) {
        calls.inspected.push(scope);
        if (answers.failure) throw answers.failure;
        return {
          name: `${scope.tenantId}--${scope.workspaceId}--${scope.botId}`,
          state: answers.state,
          generation: scope.generation,
          evidence: answers.evidence,
        };
      },
      async stopSandbox(scope) {
        calls.stopped.push(scope);
        if (answers.stopFailure) throw answers.stopFailure;
        return { wasRunning: true };
      },
      async resetSandbox(scope) {
        calls.reset.push(scope);
        return { cleared: true };
      },
      async listSandboxes() {
        return [];
      },
    };
    return { client, calls, answers };
  }

  function provider(
    client: OpenShellAdminClient,
    scopeFor: OpenShellProviderOptions["scopeFor"] = async (botId) => ({
      tenantId: "acme",
      workspaceId: "research",
      botId,
      environment: "computer",
      generation: "gen-1",
    }),
  ) {
    return createOpenShellComputerProvider({
      client,
      scopeFor,
      capabilities: OPEN_SHELL_REQUIRED_CAPABILITIES,
    });
  }

  test("locate_refuses_and_stops_a_sandbox_whose_evidence_failed", async () => {
    const cases: {
      name: string;
      evidence: OpenShellSandboxEvidence | undefined;
      names: string;
    }[] = [
      {
        name: "policy receipt still pending",
        evidence: { ...goodEvidence(), policy: "pending" },
        names: "policy",
      },
      {
        name: "policy receipt failed",
        evidence: { ...goodEvidence(), policy: "failed" },
        names: "policy",
      },
      {
        name: "isolation alert",
        evidence: { ...goodEvidence(), isolation: "broken" },
        names: "isolation",
      },
      {
        name: "control credentials visible to the workload",
        evidence: { ...goodEvidence(), credentials: "exposed" },
        names: "credential",
      },
      {
        name: "unauthorized destination reachable",
        evidence: { ...goodEvidence(), unauthorizedDestination: "reachable" },
        names: "destination",
      },
      {
        name: "no evidence at all",
        evidence: undefined,
        names: "evidence",
      },
    ];

    for (const one of cases) {
      const { client, calls, answers } = fakeClient();
      answers.evidence = one.evidence as OpenShellSandboxEvidence;
      const computer = provider(client);
      const failure = await computer.locate("sales").then(
        () => null,
        (error: unknown) => error,
      );
      if (!(failure instanceof ProviderError)) {
        throw new Error(
          `${one.name}: locate must refuse with a ProviderError, got ${String(failure)}`,
        );
      }
      if (!failure.message.toLowerCase().includes(one.names)) {
        throw new Error(
          `${one.name}: the refusal must say why (${one.names}), got ${failure.message}`,
        );
      }
      // Fail closed: the sandbox that failed its evidence is stopped, not left running unguarded.
      if (calls.stopped.length !== 1) {
        throw new Error(
          `${one.name}: the failed sandbox must be stopped once, got ${calls.stopped.length}`,
        );
      }
    }
  });

  test("locate_answers_only_when_every_receipt_holds", async () => {
    const { client, calls } = fakeClient();
    const computer = provider(client);
    expect(await computer.locate("sales")).toBe(
      "https://sandbox.internal/research/sales",
    );
    // Usable is not woken-then-questioned: the sandbox that answered is the one that was ensured.
    expect(calls.ensured.map((scope) => scope.botId)).toEqual(["sales"]);
    expect(calls.stopped).toEqual([]);
  });

  test("status_reads_the_sandbox_without_starting_it", async () => {
    const { client, calls, answers } = fakeClient();
    const computer = provider(client);
    expect(await computer.status("sales")).toEqual({
      botId: "sales",
      state: "ready",
    });

    answers.state = "stopped";
    expect(await computer.status("sales")).toEqual({
      botId: "sales",
      state: "absent",
    });

    // A failed receipt is a reason, not a state the caller could mistake for a stopped computer.
    answers.state = "ready";
    answers.evidence = { ...goodEvidence(), policy: "pending" };
    const broken = await computer.status("sales");
    expect(broken.state).toBe("unreachable");
    expect(String(broken.reason).toLowerCase()).toContain("policy");

    // Reading never started anything.
    expect(calls.ensured).toEqual([]);
  });

  test("stop_and_reset_refuse_a_scope_that_is_not_the_requested_bot", async () => {
    const { client, calls } = fakeClient();
    // The placement answers for a different Bot than the one asked about: acting on it would stop
    // another Bot's computer, so every lifecycle call must refuse before the client is reached.
    const crossed = provider(client, async () => ({
      tenantId: "acme",
      workspaceId: "research",
      botId: "someone-else",
      environment: "computer",
      generation: "gen-1",
    }));
    await expect(crossed.stop("sales")).rejects.toThrow(ProviderError);
    await expect(crossed.reset("sales")).rejects.toThrow(ProviderError);
    expect(calls.stopped).toEqual([]);
    expect(calls.reset).toEqual([]);
  });

  test("gateway_failures_become_provider_refusals", async () => {
    const { client, answers } = fakeClient();
    answers.failure = new Error("14 UNAVAILABLE: connection refused");
    const computer = provider(client);
    const failure = await computer.locate("sales").then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProviderError);
    expect(String((failure as Error).message)).toContain("UNAVAILABLE");
  });

  test("a_stop_that_failed_is_reported_not_swallowed", async () => {
    // The refusal says what actually happened to the sandbox: a stop that failed must not be
    // dressed up as "It was stopped." while the sandbox keeps running unguarded.
    const stopped = fakeClient();
    stopped.answers.evidence = {
      ...stopped.answers.evidence,
      isolation: "broken",
    };
    const failure = await provider(stopped.client)
      .locate("sales")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ProviderError);
    expect(String((failure as Error).message)).toContain("was stopped");

    const notStopped = fakeClient();
    notStopped.answers.evidence = {
      ...notStopped.answers.evidence,
      isolation: "broken",
    };
    notStopped.answers.stopFailure = new Error(
      "14 UNAVAILABLE: connection refused",
    );
    const honest = await provider(notStopped.client)
      .locate("sales")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(honest).toBeInstanceOf(ProviderError);
    const message = String((honest as Error).message);
    expect(message).toContain("isolation");
    expect(message).toContain("could not be stopped");
    expect(message).toContain("still running");
    expect(notStopped.calls.stopped).toHaveLength(1);
  });

  test("locate_refuses_before_ensuring_when_the_deployment_has_no_service_address", async () => {
    const { client, calls, answers } = fakeClient();
    answers.serviceAddress = false;
    const failure = await provider(client)
      .locate("sales")
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ProviderError);
    expect(String((failure as Error).message).toLowerCase()).toContain(
      "address",
    );
    // No sandbox may be created or woken when there is nothing to reach it through.
    expect(calls.ensured).toEqual([]);
    expect(calls.stopped).toEqual([]);
  });

  test("status_reports_absent_for_a_sandbox_that_was_never_created", async () => {
    const { client, answers } = fakeClient();
    // A missing sandbox has no evidence to fail; it is simply not there.
    answers.state = "missing";
    expect(await provider(client).status("sales")).toEqual({
      botId: "sales",
      state: "absent",
    });
  });
});

describe("openShell deployment inputs", () => {
  const DIGEST =
    "nvcr.io/nvidia/base/ubuntu@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const config: OpenShellComputerConfig = {
    provider: "openshell",
    gatewayEndpoint: "https://openshell.openshell.svc.cluster.local:8080",
    executionScope: { tenantId: "acme", workspaceId: "research" },
    allowPrivateHosts: false,
  };

  /** The environment a chart-mounted deployment presents, from its probe receipt on down. */
  function deploymentEnvironment(overrides: Record<string, string> = {}) {
    const receipt = JSON.stringify({
      gatewayEndpoint: config.gatewayEndpoint,
      sandboxImage: DIGEST,
      serverVersion: "0.1.6",
      capabilities: [...OPEN_SHELL_REQUIRED_CAPABILITIES],
    });
    return {
      [OPEN_SHELL_ENV.receipt]: receipt,
      [OPEN_SHELL_ENV.image]: DIGEST,
      [OPEN_SHELL_ENV.generation]: "gen-9",
      [OPEN_SHELL_ENV.ca]: "/etc/openshell/tls/ca.crt",
      [OPEN_SHELL_ENV.cert]: "/etc/openshell/tls/tls.crt",
      [OPEN_SHELL_ENV.key]: "/etc/openshell/tls/tls.key",
      ...overrides,
    };
  }

  function inputs(env: Record<string, string>) {
    return openShellDeploymentInputs(config, (name) => env[name]);
  }

  test("accepts_the_environment_a_recorded_probe_receipt_assembled", () => {
    const assembled = inputs(deploymentEnvironment());
    expect(assembled.capabilities).toEqual([
      ...OPEN_SHELL_REQUIRED_CAPABILITIES,
    ]);
    expect(assembled.image).toBe(DIGEST);
    expect(assembled.generation).toBe("gen-9");
    expect(assembled.paths).toEqual({
      caPath: "/etc/openshell/tls/ca.crt",
      certPath: "/etc/openshell/tls/tls.crt",
      keyPath: "/etc/openshell/tls/tls.key",
    });
    expect(assembled.servicePort).toBeUndefined();
  });

  test("a_deployment_without_mounted_client_certificates_is_refused", () => {
    // The certificate mounts are part of what the chart assembles: a receipt and a pinned image
    // do not make up for them, and the refusal happens before any gateway is dialled.
    const noPki = deploymentEnvironment({
      [OPEN_SHELL_ENV.ca]: "",
      [OPEN_SHELL_ENV.cert]: "",
      [OPEN_SHELL_ENV.key]: "",
    });
    expect(() => inputs(noPki)).toThrow(ProviderError);
  });

  test("a_receipt_from_another_deployment_or_image_is_refused", () => {
    const otherEndpoint = deploymentEnvironment({
      [OPEN_SHELL_ENV.receipt]: JSON.stringify({
        gatewayEndpoint: "https://elsewhere.example:8080",
        sandboxImage: DIGEST,
        capabilities: [...OPEN_SHELL_REQUIRED_CAPABILITIES],
      }),
    });
    expect(() => inputs(otherEndpoint)).toThrow(ProviderError);

    const otherImage = deploymentEnvironment({
      [OPEN_SHELL_ENV.receipt]: JSON.stringify({
        gatewayEndpoint: config.gatewayEndpoint,
        sandboxImage: `${DIGEST.slice(0, -1)}0`,
        capabilities: [...OPEN_SHELL_REQUIRED_CAPABILITIES],
      }),
    });
    expect(() => inputs(otherImage)).toThrow(ProviderError);
  });

  test("a_partial_or_missing_receipt_is_refused_for_placement", () => {
    expect(() =>
      inputs(deploymentEnvironment({ [OPEN_SHELL_ENV.receipt]: "" })),
    ).toThrow(ProviderError);
    const partial = deploymentEnvironment({
      [OPEN_SHELL_ENV.receipt]: JSON.stringify({
        gatewayEndpoint: config.gatewayEndpoint,
        sandboxImage: DIGEST,
        serverVersion: "0.1.6",
        capabilities: ["default-deny-network"],
      }),
    });
    expect(() => inputs(partial)).toThrow(ProviderError);
  });

  test("an_unpinned_image_and_a_malformed_port_are_refused", () => {
    expect(() =>
      inputs(
        deploymentEnvironment({
          [OPEN_SHELL_ENV.image]: "nvcr.io/nvidia/base/ubuntu:24.04",
          [OPEN_SHELL_ENV.receipt]: JSON.stringify({
            gatewayEndpoint: config.gatewayEndpoint,
            sandboxImage: "nvcr.io/nvidia/base/ubuntu:24.04",
            capabilities: [...OPEN_SHELL_REQUIRED_CAPABILITIES],
          }),
        }),
      ),
    ).toThrow(ProviderError);
    expect(() =>
      inputs(
        deploymentEnvironment({ [OPEN_SHELL_ENV.servicePort]: "8765abc" }),
      ),
    ).toThrow(ProviderError);
  });
});

describe("sandbox replacement", () => {
  const image = "nvcr.io/nvidia/base/ubuntu@sha256:0123456789abcdef";
  const scope: OpenShellScope = {
    tenantId: "acme",
    workspaceId: "research",
    botId: "sales",
    environment: "computer",
    generation: "gen-2",
  };
  const currentImage = imageLabel(image);

  test("keeps_a_sandbox_of_the_same_generation_and_image", () => {
    expect(
      needsReplacement(
        {
          "managed-by": "openbot",
          generation: "gen-2",
          "image-digest": currentImage,
        },
        scope,
        image,
      ),
    ).toBe(false);
  });

  test("replaces_a_sandbox_from_another_generation_or_image", () => {
    expect(
      needsReplacement(
        { generation: "gen-1", "image-digest": currentImage },
        scope,
        image,
      ),
    ).toBe(true);
    expect(
      needsReplacement(
        { generation: "gen-2", "image-digest": "sha256-000000000000" },
        scope,
        image,
      ),
    ).toBe(true);
  });
});

/**
 * The gateway client's own sequencing, against a stubbed gRPC dial: the delete-then-create
 * replacement must wait for the name to be free, a terminal phase must fail fast instead of
 * polling to the deadline, probe evidence is measured once per sandbox and policy revision, and a
 * sandbox the deployment did not fully attribute belongs to no Bot.
 */
describe("OpenShell gateway client sequencing", () => {
  const scope: OpenShellScope = {
    tenantId: "acme",
    workspaceId: "research",
    botId: "bot-1",
    environment: "computer",
    generation: "gen-2",
  };
  const image = `nvcr.io/nvidia/base/ubuntu@sha256:${"1".repeat(64)}`;
  const ownershipLabels = {
    "managed-by": "openbot",
    tenant: scope.tenantId,
    workspace: scope.workspaceId,
    bot: scope.botId,
    environment: scope.environment,
    generation: scope.generation,
    "image-digest": imageLabel(image),
  };
  const notFound = () =>
    Object.assign(new Error("sandbox not found"), { code: 5 });

  type GrpcCall = { method: string; request: Record<string, unknown> };

  function grpcStub(handlers: {
    [method: string]: (request: Record<string, unknown>) => unknown;
  }) {
    const calls: GrpcCall[] = [];
    let execCalls = 0;
    const client = {
      ExecSandbox(request: { command?: string[] }) {
        execCalls += 1;
        const command = (request.command ?? []).join(" ");
        return (async function* () {
          yield {
            stdout: {
              data: Buffer.from(
                `${command.includes("/dev/tcp/") ? "OPENBOT-DENIED" : "OPENBOT-BOUNDARY-DONE"}\n`,
              ),
            },
          };
          yield { exit: {} };
        })();
      },
    } as Record<string, unknown>;
    const stub = new Proxy(client, {
      get(target, method: string) {
        if (method === "ExecSandbox") return target.ExecSandbox;
        return (
          request: Record<string, unknown>,
          _options: { deadline: number },
          callback: (error: unknown, response: unknown) => void,
        ) => {
          calls.push({ method, request });
          try {
            callback(null, handlers[method]?.(request) ?? {});
          } catch (error) {
            callback(error, undefined);
          }
        };
      },
    });
    return {
      client: stub as OpenShellGrpcClient,
      calls,
      execCalls: () => execCalls,
    };
  }

  function clientOf(
    handlers: Parameters<typeof grpcStub>[0],
    settleMs = 10_000,
  ) {
    const stub = grpcStub(handlers);
    const client = createOpenShellGatewayClient({
      endpoint: "https://openshell.test:8080",
      workspace: "research",
      image,
      caPath: "",
      certPath: "",
      keyPath: "",
      servicePort: 5500,
      settleMs,
      dial: () => stub.client,
    });
    return { client, stub };
  }

  test("a_replacement_waits_until_the_deleted_name_is_actually_free", async () => {
    const oldSandbox = {
      metadata: {
        name: "s",
        uid: "u-old",
        labels: { ...ownershipLabels, generation: "gen-1" },
      },
      status: { phase: "SANDBOX_PHASE_READY" },
    };
    const newSandbox = {
      metadata: { name: "s", uid: "u-new", labels: ownershipLabels },
      status: { phase: "SANDBOX_PHASE_READY" },
    };
    const state = {
      present: "old" as "old" | "new" | false,
      deleted: false,
      lookups: 0,
    };
    const { client } = clientOf({
      GetSandbox: () => {
        if (state.present === false) throw notFound();
        if (state.deleted) {
          state.lookups += 1;
          // The gateway accepted the deletion but has not finished it for one more lookup: the
          // name still answers before it goes absent.
          if (state.lookups >= 2) {
            state.present = false;
            throw notFound();
          }
        }
        return { sandbox: state.present === "old" ? oldSandbox : newSandbox };
      },
      DeleteSandbox: () => {
        state.deleted = true;
        return { outcome: "DELETION_OUTCOME_ACCEPTED" };
      },
      CreateSandbox: () => {
        if (state.present !== false)
          throw Object.assign(new Error("already exists"), { code: 6 });
        state.present = "new";
        state.deleted = false;
        state.lookups = 0;
        return {};
      },
      GetSandboxPolicyStatus: () => ({
        activeVersion: 1,
        revision: { status: "POLICY_STATUS_LOADED" },
      }),
      ExposeService: () => ({ url: "https://computer.test/s" }),
    });
    const view = await client.ensureSandbox(scope);
    expect(view.state).toBe("ready");
    expect(view.evidence?.isolation).toBe("enforced");
  });

  test("a_terminal_phase_fails_fast_instead_of_polling_to_the_deadline", async () => {
    const { client } = clientOf(
      {
        GetSandbox: () => ({
          sandbox: {
            metadata: { name: "s", uid: "u-1", labels: ownershipLabels },
            status: { phase: "SANDBOX_PHASE_FAILED" },
          },
        }),
      },
      400,
    );
    await expect(client.ensureSandbox(scope)).rejects.toThrow(
      /came to rest at SANDBOX_PHASE_FAILED/,
    );
  });

  test("live_probes_are_measured_once_per_sandbox_and_policy_version", async () => {
    const state = { version: 2 };
    const { client, stub } = clientOf({
      GetSandbox: () => ({
        sandbox: {
          metadata: { name: "s", uid: "u-1", labels: ownershipLabels },
          status: { phase: "SANDBOX_PHASE_READY" },
        },
      }),
      GetSandboxPolicyStatus: () => ({
        activeVersion: state.version,
        revision: { status: "POLICY_STATUS_LOADED" },
      }),
      UpdateConfig: () => {
        state.version = 3;
        return {};
      },
    });
    await client.inspectSandbox(scope);
    expect(stub.execCalls()).toBe(2);
    await client.inspectSandbox(scope);
    expect(stub.execCalls()).toBe(2);
    await client.updatePolicy(scope, { networkPolicies: {} });
    await client.inspectSandbox(scope);
    expect(stub.execCalls()).toBe(4);
  });

  test("a_sandbox_missing_the_environment_label_belongs_to_no_bot", async () => {
    const { client } = clientOf({
      ListSandboxes: () => ({
        sandboxes: [
          {
            metadata: { name: "s1", uid: "u-1", labels: ownershipLabels },
            status: { phase: "SANDBOX_PHASE_READY" },
          },
          {
            metadata: {
              name: "s2",
              uid: "u-2",
              labels: (() => {
                const partial = { ...ownershipLabels } as Record<
                  string,
                  string
                >;
                delete partial.environment;
                return partial;
              })(),
            },
            status: { phase: "SANDBOX_PHASE_READY" },
          },
        ],
      }),
    });
    const owned = await client.listSandboxes();
    expect(owned.map((entry) => entry.view.name)).toEqual(["s1"]);
  });
});

/**
 * The dial shape is part of the contract: grpc-js 1.14 takes call options as the second argument,
 * and a `undefined`-metadata placeholder makes it throw "Incorrect arguments passed" before
 * anything reaches the wire — a mistake a stubbed dial can never catch, because the stub is the
 * one that defines the shape. This case dials a real grpc-js client (to an address that refuses
 * connections) so the argument checking grpc-js itself does is what runs.
 */
describe("OpenShell gateway dial shape", () => {
  test("the_call_options_shape_is_the_one_grpc_js_accepts", async () => {
    const grpc = await import("@grpc/grpc-js");
    const loader = await import("@grpc/proto-loader");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // import.meta.url works on both runtimes; import.meta.dir is Bun-only.
    const protoDir = fileURLToPath(
      new URL("../src/computer/openshell-proto", import.meta.url),
    );
    const definition = loader.loadSync(join(protoDir, "openshell.proto"), {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir],
    });
    const api = grpc.loadPackageDefinition(definition) as never as {
      openshell: {
        v1: {
          OpenShell: new (
            endpoint: string,
            credentials: unknown,
          ) => OpenShellGrpcClient;
        };
      };
    };
    const raw = new api.openshell.v1.OpenShell(
      "127.0.0.1:1",
      grpc.credentials.createInsecure(),
    );
    const client = createOpenShellGatewayClient({
      endpoint: "https://127.0.0.1:1",
      workspace: "shape-check",
      image: `nvcr.io/nvidia/base/ubuntu@sha256:${"1".repeat(64)}`,
      caPath: "",
      certPath: "",
      keyPath: "",
      settleMs: 500,
      dial: () => raw,
    });
    const failure = await client.listSandboxes().then(
      () => "none",
      (error: unknown) => String(error),
    );
    expect(failure).not.toContain("Incorrect arguments passed");
  });
});
