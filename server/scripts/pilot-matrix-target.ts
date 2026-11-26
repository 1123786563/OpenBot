/**
 * Target descriptor and product-entry driver for the #98 pilot matrix (#158).
 *
 * The matrix used to hardcode the local ports, gateway image and provider key
 * path. This module reads them from the environment so the same matrix can be
 * pointed at an approved independent deployment, and it drives that target
 * through its product HTTP entries instead of reaching into a local ledger:
 *
 *   - `<entry>/v1/*` is the Test Credit product entry (quote, reserve, dispatch,
 *     reconcile) plus the account routes (balance, operations, authorizations).
 *   - `<weknora>/embeddings` is the WeKnora product entry.
 *   - `<accountStatus>/workspaces/:id/suspension` is the #69 account-status /
 *     Workspace-Suspension entry.
 *
 * `PILOT_EVIDENCE=deployment` names an independent target: the product entry,
 * its credential and the deployment's provenance must all be supplied, and a
 * loopback entry is refused. The default `fixture` mode keeps the local
 * deployment the old constants assumed.
 */
import { z } from "zod";

const required = z.string().trim().min(1);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const url = z.url().transform((value) => new URL(value));

const localDefaults = {
  gatewayUrl: "http://127.0.0.1:32790/v1/chat/completions",
  embeddingUrl: "http://127.0.0.1:25170/v1/embeddings",
  tokenizerUrl: "http://127.0.0.1:25169/tokenize",
  gatewayRevision: "matrix-fixed6-3skfs9",
  meteringRevision: "matrix-zhipu-tokenizer",
  lagoUrl: "http://127.0.0.1:32832",
  weknoraUrl: "http://127.0.0.1:25172/api/weknora",
  accountStatusUrl: "http://127.0.0.1:25172/operator",
} as const;

const loopback = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export type PilotTarget = {
  evidence: "fixture" | "deployment";
  gateway: { url: string; revision: string; meteringRevision: string };
  embedding: { url: string };
  tokenizer: { url: string };
  lago: { url: string };
  entry: { url: string; token: string } | undefined;
  // The target's WeKnora product entry (ingestion / post-signout work).
  weknora: { url: string } | undefined;
  // The target's account-status / Workspace-Suspension entry (#69).
  accountStatus: { url: string; workspaceId: string } | undefined;
  deployment:
    | { id: string; buildVersion: string; imageDigest: string }
    | undefined;
};

