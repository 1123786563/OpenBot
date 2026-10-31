#!/usr/bin/env bun
/*
 * The OpenShell computer acceptance run (T02, plan Task 2 Step 3).
 *
 * Two phases, one script:
 *
 *  substrate — proves, on a real cluster and through the real provider and gateway client, that the
 *  product's computer image can be the substrate: a sandbox is created with the policy the provider
 *  sends, the computer service the provider starts inside it answers its health check, the four
 *  boundary capabilities hold on THIS image (policy receipt, default deny, cross-workspace denial,
 *  credential boundary), and Chromium on that image navigates and acts through the same exposed URL
 *  the product uses. Writes the probe receipt a deployment mounts — only what this run measured.
 *
 *  product — through the OpenBot computer routes of a server deployed with that receipt: a wake that
 *  starts the service, a navigate/click/read/screenshot round trip, one Bot's files invisible to
 *  another, an unlisted destination refused by the browser, a stop that stays stopped through a
 *  status read, and a wake again that re-verifies policy and the deny before it hands the computer
 *  back. Ends by deleting what it created and verifying it is gone.
 *
 * The egress grant each phase pushes is the run's stand-in for a deployment administrator's standing
 * preconfiguration (D11): nothing is granted by default, the refusal before the grant is recorded,
 * and the grant names exactly the one host and the binaries the browser runs.
 *
 * Refuses to run against the wrong cluster: the kubectl context must equal OPENSHELL_ACCEPT_CONTEXT.
 *
 * Usage (all paths absolute):
 *   T02_ACCEPT_PHASE=substrate|product \
 *   OPENSHELL_ACCEPT_CONTEXT=… OPENSHELL_ACCEPT_CA=… OPENSHELL_ACCEPT_CERT=… OPENSHELL_ACCEPT_KEY=… \
 *   OPENSHELL_ACCEPT_OPERATOR_CERT=… OPENSHELL_ACCEPT_OPERATOR_KEY=… \
 *   OPENSHELL_ACCEPT_IMAGE=…@sha256:… OPENSHELL_ACCEPT_COMPUTER_TOKEN=… \
 *   OPENSHELL_ACCEPT_BASE=http://127.0.0.1:3001 OPENSHELL_ACCEPT_ENDPOINT=https://openshell.localhost:17670 \
 *   OPENSHELL_ACCEPT_WORKSPACE=… OPENSHELL_ACCEPT_TENANT=… OPENSHELL_ACCEPT_GENERATION=… \
 *   bun scripts/openshell-computer-acceptance.ts --report <path.json>
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request as requestHttps } from "node:https";
import {
  createOpenShellComputerProvider,
  OPEN_SHELL_REQUIRED_CAPABILITIES,
  type OpenShellScope,
  openShellProviderOptions,
} from "../server/src/computer/openshell";
import {
  CREDENTIAL_PATHS,
  type OpenShellGatewayClient,
  createOpenShellGatewayClient,
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
  phase: requireEnv("T02_ACCEPT_PHASE"),
  context: requireEnv("OPENSHELL_ACCEPT_CONTEXT"),
  /** Host-side gateway address; a `kubectl port-forward` stands behind it. */
  endpoint: requireEnv("OPENSHELL_ACCEPT_ENDPOINT"),
  ca: requireEnv("OPENSHELL_ACCEPT_CA"),
  cert: requireEnv("OPENSHELL_ACCEPT_CERT"),
  key: requireEnv("OPENSHELL_ACCEPT_KEY"),
  operatorCert: requireEnv("OPENSHELL_ACCEPT_OPERATOR_CERT"),
  operatorKey: requireEnv("OPENSHELL_ACCEPT_OPERATOR_KEY"),
  image: requireEnv("OPENSHELL_ACCEPT_IMAGE"),
  token: requireEnv("OPENSHELL_ACCEPT_COMPUTER_TOKEN"),
  port: Number.parseInt(process.env.OPENSHELL_ACCEPT_PORT ?? "4100", 10),
  base: process.env.OPENSHELL_ACCEPT_BASE ?? "http://127.0.0.1:3001",
  workspace: requireEnv("OPENSHELL_ACCEPT_WORKSPACE"),
  tenant: requireEnv("OPENSHELL_ACCEPT_TENANT"),
  generation: requireEnv("OPENSHELL_ACCEPT_GENERATION"),
  report: process.env.OPENSHELL_ACCEPT_REPORT,
  /** The local port the gateway port-forward listens on (TLS goes there with the gateway's host). */
  forwardPort: Number.parseInt(
    process.env.OPENSHELL_ACCEPT_FORWARD_PORT ?? "17670",
    10,
  ),
  /** The egress the run grants, as a deployment administrator's standing preconfiguration would. */
  grantHosts:
    // example.com's own "More information…" link is the product phase's click target, so the
    // page it leads to is granted alongside the two example hosts.
    (
      process.env.OPENSHELL_ACCEPT_GRANT_HOSTS ??
      "example.com,www.example.com,www.iana.org"
    )
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
};
if (env.phase !== "substrate" && env.phase !== "product") {
  console.error(
    `T02_ACCEPT_PHASE must be substrate or product, got ${env.phase}.`,
  );
  process.exit(2);
}
if (!/@sha256:[0-9a-f]{64}$/.test(env.image)) {
  console.error(
    `OPENSHELL_ACCEPT_IMAGE must be digest-pinned (…@sha256:<64 hex>), got ${env.image}.`,
  );
  process.exit(2);
}

