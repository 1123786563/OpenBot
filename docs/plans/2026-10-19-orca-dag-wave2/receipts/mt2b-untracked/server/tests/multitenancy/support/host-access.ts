/**
 * Host-access fixture (MT035 / Issue #78).
 *
 * Rides the shared MT008 resource-policy fixture (real §11 identity matrix,
 * real provisioning, real suspension path) and hands the suite the REAL
 * production surfaces under test — no stand-ins on any decision path:
 *
 *   - `bots`: real MT016 `createBotOwnershipService` (host access grants
 *     reference real bot ownership rows created through the accepted path);
 *   - `host`: the MT035 module under test over the verified restricted
 *     channels;
 *   - `scopeAs` / `suspendCompanyMembership`: real scope issuance through
 *     the real resolver and the real offline revocation (epoch bump).
 *
 * Restricted `ob_ent_*` roles and real RLS execute throughout.
 */

import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  type BotOwnershipService,
  createBotOwnershipService,
} from "../../../src/enterprise/tenancy/bots-ownership";
import {
  createHostAccessService,
  type HostAccessService,
} from "../../../src/enterprise/tenancy/host-access";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
} from "./resource-policy";

export interface HostAccessFixture {
  readonly base: ResourcePolicyFixture;
  /** Real MT016 bot ownership (grant rows reference real ownership rows). */
  readonly bots: BotOwnershipService;
  /** The MT035 service under test (data + operator channels). */
  readonly host: HostAccessService;
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
  dispose(): Promise<void>;
}

export async function createHostAccessFixture(): Promise<HostAccessFixture> {
  const base = await createResourcePolicyFixture();
  const bots = createBotOwnershipService({
    data: base.data,
    operator: base.operator,
  });
  const host = createHostAccessService({
    data: base.data,
    operator: base.operator,
  });
  return {
    base,
    bots,
    host,
    scopeAs: (identity, tenantId, workspaceId) =>
      base.scopeFor(identity, { tenantId, workspaceId }),
    async suspendCompanyMembership(identity, tenantId) {
      await base.isolation.suspendCompanyMembership(identity, tenantId);
    },
    dispose: () => base.dispose(),
  };
}