export function loadPilotTarget(
  environment: Record<string, string | undefined>,
): PilotTarget {
  const mode = environment.PILOT_EVIDENCE?.trim() || "fixture";
  if (mode !== "fixture" && mode !== "deployment")
    throw new Error("Invalid PILOT_EVIDENCE mode.");

  const targetUrl = environment.PILOT_TARGET_URL?.trim();
  const targetToken = environment.PILOT_TARGET_TOKEN?.trim();
  if (Boolean(targetUrl) !== Boolean(targetToken))
    throw new Error("The pilot target needs both a URL and a credential.");

  const parsedUrl = targetUrl && url.safeParse(targetUrl);
  if (parsedUrl && !parsedUrl.success)
    throw new Error("Invalid PILOT_TARGET_URL.");

  const entry =
    targetUrl && targetToken
      ? { url: targetUrl, token: targetToken }
      : undefined;

  const gatewayUrl =
    environment.PILOT_GATEWAY_URL?.trim() || localDefaults.gatewayUrl;
  const gatewayRevision =
    environment.PILOT_GATEWAY_REVISION?.trim() || localDefaults.gatewayRevision;
  const meteringRevision =
    environment.PILOT_METERING_REVISION?.trim() ||
    localDefaults.meteringRevision;
  const workspaceId = environment.PILOT_WORKSPACE_ID?.trim();

  if (mode === "fixture")
    return {
      evidence: "fixture",
      gateway: { url: gatewayUrl, revision: gatewayRevision, meteringRevision },
      embedding: {
        url:
          environment.PILOT_EMBEDDING_URL?.trim() || localDefaults.embeddingUrl,
      },
      tokenizer: {
        url:
          environment.PILOT_TOKENIZER_URL?.trim() || localDefaults.tokenizerUrl,
      },
      lago: {
        url: environment.PILOT_LAGO_URL?.trim() || localDefaults.lagoUrl,
      },
      entry,
      weknora: {
        url: environment.PILOT_WEKNORA_URL?.trim() || localDefaults.weknoraUrl,
      },
      accountStatus: {
        url:
          environment.PILOT_ACCOUNT_STATUS_URL?.trim() ||
          localDefaults.accountStatusUrl,
        workspaceId: workspaceId || "fixture-workspace",
      },
      deployment: undefined,
    };

  if (!entry) throw new Error("A deployment target needs a product entry.");
  if (loopback.has(new URL(entry.url).hostname))
    throw new Error("A deployment target must not be a loopback entry.");
  if (
    !environment.PILOT_GATEWAY_URL?.trim() ||
    !environment.PILOT_GATEWAY_REVISION?.trim()
  )
    throw new Error("A deployment target needs its gateway URL and revision.");

  const deployment = z
    .object({
      PILOT_DEPLOYMENT_ID: required,
      PILOT_BUILD_VERSION: required,
      PILOT_IMAGE_DIGEST: digest,
    })
    .safeParse(environment);
  if (!deployment.success)
    throw new Error("A deployment target needs its deployment provenance.");

  const weknoraUrl = environment.PILOT_WEKNORA_URL?.trim();
  const accountStatusUrl = environment.PILOT_ACCOUNT_STATUS_URL?.trim();
  return {
    evidence: "deployment",
    gateway: { url: gatewayUrl, revision: gatewayRevision, meteringRevision },
    embedding: {
      url:
        environment.PILOT_EMBEDDING_URL?.trim() || localDefaults.embeddingUrl,
    },
    tokenizer: {
      url:
        environment.PILOT_TOKENIZER_URL?.trim() || localDefaults.tokenizerUrl,
    },
    lago: { url: environment.PILOT_LAGO_URL?.trim() || localDefaults.lagoUrl },
    entry,
    weknora: weknoraUrl ? { url: weknoraUrl } : undefined,
    accountStatus:
      accountStatusUrl && workspaceId
        ? { url: accountStatusUrl, workspaceId }
        : undefined,
    deployment: {
      id: deployment.data.PILOT_DEPLOYMENT_ID,
      buildVersion: deployment.data.PILOT_BUILD_VERSION,
      imageDigest: deployment.data.PILOT_IMAGE_DIGEST,
    },
  };
}

type Json = Record<string, unknown>;
type Fetch = typeof fetch;

function entryOf(target: PilotTarget) {
  if (!target.entry) throw new Error("The pilot target has no product entry.");
  return {
    base: target.entry.url.replace(/\/+$/, ""),
    headers: (token?: string) => ({
      authorization: `Bearer ${token ?? target.entry?.token}`,
      "content-type": "application/json",
    }),
  };
}

async function json(response: Response, what: string): Promise<Json> {
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok || typeof body !== "object" || body === null)
    throw new Error(`Pilot target ${what} failed: ${response.status}`);
  return body as Json;
}

export type PilotChatResult = {
  route: string;
  reservation: { state: string; reason?: string; permit?: string };
  dispatch: { state: string; reason?: string; text?: string } | undefined;
  receipt: Json | undefined;
  usage: { inputTokens: number; outputTokens: number };
};

/** `GET /v1/quote`: the target's published default route and price version. */
export async function pilotQuoteEntry(
  target: PilotTarget,
  fetchImpl: Fetch = fetch,
): Promise<{ route: string; priceVersion: string }> {
  const { base, headers } = entryOf(target);
  const quote = await json(
    await fetchImpl(`${base}/v1/quote`, { headers: headers() }),
    "quote",
  );
  if (typeof quote.route !== "string" || typeof quote.priceVersion !== "string")
    throw new Error("The pilot target returned no model quote.");
  return { route: quote.route, priceVersion: quote.priceVersion };
}

