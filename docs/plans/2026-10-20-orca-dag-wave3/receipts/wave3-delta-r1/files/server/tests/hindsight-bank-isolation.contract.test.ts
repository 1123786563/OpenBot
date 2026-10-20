import { randomUUID } from "node:crypto";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  companySchemaFor,
  type HindsightBankScope,
  mintBankScopeAssertion,
  userBankFor,
} from "../src/hindsight/bank-scope";

/*
 * Hindsight 04 (#381): the allow/deny contract on a REAL self-hosted Hindsight instance.
 *
 * The instance is the dedicated throwaway booted by deploy/hindsight/test/contract-instance.sh
 * (same pinned image as the deployment recipe, OpenBot's tenant/validator extensions mounted,
 * model calls answered by the local gateway stand-in). The matrix below is the ticket's
 * verification: two companies, the SAME global user holding a principal in each, a wrong bank,
 * and forged credentials — every allow and every refusal against the service's real behavior,
 * not a mock. Assertions are minted by the production seam (mintBankScopeAssertion), so a pass
 * here also proves the TypeScript mint and the Python extension verify the same bytes.
 *
 * When the instance is not reachable the suite skips loudly (one probe names the gap) instead
 * of pretending: `contract-instance.sh start` boots it, `stop` tears it down.
 */

const CONTRACT_URL =
  process.env.HINDSIGHT_CONTRACT_URL ?? "http://127.0.0.1:8889";
const CONTRACT_API_KEY = process.env.HINDSIGHT_CONTRACT_API_KEY;
const CONTRACT_SECRET = process.env.HINDSIGHT_CONTRACT_ASSERTION_SECRET;

