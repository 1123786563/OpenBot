/**
 * Personal-memory fixture (MT039 / Issue #82).
 *
 * Rides the shared MT008 resource-policy fixture (real §11 identity matrix,
 * real provisioning) and hands the suite the REAL production surfaces under
 * test — no stand-ins on any decision path:
 *
 *   - `memory`: the MT039 module under test over the verified restricted
 *     data channel;
 *   - `seedResource` / `markVisibility`: real operator-channel arrangement
 *     for source-choice rows (knowledge bases and documents);
 *   - `seedReadGrant`: real operator INSERT policy for one explicit read
 *     grant (MT019 fixture precedent);
 *   - `scopeAs`: real scope issuance through the real resolver.
 *
 * Restricted `ob_ent_*` roles and real RLS execute throughout.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  createPersonalMemoryService,
  type PersonalMemoryService,
} from "../../../src/enterprise/tenancy/personal-memory";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
} from "./resource-policy";

export interface PersonalMemoryFixture {
  readonly base: ResourcePolicyFixture;
  /** The MT039 service under test (data channel). */
  readonly memory: PersonalMemoryService;
  /** Real trusted scope issuance through the real resolver. */
  scopeAs(
    identity: Parameters<ResourcePolicyFixture["scopeFor"]>[0],
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /**
   * Arrangement stand-in (operator channel): registers one knowledge base or
   * document resource row in a team, optionally workspace-public.
   */
  seedResource(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly kind: "knowledge_base" | "document";
    readonly displayName: string;
    readonly visibility?: "workspace" | null;
  }): Promise<string>;
  /** Arrangement stand-in (operator INSERT policy): one explicit read grant. */
  seedReadGrant(input: {
    readonly tenantId: string;
    readonly resourceId: string;
    readonly principalId: string;
  }): Promise<void>;
  dispose(): Promise<void>;
}

export async function createPersonalMemoryFixture(): Promise<PersonalMemoryFixture> {
  const base = await createResourcePolicyFixture();
  const memory = createPersonalMemoryService({ data: base.data });

  return {
    base,
    memory,
    scopeAs: (identity, tenantId, workspaceId) =>
      base.scopeFor(identity, { tenantId, workspaceId }),
    async seedResource({
      tenantId,
      workspaceId,
      kind,
      displayName,
      visibility,
    }) {
      const resourceId = `mt039-${kind}-${randomUUID().slice(0, 8)}`;
      await base.operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_resources
            (tenant_id, id, workspace_id, kind, display_name, visibility)
          values (${tenantId}, ${resourceId}, ${workspaceId}, ${kind}, ${displayName}, ${visibility ?? null})
        `);
      });
      return resourceId;
    },
    async seedReadGrant({ tenantId, resourceId, principalId }) {
      // The grants table's INSERT policy is tenant-scoped (MT019 precedent).
      await base.operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_resource_grants
            (tenant_id, resource_id, principal_id, action)
          values (${tenantId}, ${resourceId}, ${principalId}, 'read')
          on conflict do nothing
        `);
      });
    },
    dispose: () => base.dispose(),
  };
}