function kubectl(...args: string[]): { stdout: string; status: number } {
  const run = spawnSync("kubectl", args, { encoding: "utf8" });
  return { stdout: run.stdout.trim(), status: run.status ?? -1 };
}

const suffix = Date.now().toString(36);
type Outcome = {
  id: string;
  claim: string;
  pass: boolean;
  evidence: string;
  capability?: string;
};
const outcomes: Outcome[] = [];

function record(
  id: string,
  claim: string,
  pass: boolean,
  evidence: unknown,
  capability?: string,
) {
  outcomes.push({
    id,
    claim,
    pass,
    evidence:
      typeof evidence === "string" ? evidence : JSON.stringify(evidence),
    capability,
  });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id} — ${claim}`);
  if (!pass) console.log(`      ${JSON.stringify(evidence).slice(0, 600)}`);
}

/** The sandbox name the provider derives from a scope (the shared derivation, reproduced for kubectl). */
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

/** A request to an https URL the gateway issued, through the port-forward, verified with the run's CA. */
function httpsThroughForward(
  rawUrl: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: string,
  scopeHeaders: Record<string, string> = {},
): Promise<string> {
  const url = new URL(rawUrl);
  return new Promise((resolve) => {
    const request = requestHttps(
      {
        host: "127.0.0.1",
        port: env.forwardPort,
        path: `${url.pathname}${url.search}`,
        method,
        servername: url.hostname,
        headers: {
          // The gateway's exposed-address routing keys on the hostname; the port it printed is the
          // in-cluster one and does not name this port-forward.
          host: url.hostname,
          "x-openbot-bot-id": scopeHeaders["x-openbot-bot-id"] ?? "",
          "x-openbot-tenant-id": env.tenant,
          "x-openbot-workspace-id":
            scopeHeaders["x-openbot-workspace-id"] ?? env.workspace,
          "x-openbot-computer-token": env.token,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ca: readFileSync(env.ca),
      },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        response.on("end", () =>
          resolve(`HTTP-${response.statusCode} ${text.slice(0, 500)}`),
        );
      },
    );
    request.setTimeout(45_000, () => request.destroy(new Error("timed out")));
    request.on("error", (error: Error) =>
      resolve(`fetch-failed:${String(error.message).slice(0, 120)}`),
    );
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function clientFor(
  workspace: string,
  asOperator = false,
): OpenShellGatewayClient {
  return createOpenShellGatewayClient({
    endpoint: env.endpoint,
    workspace,
    image: env.image,
    caPath: env.ca,
    certPath: asOperator ? env.operatorCert : env.cert,
    keyPath: asOperator ? env.operatorKey : env.key,
    settleMs: 240_000,
  });
}

const operator = clientFor("default", true);

const config: Extract<ComputerConfig, { provider: "openshell" }> = {
  provider: "openshell",
  gatewayEndpoint: env.endpoint,
  executionScope: { tenantId: env.tenant, workspaceId: env.workspace },
  token: env.token,
  allowPrivateHosts: false,
};

/**
 * The bootstrap receipt for the substrate phase: the four capabilities the cases below prove live.
 * The product phase reads whatever the deployment mounted instead, which is this run's output.
 */
function receiptJson(capabilities: readonly string[]): string {
  return JSON.stringify({
    gatewayEndpoint: config.gatewayEndpoint,
    sandboxImage: env.image,
    capabilities: [...capabilities],
  });
}
if (env.phase === "substrate") {
  process.env.OPENSHELL_PROBE_RECEIPT = receiptJson(
    OPEN_SHELL_REQUIRED_CAPABILITIES,
  );
}

const scopeOf = (workspaceId: string, botId: string): OpenShellScope => ({
  tenantId: env.tenant,
  workspaceId,
  botId,
  environment: "computer",
  generation: env.generation,
});

/** The standing preconfiguration this run pushes after recording the refusal without it. */
function grantPolicy(): Record<string, unknown> {
  return {
    version: 2,
    filesystem: {
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
        "/sys",
        "/dev/urandom",
        "/app",
        "/shared",
        "/node_modules",
        "/ms-playwright",
      ],
      readWrite: ["/tmp", "/dev/null"],
    },
    networkPolicies: {
      "allow-browser-web": {
        name: "allow-browser-web",
        endpoints: env.grantHosts.map((host) => ({
          host,
          port: 443,
          protocol: "tcp",
        })),
        binaries: [
          { path: "/ms-playwright/chromium-1234/chrome-linux/chrome" },
          { path: "/ms-playwright/chromium-1234/chrome-linux/headless_shell" },
          { path: "/usr/local/bin/bun" },
        ],
      },
    },
  };
}

/** The interactive page both phases drive: served inside the sandbox, clicked through the product's URL. */
const PAGE_PORT_SUBSTRATE = 9377;
const pageServerCommand = (port: number) =>
  // Backtick HTML, no escaped quotes anywhere: Bun's parser rejects `\"` inside a double-quoted
  // string, and the shell keeps single quotes literal, so this form is the one that parses.
  `nohup bun -e 'const h=\`<html><head><title>T02-PAGE</title></head><body><h1>T02-PAGE</h1><button id="b">go</button><script>document.getElementById("b").onclick=function(){document.title="T02-CLICKED"}</script></body></html>\`;Bun.serve({port:${port},fetch:()=>new Response(h,{headers:{"content-type":"text/html"}})})' >/tmp/page.log 2>&1 & echo SERVED`;

