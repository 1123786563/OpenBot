/**
 * The identity directory, per plan 02 §6 T2-A step 4.
 *
 * This is how the "you need membership to pick a tenant, and membership to query membership"
 * circle is broken: the directory login (`ob_ent_directory`) is pinned by RLS to
 * `app.user_id = nullif(current_setting('app.user_id', true), '')`, so with the authenticated
 * user's id set as transaction-local context it may see exactly that user's principal, that
 * principal's memberships, and those memberships' tenants — nothing else. The userId ALWAYS comes
 * from the AuthService session, never from a body or header.
 *
 * The context and the query share one transaction on one pooled connection:
 * `set_config('app.user_id', …, true)` is transaction-local, so it can never bleed onto a
 * neighbouring connection or outlive the read. Setting the context on one connection and querying
 * on another is structurally impossible here — both statements run inside the same
 * `beginOperation` callback.
 *
 * Statement texts are module constants with `$n` placeholders; values travel only as parameters.
 * Rows are validated with a strict Zod schema before they leave this module: an unknown role or a
 * corrupted epoch is a failure, never an automatic demotion to member (the schema's own check
 * constraints make those rows impossible to store; this parse is the second lock on the same door).
 */
import { z } from "zod";
import type { Database } from "../../db/client";
import type { Directory, Membership } from "../contracts";
import { beginOperation, type TxClient } from "./transaction";

const SET_USER_CONTEXT = "select set_config('app.user_id', $1, true)";

const SELECT_MEMBERSHIPS = `
  select m.tenant_id as "tenantId",
         p.id as "principalId",
         t.name as "tenantName",
         m.role as "role",
         m.epoch as "epoch",
         t.status as "tenantStatus",
         p.status as "principalStatus",
         m.status as "memberStatus"
  from enterprise_principals p
  join enterprise_memberships m on m.principal_id = p.id
  join enterprise_tenants t on t.id = m.tenant_id
  where p.user_id = $1 and p.status = 'active'`;

const MemberSchema = z
  .object({
    tenantId: z.string(),
    principalId: z.string(),
    tenantName: z.string(),
    role: z.enum(["tenant_admin", "member", "auditor"]),
    epoch: z.number().int().positive(),
    tenantStatus: z.enum(["active", "suspended"]),
    principalStatus: z.enum(["active", "suspended"]),
    memberStatus: z.enum(["active", "suspended"]),
  })
  .strict();

export function createDirectory(database: Database): Directory {
  return {
    async listForUser(userId: string): Promise<Membership[]> {
      return beginOperation(database, async (tx: TxClient) => {
        await tx.unsafe(SET_USER_CONTEXT, [userId]);
        const rows = await tx.unsafe<Record<string, unknown>[]>(
          SELECT_MEMBERSHIPS,
          [userId],
        );
        return z.array(MemberSchema).parse(rows);
      });
    },
  };
}
