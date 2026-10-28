import { describe, expect, test } from "../../tests/support/bun-test-compat";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BotOwnership,
  ObservationScopeError,
  type ObservationScopeErrorCode,
} from "../src/ai-observability/contracts";
import {
  assertObservationScope,
  authorizationKey,
  bindCursor,
  cacheKey,
  exportKey,
  jobKey,
  readCursor,
  resolveEvaluationEligibility,
  resolveObservationScope,
  resolveStorageLocator,
  resourceScopeKey,
} from "../src/ai-observability/scope";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const STATUS: Record<ObservationScopeErrorCode, 400 | 401 | 403> = {
  AUTH_REQUIRED: 401,
  BOT_REQUIRED: 400,
  OWNERSHIP_REQUIRED: 403,
  ENTERPRISE_SCOPE_UNSUPPORTED: 403,
};

describe("ObservationScopeError", () => {
  test("the code is the contract and the message is just the code", () => {
    for (const code of Object.keys(STATUS) as ObservationScopeErrorCode[]) {
      const error = new ObservationScopeError(code, STATUS[code]);
      expect(error.code).toBe(code);
      expect(error.message).toBe(code);
      expect(error.status).toBe(STATUS[code]);
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("the three ownership answers are exhaustive", () => {
    const all: BotOwnership[] = ["owner", "admin", "none"];
    expect(all).toHaveLength(3);
  });
});

const actorA = "user-a";
const actorB = "user-b";

function workbench(
  overrides: Partial<Parameters<typeof resolveObservationScope>[0]> = {},
) {
  return resolveObservationScope({
    actorId: actorA,
    botId: "agent-1",
    ownership: "owner",
    epoch: 1,
    ...overrides,
  });
}

describe("resolveObservationScope", () => {
  test("an owner gets a frozen workbench scope", () => {
    const scope = workbench();
    expect(scope.kind).toBe("workbench");
    expect(scope.actorId).toBe(actorA);
    expect(scope.botId).toBe("agent-1");
    expect(scope.epoch).toBe(1);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  test("an administrator's scope shares the owner's stable data key (FREV-03)", () => {
    // One Bot is one data range: the administrator's scope for a managed Bot
    // names the SAME key as the creator's, so the admin's reads reach the
    // creator's records. Who may hold the scope is the live manage gate's
    // answer; the key only names the data.
    const asAdmin = workbench({ actorId: actorB, ownership: "admin" });
    expect(asAdmin.key).toBe(workbench().key);
    // ...while the scopes themselves still carry their own actor and epoch.
    expect(asAdmin.actorId).not.toBe(workbench().actorId);
  });

  test("a missing actor is 401 before ownership is even considered", () => {
    expect(() => workbench({ actorId: undefined })).toThrow(
      new ObservationScopeError("AUTH_REQUIRED", 401),
    );
  });

  test("the dev-local placeholder actor is not an authenticated identity", () => {
    expect(() => workbench({ actorId: "dev-local-user" })).toThrow(
      new ObservationScopeError("AUTH_REQUIRED", 401),
    );
  });

  test("a missing bot id is 400", () => {
    expect(() => workbench({ botId: undefined })).toThrow(
      new ObservationScopeError("BOT_REQUIRED", 400),
    );
  });

  test("ownership 'none' is 403 even with a valid actor and bot", () => {
    expect(() => workbench({ ownership: "none" })).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("an ownership epoch bump leaves the data key in place (FREV-03)", () => {
    // A rename or transfer bumps the epoch — the AUTHORIZATION artifacts bound
    // to it (cursors, job/export keys) die with the generation, but the data
    // address does not move: history stays reachable for whoever the live gate
    // authorizes next.
    expect(workbench({ epoch: 2 }).key).toBe(workbench({ epoch: 1 }).key);
  });

  test("the stable resource key is a pure function of the Bot id (FREV-03)", () => {
    expect(resourceScopeKey("agent-1")).toBe(resourceScopeKey("agent-1"));
    expect(resourceScopeKey("agent-1")).not.toBe(resourceScopeKey("agent-2"));
    // Never an actor or an epoch in the data identity: the counterexample the
    // final review proved was a key whose parts moved the data address.
    expect(resourceScopeKey("agent-1")).not.toContain(actorA);
  });

  test("authorizationKey is deterministic and injective over its three inputs", () => {
    expect(authorizationKey(actorA, "agent-1", 1)).toBe(
      authorizationKey(actorA, "agent-1", 1),
    );
    expect(authorizationKey(actorA, "agent-1", 1)).not.toBe(
      authorizationKey(actorA, "agent-2", 1),
    );
    expect(authorizationKey(actorA, "agent-1", 1)).not.toBe(
      authorizationKey(actorB, "agent-1", 1),
    );
  });

  test("a bot id cannot smuggle a separator and collide with another key", () => {
    expect(resourceScopeKey("agent|1")).not.toBe(resourceScopeKey("agent"));
    expect(authorizationKey(actorA, "agent-1:2", 1)).not.toBe(
      authorizationKey(actorA, "agent-1", 2),
    );
    expect(authorizationKey(actorA, "agent|1", 1)).not.toBe(
      authorizationKey(actorA, "agent", 1),
    );
    // The two key families can never collide, whatever the ids carry.
    expect(resourceScopeKey("wb-auth")).not.toBe(authorizationKey("", "", 0));
    for (const actor of [actorA, "wb", "wb-auth"]) {
      for (const bot of ["agent-1", "wb", "wb-auth"]) {
        expect(resourceScopeKey(bot)).not.toBe(authorizationKey(actor, bot, 1));
      }
    }
  });
});

describe("enterprise reservation is a refusal, not a fallback", () => {
  test("an unresolved enterprise hint is refused", () => {
    expect(() => workbench({ enterpriseHint: { tenantId: "acme" } })).toThrow(
      new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403),
    );
  });

  test("a tenant header value is refused, not read", () => {
    expect(() => workbench({ enterpriseHint: "acme" })).toThrow(
      new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403),
    );
  });

  test("an empty or null hint is not an enterprise request", () => {
    expect(workbench({ enterpriseHint: undefined }).kind).toBe("workbench");
    expect(workbench({ enterpriseHint: null }).kind).toBe("workbench");
  });

  test("refusal happens before ownership, so a valid owner still cannot borrow a workbench scope", () => {
    expect(() =>
      resolveObservationScope({
        actorId: actorA,
        botId: "agent-1",
        ownership: "owner",
        epoch: 1,
        enterpriseHint: { workspace: "acme" },
      }),
    ).toThrow(new ObservationScopeError("ENTERPRISE_SCOPE_UNSUPPORTED", 403));
  });
});

describe("assertObservationScope — process-internal trust", () => {
  test("a scope this process issued passes", () => {
    const scope = workbench();
    expect(() => assertObservationScope(scope)).not.toThrow();
  });

  test("a serialized-and-restored scope fails closed", () => {
    const restored = JSON.parse(JSON.stringify(workbench()));
    expect(() => assertObservationScope(restored)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("a spread copy fails closed", () => {
    const copy = { ...workbench() };
    expect(() => assertObservationScope(copy)).toThrow();
  });

  test("a hand-built object with the right shape fails closed", () => {
    const forged = Object.freeze({
      kind: "workbench" as const,
      key: resourceScopeKey("agent-1"),
      actorId: actorA,
      botId: "agent-1",
      epoch: 1,
    });
    expect(() => assertObservationScope(forged)).toThrow();
  });

  test("null, undefined and primitives fail closed", () => {
    for (const value of [null, undefined, "workbench", 42, []]) {
      expect(() => assertObservationScope(value)).toThrow();
    }
  });

  test("the module exports no unsafe issuance escape hatch", () => {
    const exports = Object.keys(nodeRequire("../src/ai-observability/scope"));
    expect(
      exports.filter((name) => /unsafe|internal|forge|bypass|raw/i.test(name)),
    ).toEqual([]);
  });
});

/**
 * Two trusted scopes over the SAME Bot: the data identity is shared (A12 still
 * holds across BOTS — different Bots stay different key spaces).
 */
const scopeAlpha = workbench();
const scopeBeta = workbench({ actorId: actorB, ownership: "admin" });

describe("two trusted scopes over one Bot — one data range (FREV-03)", () => {
  test("the scopes carry their own actor while the data key is the Bot's", () => {
    expect(scopeAlpha.botId).toBe(scopeBeta.botId);
    expect(scopeAlpha.key).toBe(scopeBeta.key);
    expect(scopeAlpha.actorId).not.toBe(scopeBeta.actorId);
  });

  test("storage locators follow the Bot, not the actor (FREV-03)", () => {
    const a = resolveStorageLocator(scopeAlpha);
    const b = resolveStorageLocator(scopeBeta);
    // Same Bot: one address, so an administrator reads what the creator wrote.
    expect(a.scopeKey).toBe(scopeAlpha.key);
    expect(a.project).toBe(b.project);
    expect(a.workspace).toBe(b.workspace);
    // Different Bots: different addresses — the isolation boundary that stays.
    const other = workbench({ botId: "agent-2" });
    const c = resolveStorageLocator(other);
    expect(c.project).not.toBe(a.project);
    expect(c.workspace).not.toBe(a.workspace);
  });

  test("a profile epoch bump moves nothing upstream (FREV-03)", () => {
    const before = resolveStorageLocator(workbench({ epoch: 1 }));
    const after = resolveStorageLocator(workbench({ epoch: 2 }));
    expect(after.workspace).toBe(before.workspace);
    expect(after.project).toBe(before.project);
  });

  test("the storage fingerprint is 16 hex chars of the scope key hash", () => {
    const { workspace, project } = resolveStorageLocator(scopeAlpha);
    expect(workspace).toMatch(/-[0-9a-f]{16}$/);
    expect(project).toMatch(/-[0-9a-f]{16}$/);
  });

  test("a cursor minted under one scope is refused by the other", () => {
    const cursor = bindCursor(scopeAlpha, "page-2");
    expect(readCursor(scopeAlpha, cursor)).toBe("page-2");
    expect(() => readCursor(scopeBeta, cursor)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("an ownership epoch bump invalidates cursors minted before it", () => {
    const before = workbench({ epoch: 1 });
    const after = workbench({ epoch: 2 });
    const cursor = bindCursor(before, "page-2");
    expect(() => readCursor(after, cursor)).toThrow();
  });

  test("a trailing garbage segment is refused, not silently dropped", () => {
    const cursor = bindCursor(scopeAlpha, "page-2");
    expect(readCursor(scopeAlpha, cursor)).toBe("page-2");
    expect(() => readCursor(scopeAlpha, `${cursor}.extra`)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });

  test("a tampered cursor payload is refused", () => {
    const cursor = bindCursor(scopeAlpha, "page-2");
    const tampered = `${cursor.slice(0, -2)}99`;
    expect(() => readCursor(scopeAlpha, tampered)).toThrow();
  });

  test("cache keys follow the data range; job and export keys stay per-actor (FREV-03)", () => {
    // A cached upstream page is a fact about the Bot's range — both authorized
    // viewers read the same one (and retention can drop it by the stored row
    // key). A job/export idempotency key is one actor's claim — they never
    // merge across viewers of the same Bot.
    expect(cacheKey(scopeAlpha, "runs", "p1")).toBe(
      cacheKey(scopeBeta, "runs", "p1"),
    );
    expect(cacheKey(scopeAlpha, "runs", "p1")).not.toBe(
      cacheKey(workbench({ botId: "agent-2" }), "runs", "p1"),
    );
    expect(jobKey(scopeAlpha, "evaluation", "idem-1")).not.toBe(
      jobKey(scopeBeta, "evaluation", "idem-1"),
    );
    expect(exportKey(scopeAlpha, "exp-1")).not.toBe(
      exportKey(scopeBeta, "exp-1"),
    );
  });

  test("within one scope, a separator inside a key segment cannot collide with split segments", () => {
    expect(cacheKey(scopeAlpha, "a|b", "c")).not.toBe(
      cacheKey(scopeAlpha, "a", "b|c"),
    );
    expect(jobKey(scopeAlpha, "a|b", "c")).not.toBe(
      jobKey(scopeAlpha, "a", "b|c"),
    );
  });

  test("the same idempotency key under one scope is stable", () => {
    expect(jobKey(scopeAlpha, "evaluation", "idem-1")).toBe(
      jobKey(scopeAlpha, "evaluation", "idem-1"),
    );
  });

  test("evaluation eligibility is granted for a valid scope and names the scopeKey", () => {
    expect(resolveEvaluationEligibility(scopeAlpha)).toEqual({
      allowed: true,
      scopeKey: scopeAlpha.key,
    });
  });

  test("eligibility for a forged scope is refused, not defaulted to allowed", () => {
    const forged = { ...scopeAlpha };
    expect(() =>
      resolveEvaluationEligibility(forged as unknown as typeof scopeAlpha),
    ).toThrow();
    expect(() =>
      resolveStorageLocator(forged as unknown as typeof scopeAlpha),
    ).toThrow();
  });
});

describe("no premature tenant model", () => {
  const scopeSource = readFileSync(
    join(hereDir, "..", "src", "ai-observability", "scope.ts"),
    "utf8",
  );
  const contractsSource = readFileSync(
    join(hereDir, "..", "src", "ai-observability", "contracts.ts"),
    "utf8",
  );

  test("neither module reaches the database", () => {
    for (const source of [scopeSource, contractsSource]) {
      expect(source).not.toMatch(/from\s+["'][^"']*db\/schema/);
      expect(source).not.toMatch(/from\s+["']drizzle/);
    }
  });

  test("no exported type or function name mentions a tenant", () => {
    const names = [
      ...scopeSource.matchAll(
        /^export\s+(?:type|function|const|class)\s+(\w+)/gm,
      ),
      ...contractsSource.matchAll(
        /^export\s+(?:type|function|const|class)\s+(\w+)/gm,
      ),
    ].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => /tenant/i.test(name))).toEqual([]);
  });

  test("there is exactly one scope kind", () => {
    expect(contractsSource).toMatch(
      /export type ObservationScopeKind = "workbench";/,
    );
    expect(contractsSource).not.toMatch(/ObservationScopeKind\s*=[^;]*\|/);
  });

  test("an upstream workspace name is derived from the scope key, never trusted as authorization", () => {
    const locator = resolveStorageLocator(scopeAlpha);
    expect(locator.workspace).toContain(scopeAlpha.key.length.toString());
    // The locator is an output of authorization, not an input to it: re-deriving a scope from a
    // workspace name is impossible because no such function is exported.
    const names = [...scopeSource.matchAll(/^export\s+function\s+(\w+)/gm)].map(
      (m) => m[1],
    );
    expect(
      names.filter((n) =>
        /fromWorkspace|fromProject|fromLocator|scopeFrom/i.test(n),
      ),
    ).toEqual([]);
  });
});
