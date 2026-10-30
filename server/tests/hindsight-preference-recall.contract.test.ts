import { randomUUID } from "node:crypto";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import { enterpriseWorkspaceMemberships } from "../src/db/schema/enterprise-tenancy";
import type { Database } from "../src/db/client";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  companySchemaFor,
  type HindsightBankScope,
  mintBankScopeAssertion,
  userBankFor,
} from "../src/hindsight/bank-scope";
import {
  createPreferenceRecallService,
  type PreferenceAuthorityRow,
  type PreferenceRecordStore,
  preferenceDocumentIdFor,
} from "../src/hindsight/preference-recall";

/*
 * Hindsight 05 (#382): the general-personal-preference recall seam on a REAL self-hosted
 * Hindsight instance — the dedicated throwaway booted by deploy/hindsight/test/
 * contract-instance.sh, whose gateway stand-in (since this ticket) answers extraction with
 * one echo fact per request so the retain→recall pipeline actually produces hits.
 *
 * What only the real service can prove here:
 *   - the confirm path's retain rides the real submission pipeline end to end (documents
 *     stored, facts extracted, embeddings written through the approved-gateway stand-in);
 *   - a recall through the seam returns the hit's document_id from the REAL search stack —
 *     and the seam answers the OpenBot-confirmed original, never the extracted fact text;
 *   - a document retained straight into the bank outside this seam (the orphan/forgery
 *     shape) hits at recall and is dropped: no current OpenBot row, no Bot-visible content;
 *   - the same global user's two companies stay two banks on the real service, and asking
 *     through the other company's scope answers nothing of the first.
 *
 * The authority rows are an in-memory store (the SQL store is the integration suite's
 * subject; both implement the same port, and every recall rule lives above the port). When
 * the instance is not reachable the suite skips loudly, exactly like #381's contract suite.
 */

const CONTRACT_URL =
  process.env.HINDSIGHT_CONTRACT_URL ?? "http://127.0.0.1:8889";
const CONTRACT_API_KEY = process.env.HINDSIGHT_CONTRACT_API_KEY;
const CONTRACT_SECRET = process.env.HINDSIGHT_CONTRACT_ASSERTION_SECRET;

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_acme-${run}`;
const TENANT_B = `tn_globex-${run}`;
const WORKSPACE = `ws_team-${run}`;
const PRINCIPAL_A = `prin_same-person-a-${run}`;
const PRINCIPAL_B = `prin_same-person-b-${run}`;
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

// Boolean, never the && chain's undefined: the loud-skip guard asserts false
// when the contract env is absent, so the missing-env case must read false.
const available = Boolean(CONTRACT_API_KEY && CONTRACT_SECRET && (await live()));

// The controlled-directory technique from hindsight-bank-scope.test.ts, so the scopes this
// suite recalls through carry the real issuedScopes trust marker.
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
  tenantId: string,
  principalId: string,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    selectTenant: () => tenantId,
    selectWorkspace: () => WORKSPACE,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

function forgedScope(tenantId: string, principalId: string): PlatformScope {
  return Object.freeze({
    tenantId,
    workspaceId: WORKSPACE,
    principalId,
    actorId: GLOBAL_ACTOR,
    memberEpoch: 3,
    aclEpoch: 1,
    entrypoint: "web",
  } satisfies PlatformScope);
}

/** The in-memory authority store; same port as the SQL store, so the recall rules match. */
function memoryStore() {
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

function grantFor(
  tenantId: string,
  principalId: string,
): {
  scope: HindsightBankScope;
  bank: string;
  token: string;
} {
  const scope: HindsightBankScope = {
    schema: companySchemaFor(tenantId),
    banks: [{ id: userBankFor(principalId), kind: "user" }],
    tenantId,
    principalId,
  };
  return {
    scope,
    bank: scope.banks[0].id,
    token: mintBankScopeAssertion(scope, {
      secret: CONTRACT_SECRET ?? "unset",
      ttlMs: 5 * 60_000,
    }),
  };
}

/** Retain a document straight into the bank, outside the seam — the orphan shape. */
async function retainRaw(
  bank: string,
  token: string,
  documentId: string,
  content: string,
): Promise<number> {
  const response = await fetch(
    `${CONTRACT_URL}/v1/default/banks/${bank}/memories`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONTRACT_API_KEY}`,
        "x-openbot-bank-scope": token,
      },
      body: JSON.stringify({
        items: [{ content, document_id: documentId }],
      }),
      signal: AbortSignal.timeout(API_MS),
    },
  );
  return response.status;
}

