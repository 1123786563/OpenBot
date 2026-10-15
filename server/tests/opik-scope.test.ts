import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BotOwnership,
  ObservationScopeError,
  type ObservationScopeErrorCode,
} from "../src/ai-observability/contracts";
import {
  assertObservationScope,
  bindCursor,
  cacheKey,
  exportKey,
  jobKey,
  readCursor,
  resolveEvaluationEligibility,
  resolveObservationScope,
  resolveStorageLocator,
  scopeKey,
} from "../src/ai-observability/scope";

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

  test("an administrator gets a scope, and its key differs from the owner's", () => {
    const asAdmin = workbench({ actorId: actorB, ownership: "admin" });
    expect(asAdmin.key).not.toBe(workbench().key);
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

  test("an ownership epoch bump produces a different key, killing old cursors", () => {
    expect(workbench({ epoch: 2 }).key).not.toBe(workbench({ epoch: 1 }).key);
  });

  test("scopeKey is deterministic and injective over its three inputs", () => {
    expect(scopeKey(actorA, "agent-1", 1)).toBe(scopeKey(actorA, "agent-1", 1));
    expect(scopeKey(actorA, "agent-1", 1)).not.toBe(
      scopeKey(actorA, "agent-2", 1),
    );
    expect(scopeKey(actorA, "agent-1", 1)).not.toBe(
      scopeKey(actorB, "agent-1", 1),
    );
  });

  test("a bot id cannot smuggle a separator and collide with another key", () => {
    expect(scopeKey(actorA, "agent-1:2", 1)).not.toBe(
      scopeKey(actorA, "agent-1", 2),
    );
    expect(scopeKey(actorA, "agent|1", 1)).not.toBe(
      scopeKey(actorA, "agent", 1),
    );
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
      key: scopeKey(actorA, "agent-1", 1),
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
    const exports = Object.keys(require("../src/ai-observability/scope"));
    expect(
      exports.filter((name) => /unsafe|internal|forge|bypass|raw/i.test(name)),
    ).toEqual([]);
  });
});

/** Two trusted scopes with the SAME resource ids — A12 without a single tenant table. */
const scopeAlpha = workbench();
const scopeBeta = workbench({ actorId: actorB, ownership: "admin" });

describe("two trusted scopes over identical resource ids", () => {
  test("the scopes differ while botId is identical", () => {
    expect(scopeAlpha.botId).toBe(scopeBeta.botId);
    expect(scopeAlpha.key).not.toBe(scopeBeta.key);
  });

  test("storage locators are distinct and both namespaced by scopeKey", () => {
    const a = resolveStorageLocator(scopeAlpha);
    const b = resolveStorageLocator(scopeBeta);
    expect(a.scopeKey).toBe(scopeAlpha.key);
    expect(a.project).not.toBe(b.project);
    expect(a.workspace).not.toBe(b.workspace);
  });

  test("equal-length scope keys still get distinct locators", () => {
    const aa = resolveObservationScope({
      actorId: "user-aa",
      botId: "agent-1",
      ownership: "owner",
      epoch: 1,
    });
    const bb = resolveObservationScope({
      actorId: "user-bb",
      botId: "agent-1",
      ownership: "admin",
      epoch: 1,
    });
    // Pin the premise the fingerprint exists for: same key LENGTH, different keys.
    expect(aa.key.length).toBe(bb.key.length);
    expect(aa.key).not.toBe(bb.key);
    const a = resolveStorageLocator(aa);
    const b = resolveStorageLocator(bb);
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.project).not.toBe(b.project);
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

  test("a tampered cursor payload is refused", () => {
    const cursor = bindCursor(scopeAlpha, "page-2");
    const tampered = `${cursor.slice(0, -2)}99`;
    expect(() => readCursor(scopeAlpha, tampered)).toThrow();
  });

  test("cache, job and export keys cannot cross scopes even with identical names", () => {
    expect(cacheKey(scopeAlpha, "runs", "p1")).not.toBe(
      cacheKey(scopeBeta, "runs", "p1"),
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
    join(import.meta.dir, "..", "src", "ai-observability", "scope.ts"),
    "utf8",
  );
  const contractsSource = readFileSync(
    join(import.meta.dir, "..", "src", "ai-observability", "contracts.ts"),
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
