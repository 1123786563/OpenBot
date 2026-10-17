import { afterEach, describe, expect, test } from "../../tests/support/e2e-compat";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ConnectableApp } from "../src/craft/agent-instructions";
import { loadCraftConfig } from "../src/craft/config";
import {
  type CraftManagedContentResolver,
  createCraftManagedContentResolver,
} from "../src/craft/managed-content";
import type { CraftLLMProviderConfig } from "../src/craft/opencode-config";
import { createCraftRoutes } from "../src/craft/routes";
import type { CraftSessionRow, CraftStore } from "../src/craft/store";
import { sessionDirectory } from "../src/craft/workspace";

/**
 * The ASSEMBLY contract (routes.ts): when the boot file wires only
 * `managedContentFor` (production's shape — no explicit hashes seam), the manager's
 * staleness source must derive from the same resolver `skills_stale` reads. A
 * regression here is silent: `skills_stale` answers true forever while
 * `POST /skills/reload` no-ops (a forced null hash pair can never be stale), so the
 * API contradicts itself and the runtime never converges.
 *
 * The sandbox is a local HTTP stub speaking the gateway's /file verbs, so the request
 * travels the real route stack → manager → gateway → file API, not a direct
 * CraftSessionManager construction.
 */

const SESSION_ID = "cs-assembly";
const USER_ID = "u1";
const encoder = new TextEncoder();

const config = loadCraftConfig({
  OPENBOT_CRAFT_ENABLED: "true",
  OPENBOT_CRAFT_IDLE_REAPER_ENABLED: "false",
});

const DIRECTORY = sessionDirectory(SESSION_ID, config.sessionDirectoryMode);

const llm: CraftLLMProviderConfig = {
  provider: "openbot",
  modelName: "glm-test",
  apiKey: null,
  apiBase: null,
  displayName: null,
  models: null,
};

/** The agent-sandbox gateway's /file verbs, backed by one in-memory tree. */
function stubSandbox() {
  const files = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = url.searchParams.get("path");
      if (url.pathname === "/file" && path !== null) {
        if (request.method === "GET") {
          return Response.json(
            [...files.keys()].filter((key) => key.startsWith(`${path}/`)),
          );
        }
        if (request.method === "POST") {
          files.set(path, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        if (request.method === "DELETE") {
          return new Response(null, {
            status: files.delete(path) ? 200 : 404,
          });
        }
      }
      return new Response(null, { status: 404 });
    },
  });
  return {
    files,
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}

const stubs: Array<() => void> = [];
afterEach(() => {
  while (stubs.length > 0) {
    stubs.pop()?.();
  }
});

function requireUser(): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    context.set("actor", {
      id: USER_ID,
      email: "u1@example.com",
      role: "user",
    });
    await next();
  };
}

describe("createCraftRoutes assembly: resolver-only wiring converges", () => {
  test("a session on hash A reloads when the resolver answers hash B (push + AGENTS.md + ack)", async () => {
    const stub = stubSandbox();
    stubs.push(stub.stop);

    // The resolver's sources flip under the assembly: content A at "create" time,
    // content B afterwards (the user connected/removed an app, a skill changed).
    let apps: ConnectableApp[] = [{ id: "7", name: "Slack" }];
    let skillFiles = new Map([["search/SKILL.md", encoder.encode("v1")]]);
    const resolver: CraftManagedContentResolver =
      createCraftManagedContentResolver({
        connectableAppsFor: async () => apps,
        skillFilesFor: async () => skillFiles,
      });

    const row: CraftSessionRow = {
      id: SESSION_ID,
      userId: USER_ID,
      name: null,
      status: "active",
      lastActivityAt: new Date(),
      createdAt: new Date(),
      nextjsPort: null,
      sharingScope: "private",
      origin: "INTERACTIVE",
      opencodeSessionId: "ses_1",
      agentProvider: null,
      agentModel: null,
      // The row records hash A — what a session created under content A acked.
      skillsHash: (await resolver({ id: SESSION_ID, userId: USER_ID }))
        .skillsHash,
      mcpConfigHash: (await resolver({ id: SESSION_ID, userId: USER_ID }))
        .mcpConfigHash,
    };
    const updates: Array<Record<string, unknown>> = [];
    const store = {
      async getSession(id: string, userId: string) {
        return id === SESSION_ID && userId === USER_ID ? { ...row } : undefined;
      },
      async findSession(id: string, userId: string) {
        return id === SESSION_ID && userId === USER_ID ? { ...row } : undefined;
      },
      async updateSession(id: string, patch: Record<string, unknown>) {
        updates.push({ id, patch });
        Object.assign(row, patch);
        return { ...row };
      },
    } as unknown as CraftStore;

    // Production's wiring shape: managedContentFor ONLY — no explicit hashes seam.
    const app = createCraftRoutes({
      requireUser: requireUser(),
      deps: {
        config,
        db: {} as never,
        redis: null,
        approvals: {} as never,
        botIdFor: async () => "craft-bot",
        llmConfigFor: async () => llm,
        sandboxConnectionFor: () => ({ baseUrl: stub.baseUrl, token: null }),
        userNameFor: async () => "Ada",
        managedContentFor: resolver,
        store,
      },
    });

    // Content B goes live under the session.
    apps = [{ id: "11", name: "Linear" }];
    skillFiles = new Map([["search/SKILL.md", encoder.encode("v2")]]);
    const contentB = await resolver({ id: SESSION_ID, userId: USER_ID });

    // skills_stale derives true through the same seam the reload reads...
    const detail = await app.request(`/sessions/${SESSION_ID}`);
    expect(
      ((await detail.json()) as { skills_stale: boolean }).skills_stale,
    ).toBe(true);

    // ...so the reload actually converges: push + regenerate + ack.
    const reload = await app.request(`/sessions/${SESSION_ID}/skills/reload`, {
      method: "POST",
    });
    expect(reload.status).toBe(200);
    expect(await reload.json()).toEqual({ skills_stale: false });

    expect(
      stub.files.get(`${DIRECTORY}/.opencode/skills/search/SKILL.md`),
    ).toEqual(encoder.encode("v2"));
    const agentsMd = new TextDecoder().decode(
      stub.files.get(`${DIRECTORY}/AGENTS.md`) ?? new Uint8Array(),
    );
    expect(agentsMd).toContain("- External app ID `11`: **Linear**");
    expect(updates).toEqual([
      {
        id: SESSION_ID,
        patch: {
          skillsHash: contentB.skillsHash,
          mcpConfigHash: contentB.mcpConfigHash,
        },
      },
    ]);

    // Converged: a second reload is onyx's non-stale no-op (nothing pushed, acked again).
    const again = await app.request(`/sessions/${SESSION_ID}/skills/reload`, {
      method: "POST",
    });
    expect(await again.json()).toEqual({ skills_stale: false });
    expect(updates).toHaveLength(1);
    const detailAfter = await app.request(`/sessions/${SESSION_ID}`);
    expect(
      ((await detailAfter.json()) as { skills_stale: boolean }).skills_stale,
    ).toBe(false);
  });
});
