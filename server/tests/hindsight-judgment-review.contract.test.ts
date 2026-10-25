import { randomUUID } from "node:crypto";
import { describe, expect, test } from "../../tests/support/bun-test-compat";
import type { Database } from "../src/db/client";
import { enterpriseWorkspaceMemberships } from "../src/db/schema/enterprise-tenancy";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { userBankFor } from "../src/hindsight/bank-scope";
import {
  createDerivedJudgmentService,
  type DerivedJudgmentEvidenceRow,
  type DerivedJudgmentRow,
  type DerivedJudgmentStore,
} from "../src/hindsight/derived-judgments";
import {
  createDerivedJudgmentReviewService,
  type RecalledDerivedJudgment,
} from "../src/hindsight/judgment-review";
import {
  type PreferenceAuthorityRow,
  type PreferenceRecordStore,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";
import {
  type SourceBoundAuthorizationStore,
  type SourceBoundRecordRow,
  type SourceBoundRecordStore,
  sourceBoundDocumentIdFor,
} from "../src/hindsight/scoped-recall";

/*
 * Hindsight 12 (#389): the judgment review and recall seams on a REAL self-hosted Hindsight
 * instance — the dedicated throwaway booted by deploy/hindsight/test/contract-instance.sh,
 * whose gateway stand-in answers extraction with one echo fact per request so the
 * retain→recall pipeline actually produces hits.
 *
 * What only the real service can prove here:
 *   - the confirm's retain rides the real submission pipeline for a judgment document (hdj_
 *     id, replace mode), into the judgment's own bank — the user bank for a general judgment,
 *     the restriction's team bank for a team judgment;
 *   - a recall through the seam returns the judgment's document id from the REAL search stack
 *     and answers the person's adopted text with its citations, never anything the index
 *     derived;
 *   - the team bank boundary is the service's own: asking from ANOTHER team's scope searches
 *     that team's bank, where the judgment was never retained, and nothing answers;
 *   - a candidate nobody confirmed was never retained, so no recall can find it — the
 *     "审核未过不出库" half of the ticket on real infrastructure.
 *
 * The authority rows are in-memory stores (the SQL store is the integration suite's subject;
 * both implement the same port, and every review and recall rule lives above the port). When
 * the instance is not reachable the suite skips loudly, exactly like #381's contract suite.
 */

const CONTRACT_URL =
  process.env.HINDSIGHT_CONTRACT_URL ?? "http://127.0.0.1:8889";
const CONTRACT_API_KEY = process.env.HINDSIGHT_CONTRACT_API_KEY;
const CONTRACT_SECRET = process.env.HINDSIGHT_CONTRACT_ASSERTION_SECRET;

const run = randomUUID().slice(0, 8);
const TENANT = `tn_jreview-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const PRINCIPAL = `prin_jreview-${run}`;
const GLOBAL_ACTOR = `usr_global-${run}`;

const API_MS = 10_000;
/**
 * The extraction pipeline is asynchronous in principle; on the contract instance it has
 * answered synchronously, so this window is safety margin only — bounded to fit inside the
 * e2e runner's per-test timeout with room to spare.
 */
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

const available = CONTRACT_API_KEY && CONTRACT_SECRET && (await live());

// The controlled-directory technique from hindsight-preference-recall.contract.test.ts, so
// the scopes this suite recalls through carry the real issuedScopes trust marker.
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

async function makeTrustedScope(
  principalId: string,
  workspaceId: string,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => TENANT,
    selectWorkspace: () => workspaceId,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

/** The in-memory authority stores; same ports as the SQL stores, so the rules match. */
function memoryPreferenceStore() {
  const rows = new Map<string, PreferenceAuthorityRow>();
  const key = (tenantId: string, id: string) => `${tenantId}:${id}`;
  const store: PreferenceRecordStore = {
    async create(row) {
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    async load(tenantId, id) {
      return rows.get(key(tenantId, id)) ?? null;
    },
    async save(row) {
      if (!rows.has(key(row.tenantId, row.id))) return;
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    async loadByDocumentIds(tenantId, principalId, documentIds) {
      const wanted = new Set(documentIds);
      return [...rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          row.principalId === principalId &&
          wanted.has(row.hindsightDocumentId),
      );
    },
    async listLiving(tenantId, principalId, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            row.principalId === principalId &&
            row.deletedAt === null,
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
    },
  };
  return { store, rows };
}

function memorySourceBoundStore() {
  const rows = new Map<string, SourceBoundRecordRow>();
  const key = (tenantId: string, id: string) => `${tenantId}:${id}`;
  const store: SourceBoundRecordStore = {
    async create(row) {
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    async load(tenantId, id) {
      return rows.get(key(tenantId, id)) ?? null;
    },
    async save(row) {
      if (!rows.has(key(row.tenantId, row.id))) return;
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    async loadByDocumentIds(tenantId, principalId, documentIds) {
      const wanted = new Set(documentIds);
      return [...rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          row.principalId === principalId &&
          wanted.has(row.hindsightDocumentId),
      );
    },
    async listLiving(tenantId, principalId, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            row.principalId === principalId &&
            row.deletedAt === null,
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, limit);
    },
  };
  return { store, rows };
}

function memoryJudgmentStore() {
  const rows = new Map<string, DerivedJudgmentRow>();
  const evidence = new Map<string, DerivedJudgmentEvidenceRow[]>();
  const key = (tenantId: string, id: string) => `${tenantId}:${id}`;
  const store: DerivedJudgmentStore = {
    async create(row, relation) {
      rows.set(key(row.tenantId, row.id), { ...row });
      evidence.set(
        key(row.tenantId, row.id),
        relation.map((edge) => ({ ...edge })),
      );
    },
    async save(row) {
      if (!rows.has(key(row.tenantId, row.id))) return;
      rows.set(key(row.tenantId, row.id), { ...row });
    },
    async expireUnreviewedBefore() {
      let expired = 0;
      for (const row of rows.values()) {
        if (row.reviewState !== "unreviewed") continue;
        row.reviewState = "expired";
        row.reviewedAt = new Date();
        expired++;
      }
      return expired;
    },
    async load(tenantId, id) {
      return rows.get(key(tenantId, id)) ?? null;
    },
    async loadByDocumentIds(tenantId, principalId, documentIds) {
      const wanted = new Set(documentIds);
      return [...rows.values()].filter(
        (row) =>
          row.tenantId === tenantId &&
          row.principalId === principalId &&
          wanted.has(row.hindsightDocumentId),
      );
    },
    async listOpen(tenantId, principalId, limit) {
      return [...rows.values()]
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            row.principalId === principalId &&
            row.reviewState === "unreviewed" &&
            row.enabled &&
            row.deletedAt === null,
        )
        .sort((a, b) => b.proposedAt.getTime() - a.proposedAt.getTime())
        .slice(0, limit);
    },
    async findByProposalDigest(tenantId, principalId, digest) {
      return (
        [...rows.values()].find(
          (row) =>
            row.tenantId === tenantId &&
            row.principalId === principalId &&
            row.proposalDigest === digest &&
            row.reviewState === "unreviewed",
        ) ?? null
      );
    },
    async loadEvidence(tenantId, judgmentId) {
      return [...(evidence.get(key(tenantId, judgmentId)) ?? [])].sort(
        (a, b) => a.position - b.position,
      );
    },
  };
  return { store, rows };
}

/** The live-authorization facts, as the tenancy tables would answer them here. */
const authorizations: SourceBoundAuthorizationStore = {
  async workspaceMembershipActive(_tenantId, _principalId, workspaceId) {
    return workspaceId === WORKSPACE_A || workspaceId === WORKSPACE_B;
  },
  async enabledSourceIds() {
    return [];
  },
  async botAuthorized() {
    return false;
  },
};

function serviceConfig() {
  return {
    apiUrl: CONTRACT_URL,
    serviceApiKey: CONTRACT_API_KEY ?? "unset",
    assertionSecret: CONTRACT_SECRET ?? "unset",
    requestTimeoutMs: API_MS,
  };
}

/** Seed one confirmed general preference directly in the authority store. */
function seedPreference(
  store: PreferenceRecordStore,
  id: string,
  content: string,
): PreferenceAuthorityRow {
  const at = new Date();
  const row: PreferenceAuthorityRow = {
    tenantId: TENANT,
    id,
    principalId: PRINCIPAL,
    content,
    provenance: "contract run",
    reviewState: "confirmed",
    enabled: true,
    deletedAt: null,
    markedGenericAt: at,
    hindsightDocumentId: preferenceDocumentIdFor(TENANT, id),
    syncedContentDigest: null,
    syncedAt: null,
    effectiveFrom: at,
    effectiveUntil: null,
    supersededBy: null,
    supersededTimeUnknown: false,
    correctedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  void store.create(row);
  return row;
}

/** Seed one confirmed team-bound fact directly in the authority store. */
function seedTeamFact(
  store: SourceBoundRecordStore,
  id: string,
  content: string,
): SourceBoundRecordRow {
  const at = new Date();
  const row: SourceBoundRecordRow = {
    tenantId: TENANT,
    id,
    principalId: PRINCIPAL,
    restriction: "team",
    workspaceId: WORKSPACE_A,
    sourceId: null,
    agentId: null,
    content,
    provenance: "contract run",
    reviewState: "confirmed",
    enabled: true,
    deletedAt: null,
    formedAt: at,
    hindsightDocumentId: sourceBoundDocumentIdFor(TENANT, id),
    syncedContentDigest: null,
    syncedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  void store.create(row);
  return row;
}

/** Recall through the seam until it answers something, or the pipeline window runs out. */
async function pollRecall(
  service: ReturnType<typeof createDerivedJudgmentReviewService>,
  scope: PlatformScope,
  query: string,
): Promise<RecalledDerivedJudgment[]> {
  const deadline = Date.now() + PIPELINE_POLL_MS;
  for (;;) {
    const recalled = await service.recallDerivedJudgments(scope, {
      query,
      askingAgentId: "contract-bot",
    });
    if (recalled.length) return recalled;
    if (Date.now() > deadline) return recalled;
    await new Promise((sleep) => setTimeout(sleep, 2000));
  }
}

describe.skipIf(!available)(
  "derived judgment review and recall (#389) on a real instance",
  () => {
    test("confirm→recall end to end: the Bot gets the adopted judgment, with its citations", async () => {
      const preferences = memoryPreferenceStore();
      const sourceBound = memorySourceBoundStore();
      const judgments = memoryJudgmentStore();
      const proposals = createDerivedJudgmentService(
        preferences.store,
        sourceBound.store,
        judgments.store,
        authorizations,
      );
      const review = createDerivedJudgmentReviewService(
        preferences.store,
        sourceBound.store,
        judgments.store,
        authorizations,
        serviceConfig(),
      );
      const scope = await makeTrustedScope(PRINCIPAL, WORKSPACE_A);
      const marker = `judgment-risk-first-${run}`;
      const first = seedPreference(
        preferences.store,
        `pref-a-${run}`,
        `周报要点风格 ${marker}`,
      );
      const second = seedPreference(
        preferences.store,
        `pref-b-${run}`,
        `周报风险优先 ${marker}`,
      );
      const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
        judgment: `周报用简短要点，风险优先（${marker}）`,
        evidence: [first.hindsightDocumentId, second.hindsightDocumentId],
      });
      const outcome = await review.confirmDerivedJudgment(scope, candidate.id);
      expect(outcome.remoteSynced).toBe(true);
      expect(outcome.judgment.reviewState).toBe("confirmed");

      const recalled = await pollRecall(review, scope, marker);
      expect(recalled.length).toBeGreaterThanOrEqual(1);
      const mine = recalled.find((item) => item.id === candidate.id);
      expect(mine).toBeDefined();
      // The person's adopted text, byte for byte — never the stand-in's extraction shape.
      expect(mine?.content).toBe(`周报用简短要点，风险优先（${marker}）`);
      expect(mine?.scope).toEqual({ kind: "general" });
      expect(mine?.evidence.map((item) => item.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      // The contract carries no bank and no document id.
      const serialized = JSON.stringify(recalled);
      expect(serialized).not.toContain(userBankFor(PRINCIPAL));
      expect(serialized).not.toContain("hdj_");
    });

    test("a team judgment recalls from its own team bank and never from another team's", async () => {
      const preferences = memoryPreferenceStore();
      const sourceBound = memorySourceBoundStore();
      const judgments = memoryJudgmentStore();
      const proposals = createDerivedJudgmentService(
        preferences.store,
        sourceBound.store,
        judgments.store,
        authorizations,
      );
      const review = createDerivedJudgmentReviewService(
        preferences.store,
        sourceBound.store,
        judgments.store,
        authorizations,
        serviceConfig(),
      );
      const scopeA = await makeTrustedScope(PRINCIPAL, WORKSPACE_A);
      const marker = `team-judgment-${run}`;
      const first = seedTeamFact(
        sourceBound.store,
        `fact-a-${run}`,
        `团队业务事实甲 ${marker}`,
      );
      const second = seedTeamFact(
        sourceBound.store,
        `fact-b-${run}`,
        `团队业务事实乙 ${marker}`,
      );
      const candidate = await proposals.proposeDerivedJudgmentCandidate(
        scopeA,
        {
          judgment: `团队综合判断：${marker}`,
          evidence: [first.hindsightDocumentId, second.hindsightDocumentId],
        },
      );
      const outcome = await review.confirmDerivedJudgment(scopeA, candidate.id);
      expect(outcome.remoteSynced).toBe(true);
      expect(outcome.judgment.scope).toEqual({
        kind: "team",
        workspaceId: WORKSPACE_A,
      });

      // Asking from team A: the judgment is in team A's bank and answers.
      const fromA = await pollRecall(review, scopeA, marker);
      const mine = fromA.find((item) => item.id === candidate.id);
      expect(mine).toBeDefined();
      expect(mine?.content).toBe(`团队综合判断：${marker}`);
      expect(mine?.scope).toEqual({ kind: "team", workspaceId: WORKSPACE_A });

      // Asking from team B: the service searches team B's bank, where this judgment was
      // never retained — team A's bank is not B's to read, so nothing answers. The team-A
      // recall above already answered, so the pipeline's latency is not the reason.
      const scopeB = await makeTrustedScope(PRINCIPAL, WORKSPACE_B);
      const fromB = await review.recallDerivedJudgments(scopeB, {
        query: marker,
        askingAgentId: "contract-bot",
      });
      expect(fromB.map((item) => item.id)).not.toContain(candidate.id);
    });

    test("an unconfirmed candidate was never retained, so no recall finds it", async () => {
      const preferences = memoryPreferenceStore();
      const sourceBound = memorySourceBoundStore();
      const judgments = memoryJudgmentStore();
      const proposals = createDerivedJudgmentService(
        preferences.store,
        sourceBound.store,
        judgments.store,
        authorizations,
      );
      const review = createDerivedJudgmentReviewService(
        preferences.store,
        sourceBound.store,
        judgments.store,
        authorizations,
        serviceConfig(),
      );
      const scope = await makeTrustedScope(PRINCIPAL, WORKSPACE_A);
      const marker = `unreviewed-judgment-${run}`;
      const first = seedPreference(
        preferences.store,
        `pref-c-${run}`,
        `未审依据甲 ${marker}`,
      );
      const second = seedPreference(
        preferences.store,
        `pref-d-${run}`,
        `未审依据乙 ${marker}`,
      );
      const candidate = await proposals.proposeDerivedJudgmentCandidate(scope, {
        judgment: `从未出库的判断（${marker}）`,
        evidence: [first.hindsightDocumentId, second.hindsightDocumentId],
      });
      expect(candidate.reviewState).toBe("unreviewed");
      const recalled = await review.recallDerivedJudgments(scope, {
        query: marker,
        askingAgentId: "contract-bot",
      });
      expect(recalled.map((item) => item.id)).not.toContain(candidate.id);
    });
  },
);
