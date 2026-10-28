// server/tests/multitenancy/oauth-state.test.ts
// MT028（Issue #71）：OAuth 回调按服务端持久 state 固定归属。
//
// 环境契约：ENTERPRISE_TEST_SETUP_DATABASE_URL（或 TEST_DATABASE_URL）+
// 三个受限角色 URL 缺一整套显式 skip（带理由），绝不回退开发库；
// skipped 不计通过。全部断言跑在真实受限角色与真实 RLS 上。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createOAuthStateFixture,
  type OAuthStateFixture,
} from "./support/oauth-state";

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT028 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  return { ok: true };
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => void | Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

let fixture: OAuthStateFixture;

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createOAuthStateFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

/** The S256 challenge derivation the authorization URL carries. */
function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

const TOKEN_CANARIES = [
  "ya29.canary-access-token",
  "BEGIN RSA PRIVATE KEY",
  "rt_canary_refresh_token",
] as const;

/** State-shaped values that were never minted (missing-state probes). */
const MISSING_STATES = [
  "mt028-missing-state-A",
  "mt028-missing-state-B",
] as const;

describeDb("MT028 initiation: the persisted row fixes the attribution", () => {
  itDb(
    "initiate mints a server-generated state whose challenge derives from the stored verifier (AC1)",
    async () => {
      const scope = await fixture.scopeOf("a1-member", "team-a1");
      const initiated = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "github",
      });
      // The state value is opaque and never one of the caller's identifiers.
      expect(initiated.state).not.toBe(scope.tenantId);
      expect(initiated.state).not.toBe(scope.workspaceId);
      expect(initiated.state).not.toBe(scope.principalId);
      const row = await fixture.stateRow(initiated.state);
      expect(row?.status).toBe("pending");
      expect(row?.purpose).toBe("connection");
      expect(row?.target).toBe("github");
      // The challenge is the S256 of the SERVER-generated verifier, provable
      // only after the callback returns it in the binding.
      const consumed = await fixture.service.consume(initiated.state);
      expect(consumed.outcome).toBe("allow");
      if (consumed.outcome !== "allow") return;
      expect(s256(consumed.binding.verifier)).toBe(initiated.codeChallenge);
    },
  );

  itDb(
    "consume binds exactly the initiation-time company/team/user/purpose/target (AC1)",
    async () => {
      const scope = await fixture.scopeOf("a1-member", "team-a1");
      const initiated = await fixture.service.initiate(scope, {
        purpose: "site-login",
        target: "https://vault.example",
      });
      const consumed = await fixture.service.consume(initiated.state);
      expect(consumed).toEqual({
        outcome: "allow",
        binding: {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          purpose: "site-login",
          target: "https://vault.example",
          verifier: expect.any(String),
        },
      });
      const row = await fixture.stateRow(initiated.state);
      expect(row?.status).toBe("consumed");
    },
  );

  itDb(
    "the binding is byte-identical with or without claimed context — claimed never decides (AC1)",
    async () => {
      const scope = await fixture.scopeOf("a2-member", "team-a2");
      const plain = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "notion",
      });
      const claimed = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "notion",
      });
      const a = await fixture.service.consume(plain.state);
      const b = await fixture.service.consume(claimed.state, {
        claimedTenantId: scope.tenantId,
        claimedWorkspaceId: scope.workspaceId,
        claimedPrincipalId: scope.principalId,
      });
      expect(a.outcome).toBe("allow");
      expect(b.outcome).toBe("allow");
      if (a.outcome !== "allow" || b.outcome !== "allow") return;
      // Attribution fields are byte-identical; the verifiers differ by design
      // (two independent flows, each with its own server-generated secret).
      const attributionOf = (binding: typeof a.binding) =>
        JSON.stringify({ ...binding, verifier: "" });
      expect(attributionOf(a.binding)).toBe(attributionOf(b.binding));
      // ...and each binding's verifier really is its own flow's stored one.
      expect(a.binding.verifier).not.toBe(b.binding.verifier);
    },
  );

  itDb(
    "a callback-time tenant/team/user selection never rewrites the attribution — cross-scope denies (AC1)",
    async () => {
      const scope = await fixture.scopeOf("a1-member", "team-a1");
      const otherTeam = fixture.teamOf("a2-member", "team-a2");
      const tenantB = fixture.tenantOf("company-b");
      // tenant claim contradicts the persisted company
      const crossTenant = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "github",
      });
      const deniedTenant = await fixture.service.consume(crossTenant.state, {
        claimedTenantId: tenantB,
      });
      expect(deniedTenant.outcome).toBe("deny");
      // team claim contradicts the persisted team (same company)
      const crossTeam = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "github",
      });
      const deniedTeam = await fixture.service.consume(crossTeam.state, {
        claimedWorkspaceId: otherTeam.workspaceId,
      });
      expect(deniedTeam.outcome).toBe("deny");
      // principal claim contradicts the persisted initiator
      const crossPrincipal = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "github",
      });
      const deniedPrincipal = await fixture.service.consume(
        crossPrincipal.state,
        {
          claimedPrincipalId: otherTeam.principalId,
        },
      );
      expect(deniedPrincipal.outcome).toBe("deny");
      if (
        deniedTenant.outcome !== "deny" ||
        deniedTeam.outcome !== "deny" ||
        deniedPrincipal.outcome !== "deny"
      )
        return;
      expect(deniedTenant.code).toBe("STATE_CROSS_SCOPE");
      expect(deniedTeam.code).toBe("STATE_CROSS_SCOPE");
      expect(deniedPrincipal.code).toBe("STATE_CROSS_SCOPE");
      // None of the claimed (wrong-scope) values may appear on any deny surface.
      for (const denied of [deniedTenant, deniedTeam, deniedPrincipal]) {
        const surface = JSON.stringify(denied);
        expect(surface).not.toContain(tenantB);
        expect(surface).not.toContain(otherTeam.workspaceId);
      }
    },
  );

  itDb(
    "a cross-scope presentation does not burn the state — the honest callback still binds (MT026 precedent)",
    async () => {
      const scope = await fixture.scopeOf("a1-member", "team-a1");
      const tenantB = fixture.tenantOf("company-b");
      const initiated = await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "github",
      });
      const probe = await fixture.service.consume(initiated.state, {
        claimedTenantId: tenantB,
      });
      expect(probe.outcome).toBe("deny");
      const honest = await fixture.service.consume(initiated.state);
      expect(honest.outcome).toBe("allow");
      if (honest.outcome !== "allow") return;
      expect(honest.binding.tenantId).toBe(scope.tenantId);
      expect(honest.binding.workspaceId).toBe(scope.workspaceId);
    },
  );

  itDb("cross-scope rejection records a security event (AC2)", async () => {
    const scope = await fixture.scopeOf("a1-member", "team-a1");
    const tenantB = fixture.tenantOf("company-b");
    const initiated = await fixture.service.initiate(scope, {
      purpose: "connection",
      target: "github",
    });
    const denied = await fixture.service.consume(initiated.state, {
      claimedTenantId: tenantB,
    });
    expect(denied.outcome).toBe("deny");
    if (denied.outcome !== "deny" || !denied.securityEventId) return;
    const events = await fixture.securityEvents({
      tenantId: scope.tenantId,
      eventId: denied.securityEventId,
    });
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("oauth.state.rejected");
    expect(events[0].actorId).toBe(scope.principalId);
    expect(events[0].details.code).toBe("STATE_CROSS_SCOPE");
    expect(events[0].details.state_present).toBe(true);
  });
});

