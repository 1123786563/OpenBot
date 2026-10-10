/**
 * The drizzle-pool-backed capability lookup the validation endpoint uses.
 *
 * enterprise_capabilities is pinned by the runs migration to ONE bound run: the ob_ent_runtime_writer
 * policies see a row only when the transaction carries that run's app.tenant_id + app.run_id. So
 * this lookup opens its own short transaction, sets exactly those two context values from the
 * INVOCATION (never from a request body), and selects by token hash — a capability minted for
 * another run is not "found and refused", it is invisible, which is the stronger property.
 *
 * Statement text is a module constant executed through `unsafe` with bound parameters, per the
 * tenancy transaction layer's discipline: no runtime value is ever interpolated into SQL.
 */
import { z } from "zod";

import type { Database } from "../../db/client";
import { beginOperation } from "../tenancy/transaction";
import type { CapabilityLookup, CapabilityRecord } from "./verifier";

const SET_RUNTIME_CONTEXT_TEXT = `
  select set_config('app.tenant_id', $1, true),
         set_config('app.run_id', $2, true)`;

const SELECT_CAPABILITY_TEXT = `
  select id, tenant_id, service_id, audience, envelope_digest, run_id,
         attempt_id, lease_id, fencing_token, expires_at, revoked_at
  from enterprise_capabilities
  where tenant_id = $1 and run_id = $2 and token_hash = $3
  limit 1`;

const RowSchema = z
  .object({
    id: z.string(),
    tenant_id: z.string(),
    service_id: z.string(),
    audience: z.string(),
    envelope_digest: z.string(),
    run_id: z.string(),
    attempt_id: z.string(),
    lease_id: z.string(),
    /* bigint columns arrive as decimal strings from the driver. */
    fencing_token: z.union([z.string(), z.number()]).transform(Number),
    expires_at: z.date(),
    revoked_at: z.date().nullable(),
  })
  .strict();

/**
 * Builds the lookup over one database pool (the runtime-writer login's). Any database failure
 * rejects; the verifier maps a rejection to "unavailable" rather than guessing.
 */
export function createCapabilityLookup(database: Database): CapabilityLookup {
  return async (tenantId, runId, tokenHash) => {
    return beginOperation(database, async (tx) => {
      await tx.unsafe(SET_RUNTIME_CONTEXT_TEXT, [tenantId, runId]);
      const rows = await tx.unsafe<Record<string, unknown>[]>(
        SELECT_CAPABILITY_TEXT,
        [tenantId, runId, tokenHash],
      );
      const row = rows[0];
      if (row === undefined) return null;
      const parsed = RowSchema.safeParse(row);
      if (!parsed.success) return null;
      const data = parsed.data;
      const record: CapabilityRecord = {
        id: data.id,
        tenantId: data.tenant_id,
        serviceId: data.service_id,
        audience: data.audience,
        envelopeDigest: data.envelope_digest,
        runId: data.run_id,
        attemptId: data.attempt_id,
        leaseId: data.lease_id,
        fencingToken: data.fencing_token,
        expiresAt: data.expires_at,
        revokedAt: data.revoked_at,
      };
      return record;
    });
  };
}