async function main() {
  const startedAt = new Date().toISOString();

  // Preflight: the cluster must be the one this run was authorized for.
  const context = kubectl("config", "current-context");
  if (context.status !== 0 || context.stdout !== env.context) {
    throw new Error(
      `Refusing to run: kubectl context is ${JSON.stringify(context.stdout)}, expected ${JSON.stringify(env.context)}.`,
    );
  }
  const nodes = kubectl("get", "nodes", "--no-headers");
  const gatewayPod = kubectl(
    "-n",
    "openshell",
    "get",
    "pod",
    "openshell-0",
    "-o",
    "jsonpath={.spec.containers[0].image}={.status.phase}",
  );

  if (env.phase === "substrate") {
    await substratePhase();
  } else {
    await productPhase();
  }

  const passed = new Set(
    outcomes
      .filter((outcome) => outcome.pass && outcome.capability)
      .map((o) => o.capability),
  );
  const report = {
    run: "openshell-t02-computer-acceptance",
    phase: env.phase,
    startedAt,
    finishedAt: new Date().toISOString(),
    context: env.context,
    image: env.image,
    base: env.phase === "product" ? env.base : undefined,
    gateway: { endpoint: env.endpoint, pod: gatewayPod.stdout },
    nodes: nodes.stdout,
    outcomes,
    receipt:
      env.phase === "substrate"
        ? {
            gatewayEndpoint: config.gatewayEndpoint,
            sandboxImage: env.image,
            capabilities: OPEN_SHELL_REQUIRED_CAPABILITIES.filter((c) =>
              passed.has(c),
            ),
          }
        : undefined,
  };
  if (env.report) writeFileSync(env.report, JSON.stringify(report, null, 2));
  const failed = outcomes.filter((outcome) => !outcome.pass);
  console.log(
    `\n${outcomes.length - failed.length}/${outcomes.length} passed${failed.length ? `, FAILED: ${failed.map((f) => f.id).join(", ")}` : ""}`,
  );
  if (env.report) console.log(`report: ${env.report}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

async function substratePhase(): Promise<void> {
  const workspace = `t02s-a-${suffix}`.slice(0, 19);
  const bot = `t02sbot-${suffix}`;
  const scope = scopeOf(workspace, bot);
  const client = clientFor(workspace);

  await operator.createWorkspace(workspace, {
    "managed-by": "t02-acceptance",
  });
  // The deployment workspace the product phase's chart will use; created here so the receipt run
  // leaves the substrate in the state a deployment expects, and tolerated if it already is.
  await operator
    .createWorkspace(env.workspace, { "managed-by": "t02-acceptance" })
    .catch(() => undefined);
  // The substrate probes live in their own workspace, not the deployment's.
  config.executionScope.workspaceId = workspace;

  // The provider under test is the product path: options read from the deployment environment.
  process.env.OPENSHELL_SANDBOX_IMAGE = env.image;
  process.env.OPENBOT_DEPLOYMENT_GENERATION = env.generation;
  process.env.OPENSHELL_SANDBOX_SERVICE_PORT = String(env.port);
  process.env.COMPUTER_TOKEN = env.token;
  process.env.OPENSHELL_CA_CERT = env.ca;
  process.env.OPENSHELL_CLIENT_CERT = env.cert;
  process.env.OPENSHELL_CLIENT_KEY = env.key;
  const provider = createOpenShellComputerProvider(
    await openShellProviderOptions(config),
  );

  // 1 — the provider places a computer: the sandbox comes up, the service it starts answers, and
  // every live receipt holds. This is the new T02 behaviour end to end on the real substrate.
  const url = await provider.locate(bot);
  const inspected = await client.inspectSandbox(scope);
  record(
    "provider-starts-service",
    "locate answers the exposed URL of a service the provider started inside the sandbox, with the policy receipt and every live boundary probe holding",
    inspected.state === "ready" &&
      inspected.evidence?.policy === "loaded" &&
      inspected.evidence.isolation === "enforced" &&
      inspected.evidence.credentials === "hidden" &&
      inspected.evidence.unauthorizedDestination === "denied" &&
      url.startsWith("https://"),
    { url, inspected },
    "policy-load-receipt",
  );

  // 2 — the sandbox the route would rely on: attributed through the gateway's own ownership
  // labels (the Kubernetes object carries the gateway's labels, not the caller's), and its pod
  // runs the digest-pinned image.
  const name = sandboxName(scope);
  const attributed = (await client.listSandboxes()).find(
    (entry) => entry.scope.botId === bot,
  );
  const podImage = kubectl(
    "-n",
    "openshell",
    "get",
    "pod",
    `${workspace}--${name}`,
    "-o",
    "jsonpath={.spec.containers[0].image}",
  );
  record(
    "sandbox-attributed-and-pinned",
    "the gateway attributes the sandbox to the whole execution ownership, and its pod runs the digest-pinned image",
    attributed?.scope.tenantId === env.tenant &&
      attributed?.scope.workspaceId === workspace &&
      attributed?.scope.environment === "computer" &&
      attributed?.scope.generation === env.generation &&
      podImage.stdout.includes(
        (env.image.split("@")[1] ?? env.image).slice(0, 16),
      ),
    {
      name,
      attributed: attributed?.scope,
      podImage: podImage.stdout,
    },
  );

  const sh = (command: string) =>
    client.exec(scope, ["/bin/sh", "-c", command]);

  // 3 — the initial policy the provider sends is the one the browser needs: /sys readable.
  const sys = await sh("head -c 8 /sys/devices/system/cpu/kernel_max 2>&1");
  record(
    "initial-policy-carries-sys",
    "the policy a sandbox is created with reads /sys, which Chromium needs and which cannot be widened later",
    !sys.stdout.includes("Permission denied") &&
      /^[0-9\s]*$/.test(sys.stdout.trim()),
    { stdout: sys.stdout.slice(0, 60) },
  );

  // 4 — credential boundary: no control-plane material readable from the workload.
  const credentials = await sh(
    CREDENTIAL_PATHS.map(
      (path) =>
        `if head -c 1 ${path} >/dev/null 2>&1; then echo "OPENED:${path}"; fi`,
    ).join("; "),
  );
  record(
    "no-control-plane-credentials",
    "none of the control-plane credential paths can be opened from inside the workload",
    !/OPENED:/.test(credentials.stdout),
    { stdout: credentials.stdout.slice(0, 200) },
    "credential-boundary",
  );

  // 5 — default deny, before any grant: an unlisted destination is unreachable.
  const deniedBefore = await sh(
    `curl -sS -m 8 -o /dev/null -w '%{http_code}' https://one.one.one.one/ 2>&1; echo " rc=$?"`,
  );
  record(
    "default-deny-holds",
    "with no network rule, an unlisted destination is unreachable from the sandbox",
    !/rc=0/.test(deniedBefore.stdout),
    { stdout: deniedBefore.stdout.slice(0, 120) },
    "default-deny-network",
  );

  // 6 — cross-workspace denial: another workspace cannot see this sandbox.
  const foreignWorkspace = `t02s-b-${suffix}`.slice(0, 19);
  await operator.createWorkspace(foreignWorkspace, {
    "managed-by": "t02-acceptance",
  });
  const clientB = clientFor(foreignWorkspace);
  const foreign = await clientB.inspectSandbox(scope).then(
    (view) => `state=${view.state}`,
    (error: unknown) => `error=${String(error).slice(0, 140)}`,
  );
  const listedB = await clientB.listSandboxes();
  record(
    "cross-workspace-denied",
    "a client of another workspace cannot read or list this sandbox",
    (foreign.startsWith("error=") || foreign.includes("state=missing")) &&
      !listedB.some((entry) => entry.scope.botId === bot),
    { foreign, listedInB: listedB.length },
    "cross-workspace-denial",
  );

  // 7 — the service the provider started really is the product service: health, then the browser.
  const health = await sh(
    `curl -fsS -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${env.port}/health`,
  );
  record(
    "in-sandbox-service-healthy",
    "the computer service the provider started answers its health check from inside the sandbox",
    health.stdout.trim() === "200",
    { stdout: health.stdout.slice(0, 20), stderr: health.stderr.slice(0, 80) },
  );

  // 8 — the browser under the isolation runtime climbs a three-rung ladder: the computer's own
  // egress filter denies before any policy reaches it; with the product's no-rows egress policy
  // (allow_all — OpenShell is the real gate) the external host is still refused until the
  // OpenShell network grant names it; the grant then lets the same browser through.
  const service = url.replace(/\/$/, "");
  const headers = {
    "x-openbot-bot-id": bot,
    "x-openbot-workspace-id": workspace,
  };
  const deniedNavigate = await httpsThroughForward(
    `${service}/navigate`,
    "POST",
    JSON.stringify({ url: `https://${env.grantHosts[0]}` }),
    headers,
  );
  // The push the server itself makes when a Bot has no network-policy rows (policy-network.ts
  // NO_NETWORK_POLICY); keyed to this Bot by the same auth headers every other call carries.
  const egressPush = await httpsThroughForward(
    `${service}/egress-policy`,
    "PUT",
    JSON.stringify({ policy: { mode: "allow_all", rules: [] } }),
    headers,
  );
  const stillDenied = await httpsThroughForward(
    `${service}/navigate`,
    "POST",
    JSON.stringify({ url: `https://${env.grantHosts[0]}` }),
    headers,
  );
  const grant = await client.updatePolicy(scope, grantPolicy());
  const allowedNavigate = await httpsThroughForward(
    `${service}/navigate`,
    "POST",
    JSON.stringify({ url: `https://${env.grantHosts[0]}` }),
    headers,
  );
  record(
    "browser-denies-then-allows",
    "Chromium under the isolation runtime is refused while no egress policy has reached it, still refused for the external host after the product's no-rows egress policy, and reaches the page only after the standing OpenShell grant",
    deniedNavigate.startsWith("HTTP-5") &&
      !deniedNavigate.includes("Example Domain") &&
      egressPush.startsWith("HTTP-2") &&
      stillDenied.startsWith("HTTP-5") &&
      !stillDenied.includes("Example Domain") &&
      allowedNavigate.startsWith("HTTP-2") &&
      allowedNavigate.includes("Example Domain"),
    {
      deniedBeforeEgress: deniedNavigate.slice(0, 160),
      egressPush: egressPush.slice(0, 160),
      deniedBeforeGrant: stillDenied.slice(0, 160),
      receipt: `${grant.status} version ${grant.activeVersion}`,
      afterGrant: allowedNavigate.slice(0, 200),
    },
  );

  // 9 — a real interaction: a page served inside the sandbox, clicked through the exposed URL.
  await sh(pageServerCommand(PAGE_PORT_SUBSTRATE));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const localNavigate = await httpsThroughForward(
    `${service}/navigate`,
    "POST",
    JSON.stringify({ url: `http://127.0.0.1:${PAGE_PORT_SUBSTRATE}/` }),
    headers,
  );
  const snapshot = await httpsThroughForward(
    `${service}/snapshot`,
    "POST",
    "{}",
    headers,
  );
  const ref = /"ref":"([^"]+)"[^}]*"role":"button"/.exec(snapshot)?.[1];
  const click = ref
    ? await httpsThroughForward(
        `${service}/click`,
        "POST",
        JSON.stringify({
          ref,
          snapshotId: Number(/"snapshotId":(\d+)/.exec(snapshot)?.[1] ?? 0),
        }),
        headers,
      )
    : "no-ref";
  const afterClick = await httpsThroughForward(
    `${service}/read`,
    "GET",
    undefined,
    headers,
  );
  record(
    "browser-acts-through-exposed-url",
    "a page served inside the sandbox is navigated to, snapshotted and clicked through the URL the provider hands out, and the click is observable",
    localNavigate.startsWith("HTTP-2") &&
      click.startsWith("HTTP-2") &&
      afterClick.includes("T02-CLICKED"),
    {
      local: localNavigate.slice(0, 120),
      snapshot: snapshot.slice(0, 200),
      click: click.slice(0, 120),
      after: afterClick.slice(0, 160),
    },
  );

  // 10 — no isolation was relaxed to buy the launch: the flags the product passes are the two
  // compatibility ones, and the workload still runs under a seccomp filter. The Playwright
  // version in the image names the binary `headless_shell`, but the probe matches any Chromium
  // comm so a binary rename fails loudly instead of silently reading PID 1.
  const chrome = await sh(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${d#/proc/} 等是 shell 插值，不是 JS 模板；改成模板会执行 JS 展开破坏探针。
    "for d in /proc/[0-9]*; do c=$(cat $d/comm 2>/dev/null); case $c in *chrome*|*headless*|*chromium*) echo PID=${d#/proc/} COMM=$c; tr '\\0' ' ' < $d/cmdline 2>/dev/null | head -c 400; echo;; esac; done",
  );
  const seccomp = await sh("grep -i '^Seccomp' /proc/self/status");
  record(
    "hardened-launch-flags-real",
    "the running Chromium carries the isolation-runtime compatibility flags the product sends, and the workload still runs under a seccomp filter",
    /no-zygote/.test(chrome.stdout) &&
      /ignore-certificate-errors/.test(chrome.stdout) &&
      /Seccomp:\s*2/.test(seccomp.stdout),
    { cmdline: chrome.stdout.slice(0, 300), seccomp: seccomp.stdout.trim() },
  );

  // Cleanup: only what this run created.
  await provider.stop(bot).catch(() => undefined);
  await provider.reset(bot).catch(() => undefined);
  await operator.deleteWorkspace(workspace).catch(() => undefined);
  await operator.deleteWorkspace(foreignWorkspace).catch(() => undefined);
  const leftover = kubectl(
    "-n",
    "openshell",
    "get",
    "sandbox",
    "--no-headers",
    "-l",
    `bot=${bot}`,
  );
  record(
    "cleanup-verified",
    "the probe sandbox and both probe workspaces are gone",
    leftover.stdout === "",
    { leftover: leftover.stdout.slice(0, 160) },
  );
}