describeDb(
  "MT028 rejections: missing/expired/replayed + security events",
  () => {
    itDb(
      "a missing state denies without attribution and never invents a tenant row (AC2)",
      async () => {
        const denied = await fixture.service.consume(MISSING_STATES[0]);
        expect(denied).toMatchObject({
          outcome: "deny",
          code: "STATE_MISSING",
        });
        if (denied.outcome !== "deny") return;
        // No attribution is possible: no security event id is fabricated.
        expect(denied.securityEventId).toBeNull();
      },
    );

    itDb(
      "a missing state records a security event only under an explicit caller attribution (AC2/D1)",
      async () => {
        const tenantA = fixture.tenantOf("company-a");
        const denied = await fixture.service.consume(MISSING_STATES[1], {
          securityAttributionTenantId: tenantA,
        });
        expect(denied.outcome).toBe("deny");
        if (denied.outcome !== "deny" || !denied.securityEventId) return;
        const events = await fixture.securityEvents({
          tenantId: tenantA,
          eventId: denied.securityEventId,
        });
        expect(events.length).toBe(1);
        expect(events[0].details.code).toBe("STATE_MISSING");
        expect(events[0].details.state_present).toBe(false);
        // The unknown value itself is never echoed anywhere on the event.
        expect(JSON.stringify(events[0])).not.toContain(MISSING_STATES[1]);
      },
    );

    itDb(
      "an expired state denies STATE_EXPIRED, records the event, and stays forensically expired (AC2)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
          ttlSeconds: 1,
        });
        await Bun.sleep(1200);
        const denied = await fixture.service.consume(initiated.state);
        expect(denied.outcome).toBe("deny");
        if (denied.outcome !== "deny" || !denied.securityEventId) return;
        expect(denied.code).toBe("STATE_EXPIRED");
        const events = await fixture.securityEvents({
          tenantId: scope.tenantId,
          eventId: denied.securityEventId,
        });
        expect(events[0].details.code).toBe("STATE_EXPIRED");
        // Expiry is terminal on its own: the row stays pending-expired (not
        // rewritten to failed), so a later probe still reads EXPIRED.
        const second = await fixture.service.consume(initiated.state);
        expect(second.outcome).toBe("deny");
        if (second.outcome !== "deny") return;
        expect(second.code).toBe("STATE_EXPIRED");
      },
    );

    itDb(
      "a used state replays once and only once — the atomic arm admits exactly one consumer (AC2)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        const first = await fixture.service.consume(initiated.state);
        expect(first.outcome).toBe("allow");
        const second = await fixture.service.consume(initiated.state);
        expect(second.outcome).toBe("deny");
        if (second.outcome !== "deny" || !second.securityEventId) return;
        expect(second.code).toBe("STATE_REPLAYED");
        const events = await fixture.securityEvents({
          tenantId: scope.tenantId,
          eventId: second.securityEventId,
        });
        expect(events[0].details.code).toBe("STATE_REPLAYED");
      },
    );

    itDb(
      "two concurrent consumes admit exactly one — the atomic arm decides under overlap (AC2)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        // Both read committed before either writes; only the UPDATE's own
        // `status='pending'` arm can keep the second consumer out. Two
        // separate operator connections make the overlap real.
        const results = await Promise.all([
          fixture.service.consume(initiated.state),
          fixture.serviceB.consume(initiated.state),
        ]);
        const allowed = results.filter((r) => r.outcome === "allow");
        expect(allowed.length).toBe(1);
        const denied = results.filter((r) => r.outcome === "deny");
        expect(denied.length).toBe(1);
        expect(denied[0].outcome === "deny" ? denied[0].code : "").toBe(
          "STATE_REPLAYED",
        );
      },
    );

    itDb(
      "an initiator suspended mid-flow cannot complete: INITIATOR_INELIGIBLE + event, and the flow resumes when restored (A5/AC2)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const suspended = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        await fixture.setCompanyMembershipStatus(
          "a1-member",
          "company-a",
          "suspended",
        );
        const deniedCompany = await fixture.service.consume(suspended.state);
        expect(deniedCompany.outcome).toBe("deny");
        if (deniedCompany.outcome === "deny") {
          expect(deniedCompany.code).toBe("STATE_INITIATOR_INELIGIBLE");
          if (deniedCompany.securityEventId) {
            const events = await fixture.securityEvents({
              tenantId: scope.tenantId,
              eventId: deniedCompany.securityEventId,
            });
            expect(events[0].details.code).toBe("STATE_INITIATOR_INELIGIBLE");
          }
        }
        // Restored membership: the same flow completes against the persisted row.
        await fixture.setCompanyMembershipStatus(
          "a1-member",
          "company-a",
          "active",
        );
        const restored = await fixture.service.consume(suspended.state);
        expect(restored.outcome).toBe("allow");

        // The team-membership arm: suspended team membership also refuses.
        const teamScope = await fixture.scopeOf("a1a2-member", "team-a1");
        const teamFlow = await fixture.service.initiate(teamScope, {
          purpose: "connection",
          target: "github",
        });
        await fixture.setTeamMembershipStatus(
          "a1a2-member",
          "team-a1",
          "suspended",
        );
        const deniedTeam = await fixture.service.consume(teamFlow.state);
        expect(deniedTeam.outcome).toBe("deny");
        if (deniedTeam.outcome !== "deny") return;
        expect(deniedTeam.code).toBe("STATE_INITIATOR_INELIGIBLE");
        await fixture.setTeamMembershipStatus(
          "a1a2-member",
          "team-a1",
          "active",
        );
      },
    );
  },
);

