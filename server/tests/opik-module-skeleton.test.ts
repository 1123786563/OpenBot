import { describe, expect, test } from "bun:test";
import {
  OBSERVATION_ACCESS_DENIED,
  OBSERVATION_BOT_REQUIRED,
  resolveObservationBot,
  type BotManagementCheck,
} from "../src/ai-observability/context";
import type { AgentProfile } from "../src/agents/profile-types";

const owner = { id: "user-owner", role: "user" } as const;
const stranger = { id: "user-stranger", role: "user" } as const;
const admin = { id: "user-admin", role: "admin" } as const;

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Expense Manager",
    title: "Finance",
    roleDescription: "Reviews receipts.",
    avatarSeed: "expense-manager",
    visibility: "private",
    ownerUserId: owner.id,
    systemOwned: false,
    hidden: false,
    pinned: false,
    deletedAt: null,
    endpoint: null,
    hasAuth: false,
    hasCallbackToken: false,
    ...overrides,
  };
}

/** 管理级 check：与 canManageAgent 同语义，测试里用它替代真实 store。 */
function managementCheck(rows: AgentProfile[]): BotManagementCheck {
  return async (actor, botId) => {
    const found = rows.find((row) => row.id === botId) ?? null;
    if (!found) return null;
    if (found.systemOwned || found.deletedAt !== null) return null;
    return found.ownerUserId === actor.id || actor.role === "admin"
      ? found
      : null;
  };
}

describe("resolveObservationBot", () => {
  test("a missing bot id is refused before any lookup", async () => {
    let called = 0;
    const result = await resolveObservationBot(async () => {
      called += 1;
      return null;
    }, owner, undefined);
    expect(result).toEqual({ ok: false, status: 404, error: OBSERVATION_BOT_REQUIRED });
    expect(called).toBe(0);
  });

  test("the owner gets access", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), owner, "agent-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.id).toBe("agent-1");
  });

  test("an administrator gets access", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), admin, "agent-1");
    expect(result.ok).toBe(true);
  });

  test("a stranger is refused even though the Bot exists", async () => {
    const result = await resolveObservationBot(managementCheck([profile()]), stranger, "agent-1");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("public visibility does NOT grant observation access", async () => {
    const rows = [profile({ visibility: "public" })];
    const result = await resolveObservationBot(managementCheck(rows), stranger, "agent-1");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("an unknown bot id is refused without leaking existence", async () => {
    const result = await resolveObservationBot(managementCheck([]), owner, "agent-nope");
    expect(result).toEqual({ ok: false, status: 403, error: OBSERVATION_ACCESS_DENIED });
  });

  test("a system-owned or deleted Bot is refused even for its owner", async () => {
    const rows = [profile({ systemOwned: true }), profile({ id: "agent-2", deletedAt: new Date() })];
    expect((await resolveObservationBot(managementCheck(rows), owner, "agent-1")).ok).toBe(false);
    expect((await resolveObservationBot(managementCheck(rows), owner, "agent-2")).ok).toBe(false);
  });
});