/** Two companies; one global user with a principal in each. */
const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_acme-${run}`;
const TENANT_B = `tn_globex-${run}`;
const PRINCIPAL_A = `prin_same-person-a-${run}`;
const PRINCIPAL_B = `prin_same-person-b-${run}`;
/** Another person's principal in company A — the cross-user guess. */
const PRINCIPAL_OTHER = `prin_other-person-${run}`;

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

function grant(
  tenantId: string,
  principalId: string,
): { scope: HindsightBankScope; bank: string; token: string } {
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
const recall = (bank: string, token: string, query: string) =>
  hindsight(`/v1/default/banks/${bank}/memories/recall`, {
    token,
    body: { query },
  });

describe.skipIf(!available)(
  "hindsight bank isolation (#381) on a real instance",
  () => {
    const companyA = grant(TENANT_A, PRINCIPAL_A);
    const companyB = grant(TENANT_B, PRINCIPAL_B);
    const otherUser = grant(TENANT_A, PRINCIPAL_OTHER);

    test("the service identity is the pair: the shared key alone authorizes nothing", async () => {
      // Key present, assertion header absent entirely.
      const response = await recall(companyA.bank, "", "anything");
      expect(response.status).toBe(401);
      // Key present, empty assertion string.
      const empty = await hindsight(
        `/v1/default/banks/${companyA.bank}/memories/recall`,
        { token: "", body: { query: "anything" } },
      );
      expect(empty.status).toBe(401);
    });

    test("a wrong service key is refused before anything else", async () => {
      const response = await hindsight(
        `/v1/default/banks/${companyA.bank}/memories/recall`,
        {
          key: "forged-service-key",
          token: companyA.token,
          body: { query: "anything" },
        },
      );
      expect(response.status).toBe(401);
    });

    test("a forged assertion (self-signed with a foreign secret) never authenticates", async () => {
      const forged = mintBankScopeAssertion(companyA.scope, {
        secret: "an-attacker-secret",
        ttlMs: 60_000,
      });
      const response = await recall(companyA.bank, forged, "anything");
      expect(response.status).toBe(401);
    });

    test("a tampered assertion body is refused", async () => {
      const [version, body, signature] = companyA.token.split(".");
      // Move company A's grant into company B's schema after signing.
      const decoded = JSON.parse(
        Buffer.from(body, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      decoded.sch = companyB.scope.schema;
      decoded.b = [companyB.bank];
      const tampered = `${version}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
      const response = await recall(companyB.bank, tampered, "anything");
      expect(response.status).toBe(401);
    });

    test("an expired assertion is refused", async () => {
      const stale = mintBankScopeAssertion(companyA.scope, {
        secret: CONTRACT_SECRET ?? "unset",
        ttlMs: 60_000,
        now: new Date(Date.now() - 120_000),
      });
      const response = await recall(companyA.bank, stale, "anything");
      expect(response.status).toBe(401);
    });

    test("the granted bank retains and recalls: the allow path", async () => {
      const marker = `acme-onboarding-preference-${run}`;
      const document = `doc-allow-${run}`;
      const put = await hindsight(
        `/v1/default/banks/${companyA.bank}/memories`,
        {
          token: companyA.token,
          body: {
            items: [
              {
                content: `The person prefers ${marker} in the morning standup`,
                document_id: document,
              },
            ],
          },
        },
      );
      expect([200, 201, 202]).toContain(put.status);
      // The recall pipeline runs end to end under the grant (the gateway stand-in extracts
      // no facts, so recall answers empty rather than erroring — the HTTP contract holds).
      const read = await recall(companyA.bank, companyA.token, marker);
      expect(read.status).toBe(200);
      // The stored document is readable under the same grant, verbatim.
      const stored = await hindsight(
        `/v1/default/banks/${companyA.bank}/documents/${document}`,
        { token: companyA.token, method: "GET" },
      );
      expect(stored.status).toBe(200);
      const doc = (await stored.json()) as { original_text?: string };
      expect(doc.original_text ?? "").toContain(marker);
    });

    test("the same global user's other company is a different, isolated scope", async () => {
      // Give company B's bank a document of its own so the bank exists, then retain a
      // company-A-only document: through company B's scope it must not exist at all.
      const settle = await hindsight(
        `/v1/default/banks/${companyB.bank}/memories`,
        {
          token: companyB.token,
          body: {
            items: [
              {
                content: `globex standup is on tuesdays ${run}`,
                document_id: `doc-b-${run}`,
              },
            ],
          },
        },
      );
      expect([200, 201, 202]).toContain(settle.status);
      const document = `doc-a-only-${run}`;
      const put = await hindsight(
        `/v1/default/banks/${companyA.bank}/memories`,
        {
          token: companyA.token,
          body: {
            items: [
              {
                content: `Salary review notes acme-only-${run}`,
                document_id: document,
              },
            ],
          },
        },
      );
      expect([200, 201, 202]).toContain(put.status);
      const throughB = await hindsight(
        `/v1/default/banks/${companyB.bank}/documents/${document}`,
        { token: companyB.token, method: "GET" },
      );
      expect(throughB.status).toBe(404);
      const throughA = await hindsight(
        `/v1/default/banks/${companyA.bank}/documents/${document}`,
        { token: companyA.token, method: "GET" },
      );
      expect(throughA.status).toBe(200);
    });

    test("a cross-company bank is refused even with the victim's exact bank id", async () => {
      // Company A's assertion naming company B's bank: the validator refuses.
      const response = await recall(companyB.bank, companyA.token, "anything");
      expect(response.status).toBe(403);
      const put = await retain(companyB.bank, companyA.token, "stolen write");
      expect(put.status).toBe(403);
    });

    test("a cross-user bank in the same company is refused", async () => {
      const response = await recall(otherUser.bank, companyA.token, "anything");
      expect(response.status).toBe(403);
    });

    test("a well-formed but guessed bank is refused", async () => {
      // A bank id nobody granted: right shape (ob_u_ + 16 hex), wrong subject.
      const guessed = userBankFor(`prin-nobody-${run}`);
      const response = await recall(guessed, companyA.token, "anything");
      expect(response.status).toBe(403);
    });

    test("tags cannot widen the grant: a tagged recall still confines to the bank", async () => {
      // Recall company B's bank with company A's token, asking for shared/no-tag results.
      const response = await hindsight(
        `/v1/default/banks/${companyB.bank}/memories/recall`,
        {
          token: companyA.token,
          body: { query: "everything", tags: [], tags_match: "any" },
        },
      );
      expect(response.status).toBe(403);
      // And the same trick on another user's bank in the same company.
      const sameCompany = await hindsight(
        `/v1/default/banks/${otherUser.bank}/memories/recall`,
        {
          token: companyA.token,
          body: { query: "everything", tags: ["shared"] },
        },
      );
      expect(sameCompany.status).toBe(403);
    });

    test("delete is allowed on the granted bank and refused elsewhere", async () => {
      // Create a document in the granted bank, then delete it: allowed.
      const marker = `to-delete-${run}`;
      const put = await hindsight(
        `/v1/default/banks/${companyA.bank}/memories`,
        {
          token: companyA.token,
          body: { items: [{ content: marker, document_id: marker }] },
        },
      );
      expect([200, 201, 202]).toContain(put.status);
      const removed = await hindsight(
        `/v1/default/banks/${companyA.bank}/documents/${encodeURIComponent(marker)}`,
        { token: companyA.token, method: "DELETE" },
      );
      expect([200, 202, 204]).toContain(removed.status);
      // The same document id under another user's bank: refused.
      const stolen = await hindsight(
        `/v1/default/banks/${otherUser.bank}/documents/${encodeURIComponent(marker)}`,
        { token: companyA.token, method: "DELETE" },
      );
      expect(stolen.status).toBe(403);
    });

    test("the bank list shows exactly the granted banks", async () => {
      const response = await hindsight(`/v1/default/banks`, {
        token: companyA.token,
        method: "GET",
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        banks?: { bank_id?: string }[];
      };
      const ids = (payload.banks ?? []).map((bank) => bank.bank_id);
      expect(ids).toContain(companyA.bank);
      expect(ids).not.toContain(companyB.bank);
      expect(ids).not.toContain(otherUser.bank);
    });
  },
);

describe.skipIf(available)(
  "hindsight bank isolation (#381) instance unavailable",
  () => {
    test("the real-instance contract matrix did not run", () => {
      // Loud skip, not silence: boot with deploy/hindsight/test/contract-instance.sh start.
      expect(available).toBe(false);
    });
  },
);
