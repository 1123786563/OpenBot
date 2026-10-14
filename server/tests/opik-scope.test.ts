import { describe, expect, test } from "bun:test";
import {
  ObservationScopeError,
  type BotOwnership,
  type ObservationScopeErrorCode,
} from "../src/ai-observability/contracts";
import {
  assertObservationScope,
  resolveObservationScope,
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

function workbench(overrides: Partial<Parameters<typeof resolveObservationScope>[0]> = {}) {
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
    expect(() => workbench({ actorId: undefined })).toThrow(new ObservationScopeError("AUTH_REQUIRED", 401));
  });

  test("the dev-local placeholder actor is not an authenticated identity", () => {
    expect(() => workbench({ actorId: "dev-local-user" })).toThrow(
      new ObservationScopeError("AUTH_REQUIRED", 401),
    );
  });

  test("a missing bot id is 400", () => {
    expect(() => workbench({ botId: undefined })).toThrow(new ObservationScopeError("BOT_REQUIRED", 400));
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
    expect(scopeKey(actorA, "agent-1", 1)).not.toBe(scopeKey(actorA, "agent-2", 1));
    expect(scopeKey(actorA, "agent-1", 1)).not.toBe(scopeKey(actorB, "agent-1", 1));
  });

  test("a bot id cannot smuggle a separator and collide with another key", () => {
    expect(scopeKey(actorA, "agent-1:2", 1)).not.toBe(scopeKey(actorA, "agent-1", 2));
    expect(scopeKey(actorA, "agent|1", 1)).not.toBe(scopeKey(actorA, "agent", 1));
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
    expect(exports.filter((name) => /unsafe|internal|forge|bypass|raw/i.test(name))).toEqual([]);
  });
});
