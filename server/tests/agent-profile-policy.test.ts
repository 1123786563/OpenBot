import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  canAccessAgent,
  canManageAgent,
  canObserveAgent,
  canRunAgent,
} from "../src/agents/profile-policy";
import type { AgentActor, AgentProfile } from "../src/agents/profile-types";

const creator: AgentActor = { id: "user-1", role: "user" };
const otherUser: AgentActor = { id: "user-2", role: "user" };
const admin: AgentActor = { id: "admin-1", role: "admin" };

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "agent-1",
    name: "Researcher",
    title: "Research Assistant",
    roleDescription: "Finds and summarizes information.",
    avatarSeed: "researcher",
    visibility: "private",
    ownerUserId: creator.id,
    systemOwned: false,
    hidden: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("agent profile permissions", () => {
  test("allows every actor to access and run an active public profile", () => {
    const agent = profile({ visibility: "public", hidden: true });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(true);
      expect(canRunAgent(actor, agent)).toBe(true);
    }
  });

  test("limits active private profile access and runs to its creator and admins", () => {
    const agent = profile({ visibility: "private" });

    expect(canAccessAgent(creator, agent)).toBe(true);
    expect(canAccessAgent(otherUser, agent)).toBe(false);
    expect(canAccessAgent(admin, agent)).toBe(true);
    expect(canRunAgent(creator, agent)).toBe(true);
    expect(canRunAgent(otherUser, agent)).toBe(false);
    expect(canRunAgent(admin, agent)).toBe(true);
  });

  test("allows only the creator and admins to manage active user profiles", () => {
    for (const visibility of ["public", "private"] as const) {
      const agent = profile({ visibility });

      expect(canManageAgent(creator, agent)).toBe(true);
      expect(canManageAgent(otherUser, agent)).toBe(false);
      expect(canManageAgent(admin, agent)).toBe(true);
    }
  });

  test("allows all actors to access and run a system public profile but nobody to manage it", () => {
    const agent = profile({
      visibility: "public",
      ownerUserId: null,
      systemOwned: true,
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(true);
      expect(canRunAgent(actor, agent)).toBe(true);
      expect(canManageAgent(actor, agent)).toBe(false);
    }
  });

  // R4-02: the observation domain's own boundary — a creatorless system Bot's
  // data belongs to the administrator, editing it belongs to nobody.
  test("lets only an administrator observe a system profile, and nobody edit it", () => {
    const agent = profile({
      visibility: "public",
      ownerUserId: null,
      systemOwned: true,
    });

    expect(canObserveAgent(creator, agent)).toBe(false);
    expect(canObserveAgent(otherUser, agent)).toBe(false);
    expect(canObserveAgent(admin, agent)).toBe(true);
    // The widening is read-only: the manage answer stays closed for every role.
    expect(canManageAgent(admin, agent)).toBe(false);
  });

  test("keeps a system profile with a nominal owner closed rather than guessing", () => {
    // The provisioner never writes an owner onto a package Bot; if one ever
    // appears, nobody observes it until the access contract says who does —
    // fail closed, never assume. The admin divergence is scoped to the
    // creatorless row the Spec actually assigned (OCR R5-60): handing an
    // owner-bearing system Bot's observation face to the admin would widen
    // reading past what the contract ever said.
    const agent = profile({ visibility: "public", systemOwned: true });

    expect(canObserveAgent(creator, agent)).toBe(false);
    expect(canObserveAgent(otherUser, agent)).toBe(false);
    expect(canObserveAgent(admin, agent)).toBe(false);
  });

  test("observes a user profile exactly as its managers do", () => {
    for (const visibility of ["public", "private"] as const) {
      const agent = profile({ visibility });

      expect(canObserveAgent(creator, agent)).toBe(true);
      expect(canObserveAgent(otherUser, agent)).toBe(false);
      expect(canObserveAgent(admin, agent)).toBe(true);
    }
  });

  test("denies observation for deleted profiles", () => {
    const agent = profile({
      visibility: "public",
      deletedAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canObserveAgent(actor, agent)).toBe(false);
    }
  });

  test("denies every permission for deleted profiles", () => {
    const agent = profile({
      visibility: "public",
      deletedAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    for (const actor of [creator, otherUser, admin]) {
      expect(canAccessAgent(actor, agent)).toBe(false);
      expect(canManageAgent(actor, agent)).toBe(false);
      expect(canRunAgent(actor, agent)).toBe(false);
    }
  });

  test("exports canRunAgent as the canAccessAgent alias", () => {
    expect(canRunAgent).toBe(canAccessAgent);
  });
});
