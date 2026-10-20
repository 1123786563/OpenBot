/**
 * Purge-restore fixture (MT068 / Issue #111).
 *
 * Rides the shared MT008 resource-policy fixture (real §11 identity matrix,
 * real provisioning, real suspension path) and hands the suite the REAL
 * production surfaces under test — no stand-ins on any decision path:
 *
 *   - `purge`: the MT068 module under test over the verified restricted
 *     channels, with a test signing key injected at assembly (the production
 *     key is a deployment concern, disclosed here);
 *   - `seedResource`: real operator-channel arrangement for resources the
 *     manifest enumerates;
 *   - `statusOf`: RLS probe reading one resource's status through the
 *     restricted data role;
 *   - `scopeAs` / `suspendCompanyMembership`: real scope issuance and the
 *     real offline revocation (epoch bump).
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { enterpriseResources } from "../../../src/db/schema/enterprise-tenancy";
import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  createPurgeRestoreService,
  type PurgeRestoreService,
} from "../../../src/enterprise/tenancy/purge-restore";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
} from "./resource-policy";

export interface PurgeRestoreFixture {
  readonly base: ResourcePolicyFixture;
  /** The MT068 service under test (test signing key injected). */
  readonly purge: PurgeRestoreService;
  /** Real trusted scope issuance through the real resolver. */
  scopeAs(
    identity: Parameters<ResourcePolicyFixture["scopeFor"]>[0],
    tenantId: string,
    workspaceId: string,
  ): Promise<PlatformScope>;
  /** Real MT006 suspension path: epoch increments, scopes die on next check. */
  suspendCompanyMembership(
    identity: Parameters<
      ResourcePolicyFixture["isolation"]["suspendCompanyMembership"]
    >[0],
    tenantId: string,
  ): Promise<void>;
  /** Arrangement stand-in (operator channel): one resource row in a team. */
  seedResource(input: {
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly displayName: string;
  }): Promise<string>;
  /** RLS probe (restricted data role): one resource's current status. */
  statusOf(tenantId: string, resourceId: string): Promise<string>;
  dispose(): Promise<void>;
}

export async function createPurgeRestoreFixture(): Promise<PurgeRestoreFixture> {
  const base = await createResourcePolicyFixture();
  const purge = createPurgeRestoreService({
    data: base.data,
    operator: base.operator,
    // Test-only key, disclosed: production key management is a deployment
    // concern outside this suite (assembly-time injection is the seam).
    signingKey: `mt068-test-key-${randomUUID()}`,
  });

  return {
    base,
    purge,
    scopeAs: (identity, tenantId, workspaceId) =>
      base.scopeFor(identity, { tenantId, workspaceId }),
    async suspendCompanyMembership(identity, tenantId) {
      await base.isolation.suspendCompanyMembership(identity, tenantId);
    },
    async seedResource({ tenantId, workspaceId, displayName }) {
      const resourceId = `mt068-res-${randomUUID().slice(0, 8)}`;
      await base.operator.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '5s'`);
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.execute(sql`
          insert into enterprise_resources
            (tenant_id, id, workspace_id, kind, display_name)
          values (${tenantId}, ${resourceId}, ${workspaceId}, 'document', ${displayName})
        `);
      });
      return resourceId;
    },
    async statusOf(tenantId, resourceId) {
      return base.data.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        const [row] = await tx
          .select({ status: enterpriseResources.status })
          .from(enterpriseResources)
          .where(
            and(
              eq(enterpriseResources.tenantId, tenantId),
              eq(enterpriseResources.id, resourceId),
            ),
          )
          .limit(1);
        return row?.status ?? "absent";
      });
    },
    dispose: () => base.dispose(),
  };
}