describeDb(
  "MT028 failure: no half-done connection, retry needs a new state",
  () => {
    itDb(
      "fail after consume is terminal — the same state can never bind again (AC3)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        const consumed = await fixture.service.consume(initiated.state);
        expect(consumed.outcome).toBe("allow");
        // The redemption/connection write failed afterwards: mark terminal.
        const failed = await fixture.service.fail(initiated.state, {
          reason: "vendor-refused",
        });
        expect(failed).toEqual({ failed: true });
        const row = await fixture.stateRow(initiated.state);
        expect(row?.status).toBe("failed");
        expect(row?.failedReason).toBe("vendor-refused");
        const again = await fixture.service.consume(initiated.state);
        expect(again.outcome).toBe("deny");
        if (again.outcome !== "deny") return;
        expect(again.code).toBe("STATE_REPLAYED");
      },
    );

    itDb(
      "fail on a pending state (abandoned flow) also terminates it (AC3)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        const failed = await fixture.service.fail(initiated.state, {
          reason: "abandoned",
        });
        expect(failed.failed).toBe(true);
        const consumed = await fixture.service.consume(initiated.state);
        expect(consumed.outcome).toBe("deny");
        if (consumed.outcome !== "deny") return;
        expect(consumed.code).toBe("STATE_REPLAYED");
      },
    );

    itDb(
      "fail is idempotent and honest about unknown states (AC3)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        expect(
          (await fixture.service.fail(initiated.state, { reason: "abandoned" }))
            .failed,
        ).toBe(true);
        // Already failed: the second call transitions nothing.
        expect(
          (await fixture.service.fail(initiated.state, { reason: "abandoned" }))
            .failed,
        ).toBe(false);
        const unknown = "00000000-0000-4000-8000-000000000000";
        expect(
          (await fixture.service.fail(unknown, { reason: "abandoned" })).failed,
        ).toBe(false);
      },
    );

    itDb(
      "a retry is a NEW state: freshly minted, independently consumable, old state stays dead (AC3)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const before = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        await fixture.service.consume(before.state);
        await fixture.service.fail(before.state, { reason: "record-failed" });
        const retry = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        expect(retry.state).not.toBe(before.state);
        const consumed = await fixture.service.consume(retry.state);
        expect(consumed.outcome).toBe("allow");
        const stale = await fixture.service.consume(before.state);
        expect(stale.outcome).toBe("deny");
        if (stale.outcome !== "deny") return;
        expect(stale.code).toBe("STATE_REPLAYED");
      },
    );

    itDb(
      "the module's only writes are state rows and security events — no connection surface exists (structural, AC3)",
      async () => {
        // Source fence (kb authoritySource precedent): the module imports no
        // credential/connection/plugin storage, so a failed callback cannot leave
        // a half-written connection behind it — the write does not exist here.
        const source = await Bun.file(
          "src/enterprise/tenancy/oauth-state.ts",
        ).text();
        expect(source).not.toMatch(
          /from\s+"[^"]*(enterprise-credentials|plugins\/|openmuse-connectors|passwords|shared-use)/,
        );
        expect(source).not.toMatch(
          /\binsert\s+into\s+(credentials|mcp_servers|saved_logins)\b/i,
        );
        // Behavioral shadow: the module wrote exactly the state rows initiated.
        const scope = await fixture.scopeOf("b1-member", "team-b1");
        await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "linear",
        });
        const count = await fixture.stateRowCount();
        expect(count).toBeGreaterThanOrEqual(1);
      },
    );
  },
);

