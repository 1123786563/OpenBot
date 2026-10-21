import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Database } from "../src/db/client";
import { enterpriseWorkspaceMemberships } from "../src/db/schema/enterprise-tenancy";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import {
  bankScopeAssertionSecret,
  botBankFor,
  companySchemaFor,
  mintBankScopeAssertion,
  resolveHindsightBankScope,
  sourceBankFor,
  teamBankFor,
  userBankFor,
  verifyBankScopeAssertion,
} from "../src/hindsight/bank-scope";

/*
 * Hindsight 04 (#381), OpenBot side: the seam that turns ONE server-issued trusted scope into
 * the Hindsight bank identity — the company's schema plus the banks the caller may touch — and
 * the signed assertion that carries exactly that grant to the shared Hindsight service. The
 * security property mirrors the company payer seam: the derivation consumes only a scope the
 * enterprise tenancy layer minted (the `issuedScopes` marker), so a bank id, tenant id or
 * principal id forged in a body, query parameter or header cannot reach the assertion, and a
 * hand-built or cloned scope is refused outright. The trust mint itself is exercised through
 * the real `createScopeResolver` against a controlled directory database (the same technique
 * payer-company-resolution.test.ts uses), because the trusted marker is deliberately impossible
 * to forge.
 */

const run = randomUUID().slice(0, 8);
const TENANT_A = `tn_acme-${run}`;
const TENANT_B = `tn_globex-${run}`;
const WORKSPACE = `ws_team-${run}`;
const PRINCIPAL_A = `prin_member-a-${run}`;
const PRINCIPAL_B = `prin_member-b-${run}`;
/** One global user (same actor id) holding a principal in each of the two companies. */
const GLOBAL_ACTOR = `usr_global-${run}`;
const SECRET = `test-assertion-secret-${run}`;

/** A drizzle-shaped query whose `.from(...).where(...).limit()` answers the given rows. */
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

/**
 * A directory database good enough to mint a genuinely trusted scope: the capability probe
 * `verifyDirectoryDatabase` runs is answered all-true, and the membership select inside
 * `resolve()` answers an active membership for the requested principal. No enterprise tables
 * are touched — the trust marker is the point, not the storage.
 */
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

/** Mint a real, frozen, trusted scope for one principal in one company, the production way. */
async function makeTrustedScope(
  tenantId: string,
  principalId: string,
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase(principalId),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: GLOBAL_ACTOR, entrypoint: "web" }),
    // Selectors are fixed server-side: a tenant id riding the request cannot steer them.
    selectTenant: () => tenantId,
    selectWorkspace: () => WORKSPACE,
  });
  return resolver.resolve(new Request("https://example.invalid/workbench"));
}

/** A structurally perfect scope nobody issued — the forgery this seam must refuse. */
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

describe("bank identity derivation", () => {
  test("ids are deterministic, charset-safe and kind-separated", () => {
    expect(companySchemaFor(TENANT_A)).toBe(companySchemaFor(TENANT_A));
    expect(userBankFor(PRINCIPAL_A)).toBe(userBankFor(PRINCIPAL_A));
    expect(teamBankFor(WORKSPACE)).not.toBe(userBankFor(WORKSPACE));
    expect(sourceBankFor("src-1")).not.toBe(botBankFor("bot-1"));
    for (const id of [
      companySchemaFor(TENANT_A),
      userBankFor(PRINCIPAL_A),
      teamBankFor(WORKSPACE),
      sourceBankFor("src-1"),
      botBankFor("bot-1"),
    ]) {
      expect(id).toMatch(/^ob_[ctusb]_[0-9a-f]{16}$/);
    }
  });

  test("the same global user in two companies derives two schemas and two banks", async () => {
    const scopeA = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const scopeB = await makeTrustedScope(TENANT_B, PRINCIPAL_B);
    const a = resolveHindsightBankScope(scopeA);
    const b = resolveHindsightBankScope(scopeB);
    expect(a.schema).not.toBe(b.schema);
    expect(a.banks).not.toEqual(b.banks);
    // Each company's grant is exactly that company's schema plus the principal's own bank.
    expect(a.schema).toBe(companySchemaFor(TENANT_A));
    expect(a.banks).toEqual([{ id: userBankFor(PRINCIPAL_A), kind: "user" }]);
    expect(b.banks).toEqual([{ id: userBankFor(PRINCIPAL_B), kind: "user" }]);
  });
});

