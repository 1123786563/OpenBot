/**
 * Learning-demonstrations fixture (MT040 / Issue #83).
 *
 * Rides the shared MT008 resource-policy fixture (real §11 identity matrix,
 * real provisioning, real suspension path) and hands the suite the REAL
 * production surface under test — no stand-ins on any decision path:
 *
 *   - `learning`: the MT040 module under test over the verified restricted
 *     channels;
 *   - `scopeAs` / `suspendCompanyMembership`: real scope issuance through
 *     the real resolver and the real offline revocation (epoch bump).
 *
 * Restricted `ob_ent_*` roles and real RLS execute throughout.
 */

import type { PlatformScope } from "../../../src/enterprise/contracts";
import {
  createLearningDemonstrationService,
  type LearningDemonstrationService,
} from "../../../src/enterprise/tenancy/learning-demonstrations";
import {
  createResourcePolicyFixture,
  type ResourcePolicyFixture,
} from "./resource-policy";

export interface LearningDemonstrationFixture {
  readonly base: ResourcePolicyFixture;
  /** The MT040 service under test (data + operator channels). */
  readonly learning: LearningDemonstrationService;
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

export async function createLearningDemonstrationFixture(): Promise<LearningDemonstrationFixture> {
  const base = await createResourcePolicyFixture();
  const learning = createLearningDemonstrationService({
    data: base.data,
    operator: base.operator,
  });
  return {
    base,
    learning,
    scopeAs: (identity, tenantId, workspaceId) =>
      base.scopeFor(identity, { tenantId, workspaceId }),
    async suspendCompanyMembership(identity, tenantId) {
      await base.isolation.suspendCompanyMembership(identity, tenantId);
    },
    dispose: () => base.dispose(),
  };
}
