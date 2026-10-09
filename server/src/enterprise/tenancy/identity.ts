/**
 * Global identity provisioning: creating and suspending the principals that bind authenticated
 * users into enterprises, per plan 02 §5 T1-C step 2 (identity CLI half).
 *
 * This is the identity operator's domain, deliberately separate from the tenant operator's: no
 * tenant context, no tenant locks, and its own global audit table. The lock order is principal
 * exclusive → global operation exclusive, and a tenant lock is never taken — global identity work
 * must not serialize behind one tenant's provisioning.
 *
 * The user↔principal binding is unique in BOTH directions: an existing principal cannot rebind to
 * another user, and a user cannot gain a second principal. Binding repair is not offered here at
 * all — it requires a separate DBA-approved, drain-and-audit path. Suspension is idempotent and
 * never restores: there is no create-on-suspend, no reactivation, no CLI command that un-suspends.
 */
import { z } from "zod";
import type { Database } from "../../db/client";
import { EnterpriseError } from "../errors";
import {
  type OperationOutcome,
  PAYLOAD_SERIALIZATION,
  payloadDigest,
} from "./provision";
import {
  beginOperation,
  firstRow,
  lockExclusive,
  lockKey,
  type TxClient,
} from "./transaction";

/** Global operations are keyed outside every tenant's operation-key space. */
const GLOBAL_OPERATION_SCOPE = "global";

const identifier = z.string().trim().min(1);

