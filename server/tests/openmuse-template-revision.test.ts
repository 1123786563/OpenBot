import { describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createOpenMuseTemplateAdminRoutes } from "../src/admin/openmuse-template-routes";
import {
  createOpenMuseTemplateRevisionService,
  type OpenMuseTemplateRevisionService,
  StaleTemplateRevisionError,
} from "../src/agents/openmuse-template-store";
import type { AppVariables, AuthenticatedActor } from "../src/auth/guards";

/*
 * The guard is switchable so one app can answer as an administrator or as the
 * Bot's owner, the two roles the 403 contract separates.
 */
let currentActor: AuthenticatedActor = {
  id: "admin-1",
  email: "admin@openbot.test",
  role: "admin",
};
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", currentActor);
  await next();
};

/**
 * One stored template Bot plus a revision service reading and writing it the
 * way the drizzle-backed store does: read a snapshot, then a guarded managed
 * write that succeeds only while the version it expected is still the stored
 * one. One microtask inside each seam call, so two racing applies both read v1
 * before either write lands — the window the compare-and-swap has to close.
 */
function fakeRevisionState(overrides: Record<string, unknown> = {}): {
  state: Record<string, unknown>;
  service: OpenMuseTemplateRevisionService;
} {
  const state: Record<string, unknown> = {
    agentId: "agent_openmuse_1",
    ownerUserId: "user-1",
    templateVersion: 1,
    grants: ["mail.read"],
    systemPromptRevision: "openmuse-v1",
    title: "Research helper",
    name: "OpenMuse",
    roleDescription: "Your private OpenMuse assistant.",
    avatarSeed: "agent_openmuse_1",
    managedWrites: 0,
    ...overrides,
  };
  const service = createOpenMuseTemplateRevisionService({
    async load(ownerUserId) {
      await Promise.resolve();
      if (state.ownerUserId !== ownerUserId) return null;
      return {
        agentId: state.agentId as string,
        ownerUserId: state.ownerUserId as string,
        templateVersion: state.templateVersion as number,
        grants: [...(state.grants as string[])],
        systemPromptRevision: state.systemPromptRevision as string,
        profile: {
          name: state.name as string,
          title: state.title as string,
          roleDescription: state.roleDescription as string,
          avatarSeed: state.avatarSeed as string,
        },
      };
    },
    async applyManaged(agentId, expectedVersion, target) {
      await Promise.resolve();
      if (
        state.agentId !== agentId ||
        state.templateVersion !== expectedVersion
      )
        return 0;
      state.managedWrites = (state.managedWrites as number) + 1;
      state.templateVersion = target.version;
      state.grants = [...target.grants];
      state.systemPromptRevision = target.systemPromptRevision;
      return 1;
    },
  });
  return { state, service };
}

function adminAppFor(service: OpenMuseTemplateRevisionService) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route(
    "/api/admin/openmuse-template",
    createOpenMuseTemplateAdminRoutes({ requireUser, revisions: service }),
  );
  return app;
}

describe("previewRevision", () => {
  test("lists exactly the managed diffs, with user-edited fields user-owned and never proposed", async () => {
    const { service } = fakeRevisionState();
    const preview = await service.previewRevision("user-1", 2);
    expect(preview.storedVersion).toBe(1);
    expect(preview.targetVersion).toBe(2);
    const managed = preview.fields.filter((row) => row.ownership === "managed");
    expect(managed.map((row) => row.field).sort()).toEqual([
      "grants",
      "templateVersion",
    ]);
    const grants = managed.find((row) => row.field === "grants");
    expect(grants?.old).toEqual(["mail.read"]);
    expect(grants?.new).toEqual(["mail.read", "calendar.read"]);
    const version = managed.find((row) => row.field === "templateVersion");
    expect(version?.old).toBe(1);
    expect(version?.new).toBe(2);
    const title = preview.fields.find((row) => row.field === "title");
    expect(title?.ownership).toBe("user");
    expect(title?.old).toBe("Research helper");
    expect("new" in (title ?? {})).toBe(false);
  });

  test("answers 404 through the route for an owner with no template Bot", async () => {
    const { service } = fakeRevisionState();
    currentActor = {
      id: "admin-1",
      email: "admin@openbot.test",
      role: "admin",
    };
    const response = await adminAppFor(service).request(
      "/api/admin/openmuse-template/preview?ownerUserId=nobody&targetVersion=2",
    );
    expect(response.status).toBe(404);
  });
});