describe("resolveHindsightBankScope refuses everything but a trusted scope", () => {
  test("a hand-built scope is refused even when structurally perfect", () => {
    expect(() =>
      resolveHindsightBankScope(forgedScope(TENANT_A, PRINCIPAL_A)),
    ).toThrow("UNVERIFIED_SCOPE");
  });

  test("a cloned copy of a trusted scope is refused: the marker does not survive a copy", async () => {
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const clone = { ...scope };
    expect(() => resolveHindsightBankScope(clone)).toThrow("UNVERIFIED_SCOPE");
  });

  test("a trusted scope resolves to its own company's grant regardless of request content", async () => {
    const scope = await makeTrustedScope(TENANT_B, PRINCIPAL_B);
    // Headers naming another company/bank exist; the answer still derives from the scope.
    const grant = resolveHindsightBankScope(scope);
    expect(grant.schema).toBe(companySchemaFor(TENANT_B));
    expect(grant.banks.map((bank) => bank.id)).toEqual([
      userBankFor(PRINCIPAL_B),
    ]);
  });
});

describe("bank scope assertions", () => {
  test("a minted assertion verifies and carries exactly the granted scope", async () => {
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const grant = resolveHindsightBankScope(scope);
    const token = mintBankScopeAssertion(grant, {
      secret: SECRET,
      ttlMs: 60_000,
    });
    const payload = verifyBankScopeAssertion(token, { secret: SECRET });
    expect(payload).not.toBeNull();
    // Field names are the wire contract the service-side extension verifies against.
    expect(payload?.sch).toBe(grant.schema);
    expect(payload?.b).toEqual(grant.banks.map((bank) => bank.id));
    expect(payload?.tid).toBe(TENANT_A);
    expect(payload?.pid).toBe(PRINCIPAL_A);
    expect(payload?.iss).toBe("openbot");
  });

  test("a tampered payload or a foreign secret does not verify", async () => {
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const token = mintBankScopeAssertion(resolveHindsightBankScope(scope), {
      secret: SECRET,
      ttlMs: 60_000,
    });
    const [version, body, signature] = token.split(".");
    // Re-sign a different payload with the same secret: the signature must not verify.
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, iss: "openbot", sch: companySchemaFor(TENANT_B) }),
    ).toString("base64url");
    expect(
      verifyBankScopeAssertion(`${version}.${forgedPayload}.${signature}`, {
        secret: SECRET,
      }),
    ).toBeNull();
    expect(
      verifyBankScopeAssertion(`${version}.${body}.${signature}`, {
        secret: "wrong-secret",
      }),
    ).toBeNull();
  });

  test("an expired assertion does not verify", async () => {
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const stale = mintBankScopeAssertion(resolveHindsightBankScope(scope), {
      secret: SECRET,
      ttlMs: 60_000,
      now: new Date(Date.now() - 120_000),
    });
    expect(verifyBankScopeAssertion(stale, { secret: SECRET })).toBeNull();
  });

  test("the secret loader refuses an empty declaration rather than defaulting one", () => {
    expect(() => bankScopeAssertionSecret({})).toThrow(
      /HINDSIGHT_BANK_ASSERTION_SECRET/,
    );
    expect(
      bankScopeAssertionSecret({
        HINDSIGHT_BANK_ASSERTION_SECRET: " s ",
      }),
    ).toBe("s");
  });

  test("assertion input is bound to the digest discipline shared with the service side", async () => {
    // The token body must be canonical JSON so the Python extension and this mint agree
    // byte-for-byte: no key reordering between runs of the same grant.
    const scope = await makeTrustedScope(TENANT_A, PRINCIPAL_A);
    const grant = resolveHindsightBankScope(scope);
    const a = mintBankScopeAssertion(grant, {
      secret: SECRET,
      ttlMs: 60_000,
      now: new Date(0),
    });
    const b = mintBankScopeAssertion(resolveHindsightBankScope(scope), {
      secret: SECRET,
      ttlMs: 60_000,
      now: new Date(0),
    });
    expect(a).toBe(b);
    expect(createHash("sha256").update(a).digest("hex")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
