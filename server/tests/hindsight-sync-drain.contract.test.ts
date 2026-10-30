import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/bun-test-compat";
import { createDatabase, type Database } from "../src/db/client";
import { users } from "../src/db/schema/core";
import {
  enterpriseMemberships,
  enterprisePrincipals,
  enterpriseTenants,
  enterpriseWorkspaceMemberships,
} from "../src/db/schema/enterprise-tenancy";
import { genericPersonalPreferences } from "../src/db/schema/hindsight-preferences";
import { hindsightRevocations } from "../src/db/schema/hindsight-revocations";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  createDrizzlePreferenceRecords,
  createPreferenceRecallService,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import { createDrizzleRevocationLedger } from "../src/hindsight/revocation-ledger";
import { createDrizzleSourceBoundAuthorizations } from "../src/hindsight/scoped-recall";
import { createHindsightSyncQueue } from "../src/hindsight/sync-queue";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/*
 * FIX-W2 (Run 2026-10-24-hindsight-376, audit G3-F2) on a REAL self-hosted Hindsight
 * instance — the dedicated throwaway booted by deploy/hindsight/test/contract-instance.sh.
 *
 * What only the real service can prove about the newly wired production drain:
 *   - a confirm whose inline retain failed (the outage-era shape: authority row + pending
 *     work, nothing remote yet) is completed by the queue's OWN retain path — minting the
 *     assertion the service's tenant extension really verifies, into the derived user bank;
 *   - the drain's success flips the row's retained digest and the status surface answers
 *     `indexed`, and the real recall probe returns the document the drain retained;
 *   - the forget afterwards blocks recall instantly and its remote deletion reaches the real
 *     service (the document probe answers 404 afterwards).
 *
 * When the instance is not reachable the suite skips loudly, exactly like #381's contract
 * suite. The outage→recovery leg itself stays in the integration suite: a scripted service
 * fails on demand, and nobody may flip the shared real instance's state mid-suite.
 */

const CONTRACT_URL =
  process.env.HINDSIGHT_CONTRACT_URL ?? "http://127.0.0.1:8889";
const CONTRACT_API_KEY = process.env.HINDSIGHT_CONTRACT_API_KEY;
const CONTRACT_SECRET = process.env.HINDSIGHT_CONTRACT_ASSERTION_SECRET;

const database: Database = createDatabase(testDatabaseUrl(), TEST_POOL);

const run = randomUUID().slice(0, 8);
const TENANT = `tn_fixw2ct-${run}`;
const WORKSPACE = `ws_fixw2ct-${run}`;
const PRINCIPAL = `prin_fixw2ct-${run}`;
const GLOBAL_ACTOR = `usr_fixw2ct-${run}`;

const API_MS = 15_000;
/** The real extraction pipeline settles asynchronously; poll, bounded, never forever. */
const PIPELINE_POLL_MS = 40_000;