/**
 * Replays one chat operation through the target's product entry: quote,
 * reserve, dispatch and reconcile. `route` reserves a named published route so
 * the model-switch leg moves between them; nothing here reads a local ledger.
 */
export async function pilotChatEntry(
  target: PilotTarget,
  input: {
    operationId: string;
    prompt: string;
    route?: string;
    token?: string;
  },
  fetchImpl: Fetch = fetch,
): Promise<PilotChatResult> {
  const { base, headers } = entryOf(target);
  const auth = headers(input.token);
  const quoted = await pilotQuoteEntry(target, fetchImpl);
  const route = input.route ?? quoted.route;
  const reservation = (await json(
    await fetchImpl(`${base}/v1/reserve`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        operationId: input.operationId,
        route,
        priceVersion: quoted.priceVersion,
        creditType: "test",
        applicationId: "openbot",
      }),
    }),
    "reserve",
  )) as PilotChatResult["reservation"];
  if (reservation.state !== "reserved")
    return {
      route,
      reservation,
      dispatch: undefined,
      receipt: undefined,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  if (!reservation.permit)
    throw new Error("The pilot target reserved without a permit.");
  const dispatched = await json(
    await fetchImpl(`${base}/v1/dispatch`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        operationId: input.operationId,
        permit: reservation.permit,
        messages: [{ role: "user", content: input.prompt }],
      }),
    }),
    "dispatch",
  );
  const operated = dispatched.operation as Json | undefined;
  const reconciled = await json(
    await fetchImpl(`${base}/v1/reconcile`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ operationId: input.operationId }),
    }),
    "reconcile",
  );
  const receipt = (reconciled.operation as Json | undefined) ?? operated;
  return {
    route,
    reservation,
    dispatch: {
      state: String(dispatched.state ?? "unknown"),
      reason:
        typeof dispatched.reason === "string" ? dispatched.reason : undefined,
      text: typeof dispatched.text === "string" ? dispatched.text : undefined,
    },
    receipt,
    usage: {
      inputTokens: Number(operated?.inputTokens ?? 0),
      outputTokens: Number(operated?.outputTokens ?? 0),
    },
  };
}

/** `POST /v1/reserve`, exposed so the concurrent-budget leg races the entry. */
export async function pilotReserveEntry(
  target: PilotTarget,
  input: {
    operationId: string;
    route: string;
    priceVersion: string;
    token?: string;
  },
  fetchImpl: Fetch = fetch,
) {
  const { base, headers } = entryOf(target);
  const body = await json(
    await fetchImpl(`${base}/v1/reserve`, {
      method: "POST",
      headers: headers(input.token),
      body: JSON.stringify({
        operationId: input.operationId,
        route: input.route,
        priceVersion: input.priceVersion,
        creditType: "test",
        applicationId: "openbot",
      }),
    }),
    "reserve",
  );
  return body as { state: string; reason?: string; permit?: string };
}

/** `POST /v1/dispatch` with a caller-chosen permit, to prove refusals. */
export async function pilotDispatchEntry(
  target: PilotTarget,
  input: {
    operationId: string;
    permit: string;
    prompt: string;
    token?: string;
  },
  fetchImpl: Fetch = fetch,
) {
  const { base, headers } = entryOf(target);
  const body = await json(
    await fetchImpl(`${base}/v1/dispatch`, {
      method: "POST",
      headers: headers(input.token),
      body: JSON.stringify({
        operationId: input.operationId,
        permit: input.permit,
        messages: [{ role: "user", content: input.prompt }],
      }),
    }),
    "dispatch",
  );
  return body as { state: string; reason?: string };
}

function accountHeaders(sessionCookie: string) {
  return { cookie: sessionCookie, "content-type": "application/json" };
}

