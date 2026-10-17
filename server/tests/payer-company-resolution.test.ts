import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { Database } from "../src/db/client";
import type { PlatformScope } from "../src/enterprise/contracts";
import { verifyDirectoryDatabase } from "../src/enterprise/tenancy/connections";
import { createScopeResolver } from "../src/enterprise/tenancy/store";
import { payerKey } from "../src/billing/payer";
import {
  CompanyScopeRequiredError,
  resolvePayerForCompanyContext,
} from "../src/billing/payer-company";

/*
 * The company branch's pure side: the resolution that turns ONE server-issued trusted scope into
 * the one company payer ref. The security property this ticket sells is structural — the function
 * consumes only a scope the enterprise tenancy layer minted (the `issuedScopes` marker), so a
 * forged tenantId/companyId in a body, query parameter or header cannot reach the answer, and a
 * scope that is missing, hand-built or cloned is refused outright: never a personal ref, never a
 * deployment ref, no fallback. The trust mint itself is exercised through the real
 * `createScopeResolver` against a controlled directory database (the same technique the
 * enterprise suite uses), because the trusted marker is deliberately impossible to forge.
 */

const run = randomRun();
const TENANT = `tn_acme-${run}`;
const WORKSPACE = `ws_team-${run}`;
const PRINCIPAL = `prin_member-${run}`;
const ACTOR = `usr_member-${run}`;

function randomRun(): string {
  return Math.random().toString(36).slice(2, 10);
}

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
 * `resolve()` answers `rows`. No enterprise tables are touched — the trust marker is the point,
 * not the storage (the billing side of this ticket runs against the real test database in the
 * integration file).
 */
function controlledDirectoryDatabase(
  rows: readonly Record<string, unknown>[],
): Database {
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
        select: () => controlledQuery(() => rows),
      }),
  } as unknown as Database;
}

/**
 * A resolver whose tenant/workspace selection is fixed server-side (the way production reads its
 * own trusted selectors before the membership check), with one active membership row answering
 * the directory query — so `resolve(request)` mints a real, frozen, trusted scope.
 */
async function makeTrustedScope(
  request: Request,
  overrides: Partial<PlatformScope> = {},
): Promise<PlatformScope> {
  const directory = await verifyDirectoryDatabase(
    controlledDirectoryDatabase([
      {
        principalId: PRINCIPAL,
        tenantStatus: "active",
        principalStatus: "active",
        memberStatus: "active",
        memberEpoch: 3,
      },
    ]),
  );
  const resolver = createScopeResolver(directory, {
    authenticate: async () => ({ actorId: ACTOR, entrypoint: "web" }),
    selectTenant: () => overrides.tenantId ?? TENANT,
    selectWorkspace: () => overrides.workspaceId ?? WORKSPACE,
  });
  return resolver.resolve(request);
}

describe("resolvePayerForCompanyContext resolves a trusted company scope", () => {
  test("a server-minted scope answers exactly the company ref for its tenant", async () => {
    const scope = await makeTrustedScope(
      new Request("https://example.invalid/workbench"),
    );
    expect(resolvePayerForCompanyContext(scope)).toEqual({
      kind: "company",
      id: TENANT,
    });
  });

  test("the resolved ref derives the company account key the writer keys on", async () => {
    const scope = await makeTrustedScope(
      new Request("https://example.invalid/workbench"),
    );
    expect(payerKey(resolvePayerForCompanyContext(scope))).toBe(
      `openbot-company-${TENANT}`,
    );
  });

  test("forged tenant/company identifiers in the request cannot steer the answer", async () => {
    // The forgery attempt a company-workbench request might carry, in every channel a client
    // controls: query parameters and headers. The resolver's selectors are server code, the
    // minted scope carries the membership-verified tenant, and the answer follows that scope —
    // the attacker-chosen strings never become the payer.
    const forged = new Request(
      `https://example.invalid/workbench?tenantId=tn_attacker&companyId=co_attacker&tenant=${TENANT}`,
      {
        headers: {
          "x-tenant-id": "tn_attacker",
          "x-company-id": "co_attacker",
        },
      },
    );
    const scope = await makeTrustedScope(forged);
    expect(scope.tenantId).toBe(TENANT);
    expect(resolvePayerForCompanyContext(scope)).toEqual({
      kind: "company",
      id: TENANT,
    });
  });

  test("the resolution is deterministic: the same scope answers the same ref", async () => {
    const scope = await makeTrustedScope(
      new Request("https://example.invalid/workbench"),
    );
    expect(resolvePayerForCompanyContext(scope)).toEqual(
      resolvePayerForCompanyContext(scope),
    );
  });
});

describe("resolvePayerForCompanyContext refuses everything that is not a trusted scope", () => {
  test("a cloned trusted scope is refused: trust rides on the issued object itself", async () => {
    const scope = await makeTrustedScope(
      new Request("https://example.invalid/workbench"),
    );
    const clone = { ...scope };
    // A spread copy carries every field the original had — and still must not pass, or a
    // downstream caller could relax trust by copying. Refused, never re-answered as a ref.
    expect(() => resolvePayerForCompanyContext(clone)).toThrow(
      CompanyScopeRequiredError,
    );
    try {
      resolvePayerForCompanyContext(clone);
      throw new Error("unreachable: the clone must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(CompanyScopeRequiredError);
      const refused = error as CompanyScopeRequiredError;
      expect(refused.code).toBe("company_scope_required");
      expect(refused.reason).toBe("untrusted");
    }
  });

  test("a hand-built scope with a complete PlatformScope shape is refused", () => {
    // Every field a forger would fill in, all plausible — and still not server-issued, so the
    // answer is the same refusal, not a company account for the attacker's tenant.
    const forged: PlatformScope = {
      tenantId: "tn_attacker",
      workspaceId: "ws_attacker",
      principalId: "prin_attacker",
      actorId: "usr_attacker",
      memberEpoch: 1,
      aclEpoch: 1,
      entrypoint: "web",
    };
    const refused = (() => {
      try {
        resolvePayerForCompanyContext(forged);
      } catch (error) {
        return error as CompanyScopeRequiredError;
      }
      throw new Error("unreachable: a forged scope must be refused");
    })();
    expect(refused).toBeInstanceOf(CompanyScopeRequiredError);
    expect(refused.code).toBe("company_scope_required");
    expect(refused.reason).toBe("untrusted");
  });

  test("a missing scope is refused before any lookup", () => {
    for (const missing of [undefined, null]) {
      try {
        resolvePayerForCompanyContext(missing as unknown as PlatformScope);
        throw new Error("unreachable: a missing scope must be refused");
      } catch (error) {
        expect(error).toBeInstanceOf(CompanyScopeRequiredError);
        const refused = error as CompanyScopeRequiredError;
        expect(refused.code).toBe("company_scope_required");
        expect(refused.reason).toBe("missing");
      }
    }
  });

  test("no refusal ever falls back to a personal or deployment payer", async () => {
    // The refusal answers with an error and nothing else: there is no code path from an
    // untrusted or missing scope to any ref at all — personal, deployment or company.
    const attempts: unknown[] = [
      null,
      undefined,
      {
        tenantId: "tn_attacker",
        workspaceId: "ws",
        principalId: "p",
        actorId: "u",
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      },
    ];
    const trusted = await makeTrustedScope(
      new Request("https://example.invalid/workbench"),
    );
    attempts.push({ ...trusted });
    for (const attempt of attempts) {
      expect(() =>
        resolvePayerForCompanyContext(attempt as PlatformScope),
      ).toThrow(CompanyScopeRequiredError);
    }
  });
});