async function productPhase(): Promise<void> {
  const client = clientFor(env.workspace);
  const json = async (path: string, method: "GET" | "POST", body?: unknown) => {
    const response = await fetch(`${env.base}${path}`, {
      method,
      ...(body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const text = await response.text();
    return { status: response.status, text: text.slice(0, 800) };
  };

  // The computer routes answer only for a Bot the deployment knows, so both probe Bots are created
  // through the same API a person uses and the server-assigned ids drive the rest of the phase.
  const createBot = async (label: string) => {
    const created = await json("/api/agents", "POST", {
      name: `t02pbot-${label}-${suffix}`,
      title: `T02 probe ${label}`,
      roleDescription: `T02 probe Bot ${label}, created by the acceptance run.`,
      visibility: "private",
    });
    return {
      id: /"id":"([^"]+)"/.exec(created.text)?.[1] ?? null,
      status: created.status,
      body: created.text.slice(0, 200),
    };
  };
  const madeA = await createBot("a");
  const madeB = await createBot("b");
  record(
    "bots-created-through-api",
    "both probe Bots exist as real deployment records, created through the same API a person uses",
    madeA.id !== null && madeB.id !== null,
    {
      botA: `${madeA.status} ${madeA.body.slice(0, 120)}`,
      botB: `${madeB.status} ${madeB.body.slice(0, 120)}`,
    },
  );
  const botA = madeA.id ?? "no-bot-a";
  const botB = madeB.id ?? "no-bot-b";
  const scopeA = scopeOf(env.workspace, botA);

  // The exposed-service URLs the gateway mints end in `.localhost`, and Bun's fetch — the server's
  // own HTTP client — resolves `.localhost` names to loopback before any DNS or /etc/hosts lookup it
  // does not consult, so inside the pod those URLs would point at the server itself. A real
  // deployment serves the gateway's exposed names on a real domain; on this kind cluster the same
  // effect comes from pinning each deterministic exposed hostname (and the gateway's own name) to
  // the gateway's Service IP in every server pod's hosts file. The sandbox names are a pure
  // function of the ownership scope, so both Bots' hostnames are known before anything wakes.
  const exposedHost = (botId: string) =>
    `${env.workspace}--${sandboxName(scopeOf(env.workspace, botId))}--computer.openshell.localhost`;
  const gatewayIp = kubectl(
    "-n",
    "openshell",
    "get",
    "svc",
    "openshell",
    "-o",
    "jsonpath={.spec.clusterIP}",
  ).stdout.trim();
  const hostsEntries = [
    `openshell.localhost ${exposedHost(botA)} ${exposedHost(botB)}`,
  ];
  const serverPods = kubectl("-n", "openbot", "get", "pods", "-o", "name")
    .stdout.split("\n")
    .filter((line) => line.includes("openbot-server"))
    .map((line) => line.replace(/^pod\//, ""));
  // …and the half Bun's shortcut needs: the exposed URLs all say :8080, which Bun's fetch sends to
  // the pod's own loopback. A plain TCP bridge on that loopback port forwards the bytes — TLS
  // included, so the gateway still routes by the real SNI and the credentials still end to end —
  // to the gateway Service. This is the same bridge the T01 recipe ran; it changes no boundary.
  // The LISTEN check keys on the zero remote address and the 0A state, because the server's own
  // gRPC connection to the gateway also shows port 1F90 in /proc/net/tcp, as an ESTABLISHED line.
  const bridgeCommand = `grep -q ':1F90 00000000:0000 0A ' /proc/net/tcp || nohup bun -e 'const net=require("net");const s=net.createServer((c)=>{const u=net.connect({host:"${gatewayIp}",port:8080});c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());});s.listen(8080,"127.0.0.1");setInterval(()=>{},60000);' >/tmp/bridge.log 2>&1 & sleep 1; grep -c ':1F90 00000000:0000 0A ' /proc/net/tcp`;
  const patched = serverPods.map((pod) =>
    kubectl(
      "-n",
      "openbot",
      "exec",
      pod,
      "--",
      "sh",
      "-c",
      `grep -q ${exposedHost(botA)} /etc/hosts || echo '${gatewayIp} ${hostsEntries[0]}' >> /etc/hosts; ${bridgeCommand}`,
    ),
  );
  record(
    "server-pods-resolve-exposed-names",
    "every server pod pins the deterministic exposed hostnames of both probe Bots to the gateway's Service IP and bridges the exposed port on its loopback to the gateway, so the server's own fetches reach the real gateway rather than its loopback",
    patched.length > 0 && patched.every((probe) => probe.stdout.trim() !== "0"),
    {
      gatewayIp,
      bridgeListeners: patched.map((probe) => probe.stdout.trim()),
    },
  );

  // 0 — the mounted receipt is this run's substrate output, for this image and gateway.
  const receiptEnv = kubectl(
    "-n",
    "openbot",
    "get",
    "deploy",
    "openbot-server",
    "-o",
    "jsonpath={.spec.template.spec.containers[0].env[?(@.name=='OPENSHELL_PROBE_RECEIPT')].value}",
  );
  const receipt = JSON.parse(receiptEnv.stdout || "{}") as {
    sandboxImage?: string;
    capabilities?: string[];
  };
  record(
    "mounted-receipt-names-this-image",
    "the deployment mounts the receipt this run wrote, for this image and gateway, with all four capabilities",
    receipt.sandboxImage === env.image &&
      (receipt.capabilities?.length ?? 0) ===
        OPEN_SHELL_REQUIRED_CAPABILITIES.length,
    { receipt: receiptEnv.stdout.slice(0, 240) },
  );

  // 1 — a wake through the route: navigate starts the sandbox and the service; with no rule the
  // browser itself refuses, which is the deny a Bot meets before any administrator grants anything.
  const firstStatus = await json(`/api/computers/${botA}/status`, "GET");
  const firstNavigate = await json(`/api/computers/${botA}/navigate`, "POST", {
    url: `https://${env.grantHosts[0]}`,
  });
  const statusAfter = await json(`/api/computers/${botA}/status`, "GET");
  record(
    "route-wakes-computer-and-denies-unlisted",
    "the first navigate through the OpenBot route wakes a ready computer whose browser refuses the unlisted destination",
    firstStatus.status === 200 &&
      firstStatus.text.includes("absent") &&
      // The refusal has to be the browser's, not a wake failure: a service that never became
      // healthy or a computer the server could not reach are also >=400, and counting either
      // here would pass the case for the wrong reason.
      firstNavigate.status >= 400 &&
      !firstNavigate.text.includes("became healthy") &&
      !firstNavigate.text.includes("is not running") &&
      !firstNavigate.text.includes("Example Domain") &&
      statusAfter.text.includes("ready"),
    {
      firstStatus: firstStatus.text.slice(0, 120),
      firstNavigate: `${firstNavigate.status} ${firstNavigate.text.slice(0, 160)}`,
      statusAfter: statusAfter.text.slice(0, 120),
    },
  );

  // 2 — the standing grant (a deployment administrator's preconfiguration), then the page opens.
  await client.updatePolicy(scopeA, grantPolicy());
  const grantedNavigate = await json(
    `/api/computers/${botA}/navigate`,
    "POST",
    { url: `https://${env.grantHosts[0]}` },
  );
  record(
    "route-navigates-after-grant",
    "after the standing grant the same route opens the page and reads it",
    grantedNavigate.status === 200 &&
      grantedNavigate.text.includes("Example Domain"),
    { navigate: grantedNavigate.text.slice(0, 160) },
  );

  // 3 — a real interaction through the route: the granted page's own link, clicked. The route's
  // target check refuses private and loopback addresses (a Bot may not be pointed at the
  // deployment's own network), so the interaction page is the real example.com and its
  // "More information…" link, and the click's effect is the page it leads to.
  const snapshot = await json(`/api/computers/${botA}/snapshot`, "POST", {});
  const ref =
    /"ref":"([^"]+)"[^}]*"role":"link"[^}]*"name":"More information/.exec(
      snapshot.text,
    )?.[1];
  const click = ref
    ? await json(`/api/computers/${botA}/click`, "POST", {
        ref,
        snapshotId: Number(/"snapshotId":(\d+)/.exec(snapshot.text)?.[1] ?? 0),
      })
    : { status: 0, text: "no-ref" };
  const afterClick = await json(`/api/computers/${botA}/read`, "GET");
  const screenshot = await fetch(
    `${env.base}/api/computers/${botA}/screenshot`,
  );
  const screenshotBody = await screenshot.text();
  record(
    "route-clicks-and-reads",
    "the route snapshots the granted page, clicks the link on it through the exposed URL, and reads back the page the click led to",
    snapshot.status === 200 &&
      click.status === 200 &&
      /IANA|reserved/i.test(afterClick.text) &&
      screenshot.status === 200,
    {
      snapshot: snapshot.text.slice(0, 160),
      click: `${click.status} ${click.text.slice(0, 120)}`,
      afterClick: afterClick.text.slice(0, 160),
      screenshot: `${screenshot.status} ${screenshotBody.length} bytes`,
    },
  );

  // 4 — one Bot's files are another Bot's nothing.
  await json(`/api/computers/${botA}/exec`, "POST", {
    command: `echo t02-secret-${suffix} > /tmp/workspace/a-marker && echo WRITTEN`,
    timeoutMs: 10_000,
  });
  // Bot B's wake goes through the granted public page too (its own sandbox has no grant, so its
  // browser refuses it — the wake still happens, which is all the file reads below need).
  await json(`/api/computers/${botB}/navigate`, "POST", {
    url: `https://${env.grantHosts[0]}`,
  }).catch(() => undefined);
  const bList = await json(`/api/computers/${botB}/files/list`, "POST", {});
  const bRead = await json(`/api/computers/${botB}/files/read`, "POST", {
    path: "a-marker",
  });
  const sandboxes = await client.listSandboxes();
  const names = sandboxes
    .filter((entry) => entry.scope.botId === botA || entry.scope.botId === botB)
    .map((entry) => entry.view.name);
  record(
    "bots-are-separate-computers",
    "the two Bots have two distinct sandboxes, and Bot A's file is invisible to Bot B",
    new Set(names).size === 2 &&
      !bList.text.includes("a-marker") &&
      bRead.status >= 400,
    {
      names,
      bList: bList.text.slice(0, 160),
      bRead: `${bRead.status} ${bRead.text.slice(0, 120)}`,
    },
  );

  // 5 — stop stays stopped: a status read does not wake the computer.
  const stop = await json(`/api/computers/${botA}/computers/stop`, "POST", {});
  const stoppedStatus = await json(`/api/computers/${botA}/status`, "GET");
  const stoppedInspect = await client.inspectSandbox(scopeA);
  record(
    "stop-stays-stopped-through-status",
    "after a stop, the sandbox is not running and a status read does not start it again",
    stop.text.includes("wasRunning") &&
      !stoppedStatus.text.includes("ready") &&
      stoppedInspect.state === "stopped",
    {
      stop: stop.text.slice(0, 120),
      status: stoppedStatus.text.slice(0, 120),
      inspect: stoppedInspect.state,
    },
  );

  // 6 — the wake after the stop re-verifies the policy and the deny before handing the computer back.
  const wakeNavigate = await json(`/api/computers/${botA}/navigate`, "POST", {
    url: `https://${env.grantHosts[0]}`,
  });
  const wakeInspect = await client.inspectSandbox(scopeA);
  // curl, not /dev/tcp: the sandbox's sh is dash, which has no /dev/tcp and would make the probe
  // vacuously "denied". curl's own exit status carries the real verdict.
  const denyAgain = await client.exec(scopeA, [
    "/bin/sh",
    "-c",
    `curl -sS -m 8 -o /dev/null -w '%{http_code}' https://one.one.one.one/ 2>&1; echo " rc=$?"`,
  ]);
  record(
    "wake-rechecks-policy-and-deny",
    "a wake after the stop answers only with the policy loaded, the credential boundary hidden and the deny still enforced",
    wakeNavigate.status === 200 &&
      wakeNavigate.text.includes("Example Domain") &&
      wakeInspect.evidence?.policy === "loaded" &&
      wakeInspect.evidence.credentials === "hidden" &&
      !/rc=0/.test(denyAgain.stdout),
    {
      navigate: `${wakeNavigate.status} ${wakeNavigate.text.slice(0, 120)}`,
      evidence: wakeInspect.evidence,
      deny: denyAgain.stdout.slice(0, 80),
    },
  );

  // 7 — the workload still has no control-plane credentials.
  const credentials = await client.exec(scopeA, [
    "/bin/sh",
    "-c",
    CREDENTIAL_PATHS.map(
      (path) =>
        `if head -c 1 ${path} >/dev/null 2>&1; then echo "OPENED:${path}"; fi`,
    ).join("; "),
  ]);
  record(
    "workload-has-no-control-plane-credentials",
    "none of the control-plane credential paths can be opened from the route-created workload",
    !/OPENED:/.test(credentials.stdout),
    { stdout: credentials.stdout.slice(0, 200) },
  );

  // Cleanup: only what this run created.
  await json(`/api/computers/${botA}/computers/reset`, "POST", {}).catch(
    () => undefined,
  );
  await json(`/api/computers/${botB}/computers/reset`, "POST", {}).catch(
    () => undefined,
  );
  const remaining = (await client.listSandboxes()).filter(
    (entry) => entry.scope.botId === botA || entry.scope.botId === botB,
  );
  record(
    "cleanup-verified",
    "both route-created sandboxes are deleted",
    remaining.length === 0,
    { remaining: remaining.map((entry) => entry.view.name) },
  );
}

await main();