describe("applyRevision", () => {
  test("updates the managed fields and leaves the user-edited title alone", async () => {
    const { state, service } = fakeRevisionState();
    const result = await service.applyRevision("user-1", 2);
    expect(result.status).toBe("updated");
    expect(result.storedVersion).toBe(2);
    expect(state.templateVersion).toBe(2);
    expect(state.grants).toEqual(["mail.read", "calendar.read"]);
    expect(state.title).toBe("Research helper");
    const preview = await service.previewRevision("user-1", 2);
    expect(preview.storedVersion).toBe(2);
    expect(preview.fields).toHaveLength(4);
    const title = preview.fields.find((row) => row.field === "title");
    expect(title?.old).toBe("Research helper");
    expect("new" in (title ?? {})).toBe(false);
  });

  test("is a no-op success when the stored version already matches", async () => {
    // A matched version WITH its revision's managed values: the row is converged, so there is
    // nothing to write. (A matched version with drifted managed values is the test below.)
    const { state, service } = fakeRevisionState({
      templateVersion: 2,
      grants: ["mail.read", "calendar.read"],
    });
    const result = await service.applyRevision("user-1", 2);
    expect(result.status).toBe("noop");
    expect(result.storedVersion).toBe(2);
    expect(state.managedWrites).toBe(0);
  });

  test("converges managed values that drifted behind a matching version, as preview promised", async () => {
    // preview lists a drifted grant as a managed change apply will write; an apply that answered
    // noop here would contradict the preview — "exactly what apply will and will not touch".
    const { state, service } = fakeRevisionState({
      templateVersion: 2,
      grants: ["mail.read"],
    });
    const result = await service.applyRevision("user-1", 2);
    expect(result.status).toBe("updated");
    expect(result.storedVersion).toBe(2);
    expect(state.grants).toEqual(["mail.read", "calendar.read"]);
    expect(state.managedWrites).toBe(1);
  });

  test("lets exactly one of two concurrent applies write, converging on one final version", async () => {
    const { state, service } = fakeRevisionState();
    const results = await Promise.all([
      service.applyRevision("user-1", 2),
      service.applyRevision("user-1", 2),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "noop",
      "updated",
    ]);
    expect(state.managedWrites).toBe(1);
    expect(state.templateVersion).toBe(2);
    expect(state.grants).toEqual(["mail.read", "calendar.read"]);
  });

  test("refuses a target older than the stored version", async () => {
    const { service } = fakeRevisionState({ templateVersion: 2 });
    await expect(service.applyRevision("user-1", 1)).rejects.toBeInstanceOf(
      StaleTemplateRevisionError,
    );
  });
});

describe("admin routes for the template revision", () => {
  test("answers 403 to a non-admin actor, even the Bot's owner, and writes nothing", async () => {
    const { state, service } = fakeRevisionState();
    currentActor = { id: "user-1", email: "one@openbot.test", role: "user" };
    const app = adminAppFor(service);
    const preview = await app.request(
      "/api/admin/openmuse-template/preview?ownerUserId=user-1&targetVersion=2",
    );
    expect(preview.status).toBe(403);
    const apply = await app.request("/api/admin/openmuse-template/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: "user-1", targetVersion: 2 }),
    });
    expect(apply.status).toBe(403);
    expect(state.managedWrites).toBe(0);
  });

  test("an administrator previews and applies", async () => {
    const { state, service } = fakeRevisionState();
    currentActor = {
      id: "admin-1",
      email: "admin@openbot.test",
      role: "admin",
    };
    const app = adminAppFor(service);
    const preview = await app.request(
      "/api/admin/openmuse-template/preview?ownerUserId=user-1&targetVersion=2",
    );
    expect(preview.status).toBe(200);
    const previewBody = await preview.json();
    expect(previewBody.storedVersion).toBe(1);
    expect(previewBody.targetVersion).toBe(2);
    const apply = await app.request("/api/admin/openmuse-template/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: "user-1", targetVersion: 2 }),
    });
    expect(apply.status).toBe(200);
    const applyBody = await apply.json();
    expect(applyBody.status).toBe("updated");
    expect(applyBody.storedVersion).toBe(2);
    expect(state.title).toBe("Research helper");
  });

  test("maps a stale apply to 409 and an unknown target version to 400", async () => {
    const { service } = fakeRevisionState({ templateVersion: 2 });
    currentActor = {
      id: "admin-1",
      email: "admin@openbot.test",
      role: "admin",
    };
    const app = adminAppFor(service);
    const stale = await app.request("/api/admin/openmuse-template/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: "user-1", targetVersion: 1 }),
    });
    expect(stale.status).toBe(409);
    const invalid = await app.request("/api/admin/openmuse-template/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerUserId: "user-1", targetVersion: 3 }),
    });
    expect(invalid.status).toBe(400);
  });
});