/** `GET /balance` for the caller's own Billing Account. */
export async function pilotBalanceEntry(
  target: PilotTarget,
  sessionCookie: string,
  fetchImpl: Fetch = fetch,
): Promise<Json> {
  const { base } = entryOf(target);
  return json(
    await fetchImpl(`${base}/balance`, {
      headers: accountHeaders(sessionCookie),
    }),
    "balance",
  );
}

async function pilotBillEntry(
  target: PilotTarget,
  sessionCookie: string,
  fetchImpl: Fetch,
) {
  const { base } = entryOf(target);
  const response = await fetchImpl(`${base}/paid/bill`, {
    headers: accountHeaders(sessionCookie),
  });
  const parsed = z
    .array(
      z.object({
        operationId: z.string().nullish(),
        applicationId: z.string().nullish(),
        source: z.string(),
      }),
    )
    .safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success)
    throw new Error(`Pilot target bill failed: ${response.status}`);
  return parsed.data;
}

/** `GET /operations/:id`: the settled receipt the target holds. */
export async function pilotReceiptEntry(
  target: PilotTarget,
  operationId: string,
  sessionCookie: string,
  fetchImpl: Fetch = fetch,
): Promise<Json> {
  const { base } = entryOf(target);
  return json(
    await fetchImpl(`${base}/operations/${encodeURIComponent(operationId)}`, {
      headers: accountHeaders(sessionCookie),
    }),
    "operation",
  );
}

/**
 * `POST /authorizations`: the person's explicit grant to the WeKnora app, so
 * the ingestion leg runs under a real background Spending Authorization.
 */
export async function pilotAuthorizeEntry(
  target: PilotTarget,
  grant: {
    authorizationId: string;
    applicationId: string;
    kind: "online" | "background";
    taskId?: string;
    resourcePrefix: string;
    expiresAt: string;
    limitMicrocredits: string;
    sessionCookie: string;
  },
  fetchImpl: Fetch = fetch,
): Promise<Json> {
  const { base } = entryOf(target);
  const { sessionCookie, ...body } = grant;
  return json(
    await fetchImpl(`${base}/authorizations`, {
      method: "POST",
      headers: accountHeaders(sessionCookie),
      body: JSON.stringify({ ...body, creditType: "test" }),
    }),
    "authorization",
  );
}

/** `POST /authorizations/:id/revoke`: the person withdraws the grant. */
export async function pilotRevokeEntry(
  target: PilotTarget,
  authorizationId: string,
  sessionCookie: string,
  fetchImpl: Fetch = fetch,
): Promise<Json> {
  const { base } = entryOf(target);
  return json(
    await fetchImpl(
      `${base}/authorizations/${encodeURIComponent(authorizationId)}/revoke`,
      { method: "POST", headers: accountHeaders(sessionCookie), body: "{}" },
    ),
    "revocation",
  );
}

export type PilotWeKnoraResult = {
  status: number;
  body: (Json & { vectors?: unknown; receipt?: unknown }) | undefined;
};

/** `POST <weknora>/embeddings`: WeKnora ingestion through the target entry. */
export async function pilotWeKnoraEntry(
  target: PilotTarget,
  input: {
    serviceToken: string;
    subject: string;
    authorizationId: string;
    resourceId: string;
    operationId: string;
    input: string[];
  },
  fetchImpl: Fetch = fetch,
): Promise<PilotWeKnoraResult> {
  if (!target.weknora)
    throw new Error("The pilot target has no WeKnora entry.");
  const response = await fetchImpl(
    `${target.weknora.url.replace(/\/+$/, "")}/embeddings`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: input.subject,
        authorizationId: input.authorizationId,
        resourceId: input.resourceId,
        operationId: input.operationId,
        input: input.input,
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const body = (await response.json().catch(() => undefined)) as unknown;
  return {
    status: response.status,
    body:
      typeof body === "object" && body !== null
        ? (body as PilotWeKnoraResult["body"])
        : undefined,
  };
}

/**
 * `POST <accountStatus>/workspaces/:id/suspension`: drives the target's #69
 * account-status / Workspace-Suspension path. A real deployment maps this to
 * the upstream Casdoor disablement; the fixture maps it onto the ledger's
 * suspension flag.
 */
export async function pilotSuspensionEntry(
  input: {
    url: string;
    token: string;
    workspaceId: string;
  },
  action: "pause" | "resume",
  reason: string,
  fetchImpl: Fetch = fetch,
): Promise<Json> {
  return json(
    await fetchImpl(
      `${input.url.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(input.workspaceId)}/suspension`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action, reason }),
      },
    ),
    "suspension",
  );
}