async function live(): Promise<boolean> {
  try {
    const response = await fetch(`${CONTRACT_URL}/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Boolean, never the && chain's undefined: the loud-skip guard asserts false
// when the contract env is absent, so the missing-env case must read false.
const available = Boolean(
  CONTRACT_API_KEY && CONTRACT_SECRET && (await live()),
);

// The controlled-directory technique from hindsight-bank-scope.test.ts, so the minted scope
// carries the real issuedScopes trust marker.
function controlledQuery(
  rows: (table?: unknown) => readonly Record<string, unknown>[],
) {
  let result = rows();
  const query = Promise.resolve(rows());
  const chain = () => query;
  return Object.assign(query, {
    from(value: unknown) {
      result = rows(value);
      return this;
    },
    innerJoin: chain,
    where: chain,
    limit() {
      return Promise.resolve(result);
    },
  });
}

function controlledDirectoryDatabase(principalId: string): Database {
  const capabilityCheck = {
    current_user_matches: true,
    capability_attributes_ok: true,
    login_attributes_ok: true,
    login_has_expected_capability: true,
    capability_has_no_escalation_membership: true,
    login_has_no_other_memberships: true,
    no_protected_ownership: true,
    login_has_no_enterprise_privileges: true,
  };
  return {
    execute: async () => [capabilityCheck],
    transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({
        execute: async () => [],
        select: () =>
          controlledQuery((table) =>
            table === enterpriseWorkspaceMemberships
              ? [{ status: "active" }]
              : [
                  {
                    principalId,
                    tenantStatus: "active",
                    principalStatus: "active",
                    memberStatus: "active",
                    memberEpoch: 3,
                  },
                ],
          ),
      }),
  } as unknown as Database;
}

async function makeTrustedScope(): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(PRINCIPAL),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => TENANT,
    selectWorkspace: () => WORKSPACE,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

let queue: ReturnType<typeof createHindsightSyncQueue>;
let service: ReturnType<typeof createPreferenceRecallService>;
let scope: PlatformScope;

describe.skipIf(!available)(
  "FIX-W2 sync drain on a real instance (G3-F2)",
  () => {
    beforeAll(async () => {
      await database
        .insert(users)
        .values([
          { id: `usr_fixw2ct-${run}`, email: `fixw2ct-${run}@example.invalid` },
        ]);
      await database
        .insert(enterpriseTenants)
        .values([{ id: TENANT, name: `FIX-W2 contract ${run}` }]);
      await database
        .insert(enterprisePrincipals)
        .values([{ id: PRINCIPAL, userId: `usr_fixw2ct-${run}` }]);
      await database
        .insert(enterpriseMemberships)
        .values([{ tenantId: TENANT, principalId: PRINCIPAL, role: "member" }]);
      const config = {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "unset",
        assertionSecret: CONTRACT_SECRET ?? "unset",
        requestTimeoutMs: API_MS,
      };
      queue = createHindsightSyncQueue(database, config, {
        authorizations: createDrizzleSourceBoundAuthorizations(database),
      });
      service = createPreferenceRecallService(
        createDrizzlePreferenceRecords(database),
        config,
        { work: queue, revocations: createDrizzleRevocationLedger(database) },
      );
      scope = await makeTrustedScope();
    });

    afterAll(async () => {
      // Leave no pending work of this suite behind for another suite's drain.
      await queue?.drain({ limit: 500 });
    });

    test("an outage-era confirm drains to indexed on the real service, and forget closes it", async () => {
      const content = `合约排空偏好 ${run} 的 drain`;
      // The outage-era shape, built directly: authority row confirmed, nothing retained yet,
      // one pending work row carrying the digest of the content as confirmed.
      const id = randomUUID();
      const at = new Date();
      await database.insert(genericPersonalPreferences).values({
        tenantId: TENANT,
        id,
        principalId: PRINCIPAL,
        content,
        provenance: "You",
        reviewState: "confirmed",
        enabled: true,
        markedGenericAt: at,
        hindsightDocumentId: preferenceDocumentIdFor(TENANT, id),
        createdAt: at,
        updatedAt: at,
      });
      await queue.record({
        subjectType: "preference",
        tenantId: TENANT,
        subjectId: id,
        principalId: PRINCIPAL,
        contentDigest: digestOf(content),
      });
      expect(
        await queue.syncStatus(TENANT, "preference", id, PRINCIPAL),
      ).toEqual({
        state: "pending",
        attempts: 0,
      });

      const report = await queue.drain();
      expect(report.synced).toBe(1);
      const status = await queue.syncStatus(
        TENANT,
        "preference",
        id,
        PRINCIPAL,
      );
      expect(status.state).toBe("indexed");

      // The document the drain retained is recallable on the real service, through the seam.
      const documentId = preferenceDocumentIdFor(TENANT, id);
      const deadline = Date.now() + PIPELINE_POLL_MS;
      let recalled: string[] = [];
      for (;;) {
        const answer = await service.recallGenericPreferences(scope, {
          query: content,
        });
        recalled = answer.map((row) => row.content);
        if (recalled.includes(content) || Date.now() > deadline) break;
        await new Promise((settle) => setTimeout(settle, 1000));
      }
      expect(recalled).toEqual([content]);

      // The forget: recall closes at once and the remote deletion reaches the real service.
      const revocation = await service.forgetGenericPreference(scope, id);
      expect(revocation.remoteDeletion).toEqual({
        attempted: true,
        outstanding: 0,
      });
      const [ledgerRow] = await database
        .select()
        .from(hindsightRevocations)
        .where(
          and(
            eq(hindsightRevocations.tenantId, TENANT),
            eq(hindsightRevocations.documentId, documentId),
          ),
        )
        .limit(1);
      expect(ledgerRow?.deletionState).toBe("confirmed");
      expect(
        await service.recallGenericPreferences(scope, { query: content }),
      ).toEqual([]);
      await expect(
        queue.syncStatus(TENANT, "preference", id, PRINCIPAL),
      ).resolves.not.toMatchObject({ state: "indexed" });
    });
  },
);

describe.skipIf(available)("FIX-W2 contract suite instance unavailable", () => {
  test("the real-instance contract suite did not run", () => {
    // Loud skip, not silence: boot with deploy/hindsight/test/contract-instance.sh start.
    expect(available).toBe(false);
  });
});
