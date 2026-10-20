import { describe, expect, test } from "../../tests/support/e2e-compat";
import { authorised, statedScope } from "../src/authorisation";
import { ExecutionScopeRegistry } from "../../shared/execution-scope";

describe("who may drive the supervisor", () => {
  test("the exact bearer secret is admitted", () => {
    expect(authorised("Bearer s3cret-token", "s3cret-token")).toBe(true);
  });

  test.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the bare secret without Bearer", "s3cret-token"],
    ["a wrong secret of the same length", "Bearer s3cret-tokeX"],
    ["a prefix of the secret", "Bearer s3cret"],
    ["the secret with something appended", "Bearer s3cret-token2"],
    ["another scheme", "Basic s3cret-token"],
  ])("%s is refused", (_, header) => {
    expect(authorised(header, "s3cret-token")).toBe(false);
  });

  test("an empty configured secret admits nobody, not even an empty bearer", () => {
    expect(authorised("Bearer ", "")).toBe(false);
  });

  test("a multi-byte secret is compared by bytes and still matches only itself", () => {
    expect(authorised("Bearer clé-é", "clé-é")).toBe(true);
    expect(authorised("Bearer clé-e", "clé-é")).toBe(false);
  });
});

describe("the execution ownership a supervisor request must state (MT050)", () => {
  test("both scope headers together parse into the stated scope", () => {
    const headers = new Headers({
      "x-openbot-tenant-id": "tenant-a",
      "x-openbot-workspace-id": "team-a1",
    });
    expect(statedScope(headers)).toEqual({
      tenantId: "tenant-a",
      workspaceId: "team-a1",
    });
  });

  test.each([
    ["neither header", {}],
    ["only the tenant", { "x-openbot-tenant-id": "tenant-a" }],
    ["only the workspace", { "x-openbot-workspace-id": "team-a1" }],
    [
      "an id that could climb a path",
      { "x-openbot-tenant-id": "../etc", "x-openbot-workspace-id": "team-a1" },
    ],
    [
      "an id with a slash in it",
      {
        "x-openbot-tenant-id": "tenant/a",
        "x-openbot-workspace-id": "team-a1",
      },
    ],
    [
      "an empty id",
      { "x-openbot-tenant-id": "", "x-openbot-workspace-id": "team-a1" },
    ],
  ])("%s states no scope", (_, raw) => {
    expect(statedScope(new Headers(raw))).toBeNull();
  });

  test("a Bot's first scope binds and a different scope is refused", () => {
    const scopes = new ExecutionScopeRegistry();
    const first = { tenantId: "tenant-a", workspaceId: "team-a1" };
    const same = { tenantId: "tenant-a", workspaceId: "team-a1" };
    const otherTeam = { tenantId: "tenant-a", workspaceId: "team-a2" };
    const otherCompany = { tenantId: "tenant-b", workspaceId: "team-b1" };
    expect(scopes.bind("bot-1", first)).toBe(true);
    expect(scopes.bind("bot-1", same)).toBe(true);
    expect(scopes.bind("bot-1", otherTeam)).toBe(false);
    expect(scopes.bind("bot-1", otherCompany)).toBe(false);
    // A different Bot in a different scope binds independently.
    expect(scopes.bind("bot-2", otherCompany)).toBe(true);
    expect(scopes.scopeOf("bot-1")).toEqual(first);
  });
});