export type PilotLegResult =
  | { scenario: string; outcome: "pass"; detail: Json }
  | { scenario: string; outcome: "fail"; error: string };

/**
 * The routing the matrix script uses against a product entry. Every leg the
 * #98 criterion enumerates is driven over HTTP; the caller only supplies the
 * target and the pre-provisioned credentials/route names.
 */
export type PilotLegContext = {
  target: PilotTarget;
  fetchImpl?: Fetch;
  tokens: { A: string; B: string; C: string };
  sessionCookies: { A: string; B: string; C: string };
  routes: { A: string; B: string };
  // Service credential, uploader subject and resource for the WeKnora legs.
  weknora?: {
    serviceToken: string;
    subject: string;
    resourceId: string;
    // Set when the run itself creates the grant over the product entry.
    createGrant: boolean;
  };
  suspension?: { token: string; workspaceId: string };
  clock?: () => number;
};

function assertLeg(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function runPilotTargetLegs(
  context: PilotLegContext,
): Promise<PilotLegResult[]> {
  const { target, routes, tokens, sessionCookies } = context;
  const fetchImpl = context.fetchImpl ?? fetch;
  const clock = context.clock ?? Date.now;
  const results: PilotLegResult[] = [];
  const runId = crypto.randomUUID();
  const operation = (name: string) => `matrix-${runId}-${name}`;
  const leg = async (scenario: string, work: () => Promise<Json>) => {
    try {
      results.push({ scenario, outcome: "pass", detail: await work() });
    } catch (error) {
      results.push({
        scenario,
        outcome: "fail",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await leg("target-model-switch", async () => {
    const quoted = await pilotQuoteEntry(target, fetchImpl);
    const first = await pilotChatEntry(
      target,
      {
        operationId: operation("switch-a"),
        prompt: "route one",
        route: routes.A,
        token: tokens.A,
      },
      fetchImpl,
    );
    const second = await pilotChatEntry(
      target,
      {
        operationId: operation("switch-b"),
        prompt: "route two",
        route: routes.B,
        token: tokens.A,
      },
      fetchImpl,
    );
    assertLeg(
      first.dispatch?.state === "completed",
      `route A: ${first.dispatch?.state ?? first.reservation.state}`,
    );
    assertLeg(
      second.dispatch?.state === "completed",
      `route B: ${second.dispatch?.state ?? second.reservation.state}`,
    );
    assertLeg(first.receipt?.route === routes.A, "route A was not recorded");
    assertLeg(second.receipt?.route === routes.B, "route B was not recorded");
    return {
      operationIds: [operation("switch-a"), operation("switch-b")],
      defaultRoute: quoted.route,
      routeA: first.receipt?.route,
      routeB: second.receipt?.route,
    };
  });

  await leg("target-cross-app-isolation", async () => {
    const before = await pilotBalanceEntry(target, sessionCookies.A, fetchImpl);
    const b = await pilotChatEntry(
      target,
      {
        operationId: operation("isolation-b"),
        prompt: "b account",
        route: routes.A,
        token: tokens.B,
      },
      fetchImpl,
    );
    assertLeg(
      b.dispatch?.state === "completed",
      `B dispatch: ${b.dispatch?.state ?? b.reservation.state}`,
    );
    const after = await pilotBalanceEntry(target, sessionCookies.A, fetchImpl);
    const bBalance = await pilotBalanceEntry(
      target,
      sessionCookies.B,
      fetchImpl,
    );
    assertLeg(
      before.chargedMicrocredits === after.chargedMicrocredits,
      "A was charged for B's operation",
    );
    assertLeg(Number(bBalance.chargedMicrocredits) > 0, "B was not charged");
    const [billA, billB] = await Promise.all([
      pilotBillEntry(target, sessionCookies.A, fetchImpl),
      pilotBillEntry(target, sessionCookies.B, fetchImpl),
    ]);
    assertLeg(
      !billA.some((item) => item.operationId === operation("isolation-b")),
      "A can see B's operation on the bill",
    );
    assertLeg(
      billB.some(
        (item) =>
          item.operationId === operation("isolation-b") &&
          item.applicationId === "openbot" &&
          item.source === "test",
      ),
      "B's bill is missing the OpenBot Test Credit operation",
    );
    return {
      chargedA: after.chargedMicrocredits,
      chargedB: bBalance.chargedMicrocredits,
      operationIds: [operation("isolation-b")],
      receiptB: b.receipt,
    };
  });

  await leg("target-concurrent-budgets", async () => {
    const quoted = await pilotQuoteEntry(target, fetchImpl);
    const attempts = await Promise.all(
      [1, 2, 3, 4].map((n) =>
        pilotReserveEntry(
          target,
          {
            operationId: operation(`race-${n}`),
            route: routes.A,
            priceVersion: quoted.priceVersion,
            token: tokens.C,
          },
          fetchImpl,
        ),
      ),
    );
    const reserved = attempts.filter(({ state }) => state === "reserved");
    const denied = attempts.filter(
      ({ state, reason }) =>
        state === "denied" && reason === "insufficient_credits",
    );
    const balance = await pilotBalanceEntry(
      target,
      sessionCookies.C,
      fetchImpl,
    );
    assertLeg(reserved.length === 2, `reserved ${reserved.length}`);
    assertLeg(denied.length === 2, "denials were not insufficient_credits");
    assertLeg(balance.availableMicrocredits === "0", "leftover availability");
    return { reserved: reserved.length, denied: denied.length, balance };
  });

  await leg("target-failures-refusals", async () => {
    const quoted = await pilotQuoteEntry(target, fetchImpl);
    const forged = await pilotDispatchEntry(
      target,
      {
        operationId: operation("forged"),
        permit: crypto.randomUUID(),
        prompt: "must not dispatch",
        token: tokens.A,
      },
      fetchImpl,
    );
    assertLeg(
      forged.state === "denied" && forged.reason === "not_authorized",
      `forged permit: ${JSON.stringify(forged)}`,
    );
    const unknown = await pilotReserveEntry(
      target,
      {
        operationId: operation("unknown-route"),
        route: "route-that-is-not-published",
        priceVersion: quoted.priceVersion,
        token: tokens.A,
      },
      fetchImpl,
    );
    assertLeg(
      unknown.state === "denied" && unknown.reason === "route_unavailable",
      `unknown route: ${JSON.stringify(unknown)}`,
    );
    return { forged: forged.reason, unknownRoute: unknown.reason };
  });

  await leg("target-weknora-ingest-after-signout", async () => {
    const weknora = context.weknora;
    if (!weknora)
      throw new Error("The target has no WeKnora credentials configured.");
    const authorizationId = crypto.randomUUID();
    if (weknora.createGrant) {
      const granted = await pilotAuthorizeEntry(
        target,
        {
          authorizationId,
          applicationId: "weknora",
          kind: "background",
          taskId: authorizationId,
          resourcePrefix: weknora.resourceId,
          expiresAt: new Date(clock() + 900_000).toISOString(),
          limitMicrocredits: "4096",
          sessionCookie: sessionCookies.A,
        },
        fetchImpl,
      );
      assertLeg(
        typeof granted.authorizationId === "string" ||
          typeof granted.id === "string",
        "WeKnora grant refused",
      );
    }
    const ingest = await pilotWeKnoraEntry(
      target,
      {
        serviceToken: weknora.serviceToken,
        subject: weknora.subject,
        authorizationId,
        resourceId: weknora.resourceId,
        operationId: crypto.randomUUID(),
        input: ["embedding during sign-in"],
      },
      fetchImpl,
    );
    assertLeg(ingest.status === 200, `ingest status ${ingest.status}`);
    const afterSignout = await pilotWeKnoraEntry(
      target,
      {
        serviceToken: weknora.serviceToken,
        subject: weknora.subject,
        authorizationId,
        resourceId: weknora.resourceId,
        operationId: crypto.randomUUID(),
        input: ["embedding after sign out"],
      },
      fetchImpl,
    );
    assertLeg(
      afterSignout.status === 200,
      `post-signout status ${afterSignout.status}`,
    );
    assertLeg(
      Array.isArray(afterSignout.body?.vectors) &&
        afterSignout.body.vectors.length > 0,
      "no embedding vectors",
    );
    const revoked = await pilotRevokeEntry(
      target,
      authorizationId,
      sessionCookies.A,
      fetchImpl,
    );
    assertLeg(
      typeof revoked.authorizationId === "string" ||
        typeof revoked.id === "string",
      "revocation was not recorded",
    );
    const afterRevoke = await pilotWeKnoraEntry(
      target,
      {
        serviceToken: weknora.serviceToken,
        subject: weknora.subject,
        authorizationId,
        resourceId: weknora.resourceId,
        operationId: crypto.randomUUID(),
        input: ["embedding after revocation"],
      },
      fetchImpl,
    );
    assertLeg(
      afterRevoke.status === 410,
      `post-revocation status ${afterRevoke.status}`,
    );
    return {
      ingest: ingest.status,
      afterSignout: afterSignout.status,
      revoked: afterRevoke.status,
    };
  });

  await leg("target-account-status-suspension", async () => {
    const suspension = context.suspension;
    if (!suspension)
      throw new Error("The target has no account-status entry configured.");
    const settled = await pilotChatEntry(
      target,
      {
        operationId: operation("settled"),
        prompt: "settle before suspension",
        route: routes.A,
        token: tokens.A,
      },
      fetchImpl,
    );
    assertLeg(
      settled.dispatch?.state === "completed",
      `pre-suspension dispatch: ${settled.dispatch?.state ?? settled.reservation.state}`,
    );
    const balanceBefore = await pilotBalanceEntry(
      target,
      sessionCookies.A,
      fetchImpl,
    );
    const paused = await pilotSuspensionEntry(
      {
        url: target.accountStatus?.url ?? "",
        token: suspension.token,
        workspaceId: suspension.workspaceId,
      },
      "pause",
      "matrix-suspension",
      fetchImpl,
    );
    assertLeg(
      typeof paused.operationId === "string",
      "suspension was not recorded",
    );
    const refused = await pilotChatEntry(
      target,
      {
        operationId: operation("suspended"),
        prompt: "must be refused",
        route: routes.A,
        token: tokens.A,
      },
      fetchImpl,
    );
    assertLeg(
      refused.reservation.state === "denied" &&
        refused.reservation.reason === "not_authorized",
      `suspended reservation: ${JSON.stringify(refused.reservation)}`,
    );
    assertLeg(refused.dispatch === undefined, "suspended work was dispatched");
    const receipt = await pilotReceiptEntry(
      target,
      operation("settled"),
      sessionCookies.A,
      fetchImpl,
    );
    assertLeg(
      receipt.state === "settled",
      "settled receipt did not survive suspension",
    );
    const balanceAfter = await pilotBalanceEntry(
      target,
      sessionCookies.A,
      fetchImpl,
    );
    assertLeg(
      balanceBefore.chargedMicrocredits === balanceAfter.chargedMicrocredits &&
        balanceBefore.availableMicrocredits ===
          balanceAfter.availableMicrocredits,
      "balance moved at suspension",
    );
    return {
      operationId: paused.operationId,
      receipt: receipt.state,
      balance: balanceAfter,
    };
  });

  return results;
}
