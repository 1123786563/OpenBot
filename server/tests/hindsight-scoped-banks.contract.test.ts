import { randomUUID } from "node:crypto";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  botBankFor,
  companySchemaFor,
  type HindsightBankScope,
  mintBankScopeAssertion,
  sourceBankFor,
  teamBankFor,
} from "../src/hindsight/bank-scope";

/*
 * Hindsight 06 (#383): the multi-bank scoped grant on a REAL self-hosted Hindsight instance.
 *
 * #381's contract suite (hindsight-bank-isolation.contract.test.ts) pinned the single-bank
 * allow/deny matrix; this suite pins what the source-bound recall adds on top: ONE assertion
 * may name several banks (the asking workspace's team bank, enabled sources' banks, the
 * asking Bot's own bank), the service allows exactly those and refuses every other bank —
 * including another team's bank in the SAME company schema, which is the service-side half of
 * "team B's Bots cannot use team A's business facts" — and tags change none of it.
 *
 * The instance is the dedicated throwaway booted by deploy/hindsight/test/contract-instance.sh;
 * when it is not reachable the suite skips loudly instead of pretending. Assertions are minted
 * by the production seam (mintBankScopeAssertion) with the bank derivations the scoped resolver
 * uses, so a pass here proves the TypeScript placement vocabulary and the Python extension
 * agree on multi-bank grants too.
 */

const CONTRACT_URL =
  process.env.HINDSIGHT_CONTRACT_URL ?? "http://127.0.0.1:8889";
const CONTRACT_API_KEY = process.env.HINDSIGHT_CONTRACT_API_KEY;
const CONTRACT_SECRET = process.env.HINDSIGHT_CONTRACT_ASSERTION_SECRET;

const run = randomUUID().slice(0, 8);
const TENANT = `tn_scoped-${run}`;
const WORKSPACE_A = `ws_team-a-${run}`;
const WORKSPACE_B = `ws_team-b-${run}`;
const SOURCE_ONE = `src_connected-${run}`;
const BOT_ONE = `agt_bot-${run}`;

const API_A = 10_000;

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

/** The scoped grant's banks: the asking workspace, one enabled source, the asking Bot. */
const TEAM_BANK_A = teamBankFor(WORKSPACE_A);
const TEAM_BANK_B = teamBankFor(WORKSPACE_B);
const SOURCE_BANK = sourceBankFor(SOURCE_ONE);
const BOT_BANK = botBankFor(BOT_ONE);

function mint(banks: string[]): string {
  const scope: HindsightBankScope = {
    schema: companySchemaFor(TENANT),
    banks: banks.map((id) => ({
      id,
      kind: id === TEAM_BANK_A || id === TEAM_BANK_B
        ? ("team" as const)
        : id === SOURCE_BANK
          ? ("source" as const)
          : ("bot" as const),
    })),
    tenantId: TENANT,
    principalId: `prin_scoped-${run}`,
  };
  return mintBankScopeAssertion(scope, {
    secret: CONTRACT_SECRET ?? "unset",
    ttlMs: 5 * 60_000,
  });
}

const SCOPED_TOKEN = mint([TEAM_BANK_A, SOURCE_BANK, BOT_BANK]);
const TEAM_B_TOKEN = mint([TEAM_BANK_B]);

function hindsight(
  path: string,
  init: {
    token?: string | null;
    key?: string;
    body?: unknown;
    method?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (init.key !== "")
    headers.authorization = `Bearer ${init.key ?? CONTRACT_API_KEY}`;
  if (init.token !== null) headers["x-openbot-bank-scope"] = init.token ?? "";
  return fetch(`${CONTRACT_URL}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(API_A),
  });
}

const retain = (bank: string, token: string, content: string) =>
  hindsight(`/v1/default/banks/${bank}/memories`, {
    token,
    body: { items: [{ content }] },
  });

describe.skipIf(!available)(
  "hindsight scoped banks (#383) on a real instance",
  () => {
    test("the multi-bank grant retains into each granted bank, and reads each back", async () => {
      for (const [bank, label] of [
        [TEAM_BANK_A, "team"],
        [SOURCE_BANK, "source"],
        [BOT_BANK, "bot"],
      ] as const) {
        const marker = `scoped-${label}-${run}`;
        const document = `doc-scoped-${label}-${run}`;
        const put = await hindsight(
          `/v1/default/banks/${bank}/memories`,
          {
            token: SCOPED_TOKEN,
            body: {
              items: [
                {
                  content: `The ${label} fact ${marker} for the source-bound recall`,
                  document_id: document,
                },
              ],
            },
          },
        );
        expect([200, 201, 202]).toContain(put.status);
        const stored = await hindsight(
          `/v1/default/banks/${bank}/documents/${document}`,
          { token: SCOPED_TOKEN, method: "GET" },
        );
        expect(stored.status).toBe(200);
        const doc = (await stored.json()) as { original_text?: string };
        expect(doc.original_text ?? "").toContain(marker);
      }
    });

    test("recall holds its HTTP contract on every granted bank", async () => {
      for (const bank of [TEAM_BANK_A, SOURCE_BANK, BOT_BANK]) {
        const response = await hindsight(
          `/v1/default/banks/${bank}/memories/recall`,
          { token: SCOPED_TOKEN, body: { query: `scoped ${run}` } },
        );
        expect(response.status).toBe(200);
      }
    });

    test("another team's bank in the same company schema is outside the grant", async () => {
      // The bank is well-formed, derives from the same company, and is simply not named.
      const read = await hindsight(
        `/v1/default/banks/${TEAM_BANK_B}/memories/recall`,
        { token: SCOPED_TOKEN, body: { query: "anything" } },
      );
      expect(read.status).toBe(403);
      const write = await retain(TEAM_BANK_B, SCOPED_TOKEN, "must not land");
      expect(write.status).toBe(403);
    });

    test("a narrower grant cannot touch the scoped caller's banks", async () => {
      // Team B's own grant against team A's bank: same company, wrong grant.
      const response = await hindsight(
        `/v1/default/banks/${TEAM_BANK_A}/memories/recall`,
        { token: TEAM_B_TOKEN, body: { query: "anything" } },
      );
      expect(response.status).toBe(403);
    });

    test("tags do not widen the bank boundary", async () => {
      const response = await hindsight(
        `/v1/default/banks/${TEAM_BANK_B}/memories`,
        {
          token: SCOPED_TOKEN,
          body: {
            items: [
              {
                content: "tagged content must not cross banks",
                document_id: `doc-tagged-${run}`,
                tags: [TEAM_BANK_A, "shared-project"],
              },
            ],
          },
        },
      );
      expect(response.status).toBe(403);
    });
  },
);
