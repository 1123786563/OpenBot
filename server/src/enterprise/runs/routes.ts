/**
 * The public run endpoints, per plan 03 §9.2: mounted INSIDE the existing session+scope
 * middlewares, no internal path, no capability, no service address in any DTO.
 *
 * POST /runs validates the Idempotency-Key against the shared ID schema (the store re-verifies
 * current authorization on every replay, so the key carries deduplication meaning only), reads
 * the body through a STREAMING byte limit BEFORE parsing — a body over 64KiB is cancelled and
 * answered 413 without ever being buffered whole — and refuses illegal JSON with 400 so a
 * syntax error can never become a 500. The run view returned is the bare public projection:
 * no input digest, no internal address, no capability.
 */
import type { Context } from "hono";
import {
  CreateRunSchema,
  ID,
  IdempotencyKeySchema,
} from "../../../../shared/enterprise/run-contracts";
import type { EnterpriseVariables } from "../app";
import { EnterpriseError } from "../errors";
import type { RunService } from "./contracts";

/** The plan's suggested test default; an operator tightens it via the route config, not by editing this file per deployment. */
export const MAX_RUN_BODY_BYTES = 64 * 1024;

const IDEMPOTENCY_KEY_REQUIRED = new EnterpriseError(
  "IDEMPOTENCY_KEY_REQUIRED",
  400,
);
const INVALID_RUN_INPUT = new EnterpriseError("INVALID_RUN_INPUT", 400);
const RUN_BODY_TOO_LARGE = new EnterpriseError("RUN_BODY_TOO_LARGE", 413);
const RUN_NOT_FOUND = new EnterpriseError("RUN_NOT_FOUND", 404);

/**
 * Reads the request body chunk by chunk, counting bytes, and cancels the stream the moment the
 * limit is crossed — an oversized body is never buffered whole. Anything at or under the limit
 * is decoded and JSON-parsed; a syntax error is a 400, not a 500.
 */
async function readJsonWithinLimit(
  c: Context<{ Variables: EnterpriseVariables }>,
): Promise<unknown> {
  const body = c.req.raw.body;
  if (body === null) {
    throw INVALID_RUN_INPUT;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > MAX_RUN_BODY_BYTES) {
      await reader.cancel();
      throw RUN_BODY_TOO_LARGE;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(merged)) as unknown;
  } catch {
    throw INVALID_RUN_INPUT;
  }
}

export function mountRunRoutes(
  api: import("hono").Hono<{ Variables: EnterpriseVariables }>,
  runs: RunService,
): void {
  api.post("/runs", async (c) => {
    const key = IdempotencyKeySchema.safeParse(c.req.header("idempotency-key"));
    if (!key.success) {
      throw IDEMPOTENCY_KEY_REQUIRED;
    }
    const body = CreateRunSchema.safeParse(await readJsonWithinLimit(c));
    if (!body.success) {
      throw INVALID_RUN_INPUT;
    }
    /* 202: the run is RECEIVED — creation is never a completion proof, and the response does
     * not wait for the model. */
    return c.json(await runs.create(c.var.scope, key.data, body.data), 202);
  });

  api.get("/runs/:id", async (c) => {
    const id = ID.safeParse(c.req.param("id"));
    if (!id.success) {
      throw RUN_NOT_FOUND;
    }
    return c.json(await runs.get(c.var.scope, id.data));
  });
}