export const CreatePrincipalInputSchema = z
  .object({
    principalId: identifier,
    userId: identifier,
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export const SuspendPrincipalInputSchema = z
  .object({
    principalId: identifier,
    operator: identifier,
    operationId: identifier,
  })
  .strict();

export type CreatePrincipalInput = z.infer<typeof CreatePrincipalInputSchema>;
export type SuspendPrincipalInput = z.infer<typeof SuspendPrincipalInputSchema>;

const StoredDetailsSchema = z
  .object({
    serialization: z.literal(PAYLOAD_SERIALIZATION),
    payload_digest: z.string().min(1),
    result: z.unknown(),
  })
  .strict();

const SELECT_STORED_EVENT =
  "select kind, details from enterprise_identity_events where id = $1";
const INSERT_EVENT =
  "insert into enterprise_identity_events (id, operation_id, actor, principal_id, kind, details) values ($1, $2, $3, $4, $5, $6::jsonb)";
const SELECT_PRINCIPAL_BY_ID =
  "select id, user_id, status from enterprise_principals where id = $1";
const SELECT_PRINCIPAL_ID_BY_USER =
  "select id from enterprise_principals where user_id = $1";
const INSERT_PRINCIPAL =
  "insert into enterprise_principals (id, user_id) values ($1, $2)";
const SUSPEND_PRINCIPAL =
  "update enterprise_principals set status = 'suspended' where id = $1 and status = 'active' returning id";

/**
 * Creates a principal bound to one authenticated user. The users row must already exist — this
 * module never creates users, and a missing user surfaces as the foreign-key rejection it is. A
 * principal that already exists with the same binding is an idempotent no-change; any other
 * combination of existing ids is a binding conflict.
 */
export async function createPrincipal(
  database: Database,
  input: CreatePrincipalInput,
): Promise<OperationOutcome> {
  const parsed = CreatePrincipalInputSchema.parse(input);
  const kind = "principal.created";
  const digest = payloadDigest(kind, {
    principalId: parsed.principalId,
    userId: parsed.userId,
    operator: parsed.operator,
  });
  return beginOperation(database, async (tx) => {
    await lockExclusive(tx, lockKey("principal", parsed.principalId));
    await lockExclusive(
      tx,
      lockKey("operation", GLOBAL_OPERATION_SCOPE, parsed.operationId),
    );

    const prior = await readStoredIdentityEvent(tx, parsed.operationId);
    if (prior !== undefined) {
      if (prior.kind !== kind || prior.details.payload_digest !== digest) {
        throw new EnterpriseError("IDEMPOTENCY_CONFLICT", 409);
      }
      return prior.details.result as OperationOutcome;
    }

    const existing = await firstRow(tx, SELECT_PRINCIPAL_BY_ID, [
      parsed.principalId,
    ]);
    let result: OperationOutcome;
    if (existing !== undefined) {
      if (existing.user_id !== parsed.userId) {
        throw new EnterpriseError("PRINCIPAL_BINDING_CONFLICT", 409);
      }
      result = { created: false, status: existing.status };
    } else {
      const sameUser = await firstRow(tx, SELECT_PRINCIPAL_ID_BY_USER, [
        parsed.userId,
      ]);
      if (sameUser !== undefined) {
        throw new EnterpriseError("PRINCIPAL_BINDING_CONFLICT", 409);
      }
      await tx.unsafe(INSERT_PRINCIPAL, [parsed.principalId, parsed.userId]);
      result = { created: true, status: "active" };
    }

    await appendIdentityEvent(
      tx,
      parsed.operationId,
      parsed.operator,
      parsed.principalId,
      kind,
      digest,
      result,
    );
    return result;
  });
}

/** Suspends a principal; already suspended is an audited no-change. Nothing here restores one. */
export async function suspendPrincipal(
  database: Database,
  input: SuspendPrincipalInput,
): Promise<OperationOutcome> {
  const parsed = SuspendPrincipalInputSchema.parse(input);
  const kind = "principal.suspended";
  const digest = payloadDigest(kind, {
    principalId: parsed.principalId,
    operator: parsed.operator,
  });
  return beginOperation(database, async (tx) => {
    await lockExclusive(tx, lockKey("principal", parsed.principalId));
    await lockExclusive(
      tx,
      lockKey("operation", GLOBAL_OPERATION_SCOPE, parsed.operationId),
    );

    const prior = await readStoredIdentityEvent(tx, parsed.operationId);
    if (prior !== undefined) {
      if (prior.kind !== kind || prior.details.payload_digest !== digest) {
        throw new EnterpriseError("IDEMPOTENCY_CONFLICT", 409);
      }
      return prior.details.result as OperationOutcome;
    }

    const existing = await firstRow(tx, SELECT_PRINCIPAL_BY_ID, [
      parsed.principalId,
    ]);
    if (existing === undefined) {
      throw new EnterpriseError("PRINCIPAL_NOT_FOUND", 409);
    }
    let result: OperationOutcome;
    if (existing.status === "suspended") {
      result = { changed: false, status: "suspended" };
    } else {
      await tx.unsafe(SUSPEND_PRINCIPAL, [parsed.principalId]);
      result = { changed: true, status: "suspended" };
    }

    await appendIdentityEvent(
      tx,
      parsed.operationId,
      parsed.operator,
      parsed.principalId,
      kind,
      digest,
      result,
    );
    return result;
  });
}

type StoredDetails = z.infer<typeof StoredDetailsSchema>;

async function readStoredIdentityEvent(
  tx: TxClient,
  operationId: string,
): Promise<{ kind: string; details: StoredDetails } | undefined> {
  const row = await firstRow(tx, SELECT_STORED_EVENT, [operationId]);
  if (row === undefined) {
    return undefined;
  }
  /* jsonb comes back as a parsed object; validate strictly and fail closed on anything else. */
  const parsedDetails = StoredDetailsSchema.safeParse(row.details);
  if (!parsedDetails.success || typeof row.kind !== "string") {
    throw new EnterpriseError("IDENTITY_EVENT_UNREADABLE", 503);
  }
  return { kind: row.kind, details: parsedDetails.data };
}

async function appendIdentityEvent(
  tx: TxClient,
  operationId: string,
  operator: string,
  principalId: string,
  kind: string,
  digest: string,
  result: OperationOutcome,
): Promise<void> {
  /* The details value is passed as an object, not pre-stringified: Bun's SQL serializes a value
   * once, so a pre-stringified parameter would land as a doubly-encoded jsonb string. */
  await tx.unsafe(INSERT_EVENT, [
    operationId,
    operationId,
    operator,
    principalId,
    kind,
    {
      serialization: PAYLOAD_SERIALIZATION,
      payload_digest: digest,
      result,
    },
  ]);
}
