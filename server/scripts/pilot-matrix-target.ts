/**
 * Target descriptor and product-entry client for the #98 pilot matrix (#158).
 *
 * The matrix used to hardcode the local ports, gateway image and provider key
 * path. This module reads them from the environment so the same matrix can be
 * pointed at an approved independent deployment, and it drives that target
 * through its product HTTP entry (`/api/billing/v1/*`) instead of reaching
 * into a local ledger.
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
} as const;

const loopback = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export type PilotTarget = {
  evidence: "fixture" | "deployment";
  gateway: { url: string; revision: string; meteringRevision: string };
  embedding: { url: string };
  tokenizer: { url: string };
  lago: { url: string };
  entry: { url: string; token: string } | undefined;
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
    deployment: {
      id: deployment.data.PILOT_DEPLOYMENT_ID,
      buildVersion: deployment.data.PILOT_BUILD_VERSION,
      imageDigest: deployment.data.PILOT_IMAGE_DIGEST,
    },
  };
}

type Json = Record<string, unknown>;

async function json(response: Response): Promise<Json> {
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok || typeof body !== "object" || body === null)
    throw new Error(`Pilot target request failed: ${response.status}`);
  return body as Json;
}

export type PilotChatResult = {
  reservation: { state: string; reason?: string; permit?: string };
  dispatch: { state: string; reason?: string; text?: string } | undefined;
  receipt: Json | undefined;
  usage: { inputTokens: number; outputTokens: number };
};

/**
 * Replays one chat operation through the target's product entry: quote,
 * reserve, dispatch and reconcile. Nothing here reads a local ledger, so the
 * same call works against a mounted fixture entry or an independent
 * deployment.
 */
export async function pilotChatEntry(
  target: PilotTarget,
  input: { operationId: string; prompt: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PilotChatResult> {
  const entry = target.entry;
  if (!entry) throw new Error("The pilot target has no product entry.");
  const base = entry.url.replace(/\/+$/, "");
  const headers = {
    authorization: `Bearer ${entry.token}`,
    "content-type": "application/json",
  };
  const quote = await json(await fetchImpl(`${base}/v1/quote`, { headers }));
  if (typeof quote.route !== "string" || typeof quote.priceVersion !== "string")
    throw new Error("The pilot target returned no model quote.");
  const reservation = (await json(
    await fetchImpl(`${base}/v1/reserve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationId: input.operationId,
        route: quote.route,
        priceVersion: quote.priceVersion,
      }),
    }),
  )) as PilotChatResult["reservation"];
  if (reservation.state !== "reserved")
    return {
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
      headers,
      body: JSON.stringify({
        operationId: input.operationId,
        permit: reservation.permit,
        messages: [{ role: "user", content: input.prompt }],
      }),
    }),
  );
  const operated = dispatched.operation as Json | undefined;
  const reconciled = await json(
    await fetchImpl(`${base}/v1/reconcile`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operationId: input.operationId }),
    }),
  );
  const receipt = (reconciled.operation as Json | undefined) ?? operated;
  return {
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