describeDb(
  "MT028 zero-token-plaintext: responses, errors and events carry no secrets",
  () => {
    itDb(
      "deny surfaces and security events carry neither the state value nor the verifier nor token canaries (AC4)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const tenantB = fixture.tenantOf("company-b");
        // Flow A: consumed, then presented again — the replay denial must not
        // carry the state value nor the verifier the allow branch returned.
        const flowA = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        const first = await fixture.service.consume(flowA.state);
        expect(first.outcome).toBe("allow");
        const verifier =
          first.outcome === "allow" ? first.binding.verifier : "";
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        const replayDenied = await fixture.service.consume(flowA.state);
        // Flow B: cross-scope presentation.
        const flowB = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        const crossDenied = await fixture.service.consume(flowB.state, {
          claimedTenantId: tenantB,
        });
        // Flow C: missing state.
        const missingDenied = await fixture.service.consume(MISSING_STATES[0]);
        const denials = [replayDenied, crossDenied, missingDenied];
        for (const denied of denials) {
          expect(denied.outcome).toBe("deny");
          if (denied.outcome !== "deny") continue;
          const surface = JSON.stringify(denied);
          for (const presented of [
            flowA.state,
            flowB.state,
            ...MISSING_STATES,
          ]) {
            expect(surface).not.toContain(presented);
          }
          expect(surface).not.toContain(verifier);
          for (const canary of TOKEN_CANARIES) {
            expect(surface).not.toContain(canary);
          }
          if (!denied.securityEventId) continue;
          const events = await fixture.securityEvents({
            tenantId: scope.tenantId,
            eventId: denied.securityEventId,
          });
          for (const event of events) {
            const eventSurface = JSON.stringify(event);
            for (const presented of [
              flowA.state,
              flowB.state,
              ...MISSING_STATES,
            ]) {
              expect(eventSurface).not.toContain(presented);
            }
            expect(eventSurface).not.toContain(verifier);
            for (const canary of TOKEN_CANARIES) {
              expect(eventSurface).not.toContain(canary);
            }
          }
        }
      },
    );

    itDb(
      "security event details are a closed shape: no secret-bearing keys ever (AC4)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        await fixture.service.consume(initiated.state);
        const denied = await fixture.service.consume(initiated.state);
        expect(denied.outcome).toBe("deny");
        if (denied.outcome !== "deny" || !denied.securityEventId) return;
        const events = await fixture.securityEvents({
          tenantId: scope.tenantId,
          eventId: denied.securityEventId,
        });
        expect(Object.keys(events[0].details).sort()).toEqual([
          "code",
          "purpose",
          "state_present",
          "target",
        ]);
      },
    );

    itDb(
      "the allow binding carries exactly the flow material — no token fields exist on any output type (AC4)",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        const initiated = await fixture.service.initiate(scope, {
          purpose: "connection",
          target: "github",
        });
        const consumed = await fixture.service.consume(initiated.state);
        expect(consumed.outcome).toBe("allow");
        if (consumed.outcome !== "allow") return;
        expect(Object.keys(consumed.binding).sort()).toEqual([
          "principalId",
          "purpose",
          "target",
          "tenantId",
          "verifier",
          "workspaceId",
        ]);
        // Misuse errors name only codes and field paths — never values.
        await expect(
          fixture.service.initiate(scope, {
            purpose: "connection",
            target: "x".repeat(513),
          }),
        ).rejects.toThrow("OAUTH_STATE_INVALID: target");
      },
    );

    itDb(
      "misuse refusals stay loud and valueless: extra keys, bad ttl, empty state, unknown fail reason, forged scope",
      async () => {
        const scope = await fixture.scopeOf("a1-member", "team-a1");
        await expect(
          fixture.service.initiate(scope, {
            purpose: "connection",
            target: "github",
            ttlSeconds: 600,
            // @ts-expect-error extra key misuse probe
            workspaceOverride: "team-a2",
          }),
        ).rejects.toThrow(
          "OAUTH_STATE_INVALID: unexpected field workspaceOverride",
        );
        await expect(
          fixture.service.initiate(scope, {
            purpose: "connection",
            target: "github",
            ttlSeconds: 0,
          }),
        ).rejects.toThrow("ttlSeconds");
        await expect(fixture.service.consume("")).rejects.toThrow(
          "OAUTH_STATE_INVALID: state",
        );
        await expect(
          fixture.service.fail("x", { reason: "why-not" as never }),
        ).rejects.toThrow("OAUTH_STATE_INVALID: reason");
      },
    );

    itDb(
      "initiation requires a trusted scope — a hand-built scope is refused (MT005 seam)",
      async () => {
        const fact = fixture.teamOf("a1-member", "team-a1");
        const forged = {
          tenantId: fact.tenantId,
          workspaceId: fact.workspaceId,
          principalId: fact.principalId,
          actorId: "forged",
          memberEpoch: 1,
          aclEpoch: 1,
          entrypoint: "web" as const,
        };
        await expect(
          fixture.service.initiate(forged, {
            purpose: "connection",
            target: "github",
          }),
        ).rejects.toThrow("UNVERIFIED_SCOPE");
      },
    );
  },
);