/** Raw recall as the service sees it — the hit list before the seam's drop rules. */
async function rawRecall(
  bank: string,
  token: string,
  query: string,
): Promise<{ results?: { document_id?: string }[] }> {
  const response = await fetch(
    `${CONTRACT_URL}/v1/default/banks/${bank}/memories/recall`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONTRACT_API_KEY}`,
        "x-openbot-bank-scope": token,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(API_MS),
    },
  );
  if (!response.ok) throw new Error(`raw recall answered ${response.status}`);
  return (await response.json()) as { results?: { document_id?: string }[] };
}

/** Recall through the seam until it answers something, or the pipeline window runs out. */
async function pollRecall(
  service: ReturnType<typeof createPreferenceRecallService>,
  scope: PlatformScope,
  query: string,
  askingAgentId = "contract-bot",
): Promise<ReturnType<typeof service.recallGenericPreferences>> {
  const deadline = Date.now() + PIPELINE_POLL_MS;
  for (;;) {
    const recalled = await service.recallGenericPreferences(scope, {
      query,
      askingAgentId,
    });
    if (recalled.length) return recalled;
    if (Date.now() > deadline) return recalled;
    await new Promise((sleep) => setTimeout(sleep, 2000));
  }
}

describe.skipIf(!available)(
  "generic preference recall (#382) on a real instance",
  () => {
    test("confirm→recall end to end: the Bot gets the OpenBot original, not the extraction", async () => {
      const { store } = memoryStore();
      const service = createPreferenceRecallService(store, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "unset",
        assertionSecret: CONTRACT_SECRET ?? "unset",
        requestTimeoutMs: API_MS,
      });
      const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
      const marker = `weekly-report-risk-first-${run}`;
      const original = `周报用简短要点，风险优先（${marker}）`;
      const { record, remoteSynced } = await service.confirmGenericPreference(
        scope,
        { content: original, provenance: "contract run" },
      );
      expect(remoteSynced).toBe(true);

      const recalled = await pollRecall(service, scope, marker);
      expect(recalled.length).toBeGreaterThanOrEqual(1);
      const mine = recalled.find((item) => item.id === record.id);
      expect(mine).toBeDefined();
      // The confirmed original, byte for byte — never the stand-in's extraction shape.
      expect(mine?.content).toBe(original);
      expect(mine?.content).not.toContain("stand-in extracted");
      // The contract carries no bank and no document id.
      const serialized = JSON.stringify(recalled);
      expect(serialized).not.toContain(userBankFor(PRINCIPAL_A));
      expect(serialized).not.toContain(
        preferenceDocumentIdFor(TENANT_A, record.id),
      );

      // A second asking Bot, same company and person: the same original (the cross-Bot half
      // of AC2, on the real service's own bank scoping).
      const second = await service.recallGenericPreferences(scope, {
        query: marker,
        askingAgentId: "contract-other-bot",
      });
      expect(second.map((item) => item.id)).toContain(record.id);
      expect(second.find((item) => item.id === record.id)?.content).toBe(
        original,
      );
    });

    test("an orphan document retained outside the seam hits and is dropped", async () => {
      const { store } = memoryStore();
      const service = createPreferenceRecallService(store, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "unset",
        assertionSecret: CONTRACT_SECRET ?? "unset",
        requestTimeoutMs: API_MS,
      });
      const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
      const grant = grantFor(TENANT_A, PRINCIPAL_A);
      const marker = `orphan-preference-${run}`;
      const orphanDocument = `doc-orphan-${run}`;
      const put = await retainRaw(
        grant.bank,
        grant.token,
        orphanDocument,
        `Someone prefers ${marker} in every draft`,
      );
      expect([200, 201, 202]).toContain(put);

      // The raw service DOES find the orphan (the hit exists)...
      const deadline = Date.now() + PIPELINE_POLL_MS;
      let hits = await rawRecall(grant.bank, grant.token, marker);
      while (
        !(hits.results ?? []).some((hit) => hit.document_id === orphanDocument)
      ) {
        if (Date.now() > deadline) break;
        await new Promise((sleep) => setTimeout(sleep, 2000));
        hits = await rawRecall(grant.bank, grant.token, marker);
      }
      expect(
        (hits.results ?? []).some((hit) => hit.document_id === orphanDocument),
      ).toBe(true);
      // ...and the seam, asked the same thing with an empty authority store, answers
      // nothing: no current OpenBot row, no Bot-visible content.
      const recalled = await service.recallGenericPreferences(scope, {
        query: marker,
        askingAgentId: "contract-bot",
      });
      expect(recalled).toEqual([]);
    });

    test("the same global user's other company answers nothing of the first", async () => {
      const { store } = memoryStore();
      const service = createPreferenceRecallService(store, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "unset",
        assertionSecret: CONTRACT_SECRET ?? "unset",
        requestTimeoutMs: API_MS,
      });
      const scopeA = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
      const marker = `cross-company-preference-${run}`;
      const { record } = await service.confirmGenericPreference(scopeA, {
        content: `甲公司偏好 ${marker}`,
      });
      // Company A's own scope finds it once the pipeline lands.
      const mine = await pollRecall(service, scopeA, marker);
      expect(mine.map((item) => item.id)).toContain(record.id);
      // Company B's scope — the same global actor's other principal — finds nothing, even
      // though the query names A's content exactly.
      const scopeB = await makeTrustedScope(TENANT_B, PRINCIPAL_B);
      const theirs = await service.recallGenericPreferences(scopeB, {
        query: marker,
        askingAgentId: "contract-bot-b",
      });
      expect(theirs).toEqual([]);
    });

    test("the seam rides the production identity pair, and refuses untrusted scopes", async () => {
      const { store } = memoryStore();
      const service = createPreferenceRecallService(store, {
        apiUrl: CONTRACT_URL,
        serviceApiKey: CONTRACT_API_KEY ?? "unset",
        assertionSecret: CONTRACT_SECRET ?? "unset",
        requestTimeoutMs: API_MS,
      });
      const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
      // A recall through the seam reaches the real service and authenticates as the pair.
      await service.recallGenericPreferences(scope, {
        query: `probe-${run}`,
        askingAgentId: "contract-bot",
      });
      // The mint itself is the same verifier the service side runs; the pair's other half is
      // the shared key, which the integration suite already pinned. Here: an untrusted scope
      // never reaches the service at all.
      await expect(
        service.recallGenericPreferences(forgedScope(TENANT_A, PRINCIPAL_A), {
          query: `probe-${run}`,
          askingAgentId: "contract-bot",
        }),
      ).rejects.toThrow("UNVERIFIED_SCOPE");
    });
  },
);

describe.skipIf(available)(
  "generic preference recall (#382) instance unavailable",
  () => {
    test("the real-instance contract suite did not run", () => {
      // Loud skip, not silence: boot with deploy/hindsight/test/contract-instance.sh start.
      expect(available).toBe(false);
    });
  },
);