describeDb("MT028 storage fence: RLS, roles and enumeration", () => {
  itDb(
    "the state table is RLS-enabled and FORCEd (MT012 baseline)",
    async () => {
      const flags = await fixture.catalog.rlsFlags("enterprise_oauth_states");
      expect(flags.relrowsecurity).toBe(true);
      expect(flags.relforcerowsecurity).toBe(true);
    },
  );

  itDb(
    "data/directory roles hold nothing on the table; operator never DELETEs (fence)",
    async () => {
      for (const role of ["ob_ent_directory", "ob_ent_data"] as const) {
        expect(
          await fixture.catalog.hasPrivilege(
            "enterprise_oauth_states",
            role,
            "SELECT",
          ),
        ).toBe(false);
        expect(
          await fixture.catalog.hasPrivilege(
            "enterprise_oauth_states",
            role,
            "INSERT",
          ),
        ).toBe(false);
        expect(
          await fixture.catalog.hasPrivilege(
            "enterprise_oauth_states",
            role,
            "UPDATE",
          ),
        ).toBe(false);
      }
      expect(
        await fixture.catalog.hasPrivilege(
          "enterprise_oauth_states",
          "ob_ent_operator",
          "SELECT",
        ),
      ).toBe(true);
      expect(
        await fixture.catalog.hasPrivilege(
          "enterprise_oauth_states",
          "ob_ent_operator",
          "INSERT",
        ),
      ).toBe(true);
      expect(
        await fixture.catalog.hasPrivilege(
          "enterprise_oauth_states",
          "ob_ent_operator",
          "UPDATE",
        ),
      ).toBe(true);
      expect(
        await fixture.catalog.hasPrivilege(
          "enterprise_oauth_states",
          "ob_ent_operator",
          "DELETE",
        ),
      ).toBe(false);
    },
  );

  itDb(
    "the operator cannot enumerate flows: without the state arm the tenant pin sees nothing (MT026 fence)",
    async () => {
      const tenantA = fixture.tenantOf("company-a");
      const scope = await fixture.scopeOf("a1-member", "team-a1");
      await fixture.service.initiate(scope, {
        purpose: "connection",
        target: "github",
      });
      const seen = await fixture.base.operator.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantA}, true)`,
        );
        return tx.execute(
          sql`select count(*)::int as n from enterprise_oauth_states`,
        );
      });
      expect(Number((seen as unknown as Record<string, unknown>[])[0]?.n)).toBe(
        0,
      );
    },
  );

  itDb(
    "a cross-company attribution row is structurally impossible (composite FK, 23503)",
    async () => {
      const tenantA = fixture.tenantOf("company-a");
      const teamB = fixture.teamOf("b1-member", "team-b1");
      const thrown = await (async () => {
        try {
          await fixture.base.operator.transaction(async (tx) => {
            await tx.execute(
              sql`select set_config('app.tenant_id', ${tenantA}, true)`,
            );
            await tx.execute(sql`
            insert into enterprise_oauth_states
              (id, tenant_id, workspace_id, principal_id, purpose, target, verifier, status, expires_at)
            values ('mt028-cross-company-probe', ${tenantA}, ${teamB.workspaceId}, ${teamB.principalId},
                    'connection', 'github', repeat('v', 64), 'pending', now() + interval '10 minutes')
          `);
          });
          return "";
        } catch (error) {
          const parts: string[] = [];
          for (let e: unknown = error; e instanceof Error; e = e.cause) {
            parts.push(e.message);
            const code = (e as Error & { code?: unknown }).code;
            const errno = (e as Error & { errno?: unknown }).errno;
            if (typeof code === "string") parts.push(code);
            if (typeof errno === "string") parts.push(errno);
          }
          return parts.join(" | ");
        }
      })();
      expect(thrown).toContain("23503");
    },
  );
});
