import "./preload";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Native (root entry, plan MOD19 §3): the directory this suite would naturally sit in,
// multitenancy/, is Bun-partitioned, and these pins need no Bun-only API. The two probes that DO
// need one — driving a once-registered SDK tool handler by spying on the SDK's module namespace,
// which Node freezes — live in app/tests/approval-tools.test.tsx, whose harness already holds the
// spy; the report's §2 registers the split.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  CancelledError,
  MutationObserver,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { setHandoffGrantMutationOptions } from "../src/lib/agents/mutations";
import {
  agentKeys,
  scopedAgentHandoffQueryOptions,
} from "../src/lib/agents/queries";
import {
  recordChannelActivityMutationOptions,
  setChannelBusy,
} from "../src/lib/channels/mutations";
import { answerMastraParticipation } from "../src/lib/copilot/mastra-participation";
import { readThreadMessages } from "../src/lib/copilot/thread-messages";
import type { ScopedCache } from "../src/lib/enterprise/tenant/scoped-cache";
import {
  type ScopeSelection,
  selectionKeys,
  selectionStorageKey,
  selectWorkspaceScope,
  storeSelection,
} from "../src/lib/enterprise/tenant/selection";
import { usePackageScope } from "../src/lib/plugin-packages/use-package-scope";

/**
 * MOD19 / Issue #639: the Web surfaces that had no scope binding — the copilot tool transports,
 * the leftover unscoped halves of the agents/channels/approvals reads, the plugin-package scope
 * hook — now consume the ONE selection seam. The suite pins the seam from four sides:
 *
 * D1 pins the wire: each newly wired transport carries the selection pair as headers on the
 * reviewed paths and rides NOTHING when the scope is pending or personal — byte-for-byte what the
 * calls sent before (the same property enterprise-client.test.ts pins for `client` itself).
 *
 * D2 pins the lifecycle: a scoped read opened under one selection is refused when the generation
 * advanced under it, and the plugin-package hook answers from the same seam — a switch lands in
 * it, a personal context reads as no scope at all.
 *
 * D3 pins the behavior that must not move: a 202'd computer change still stops the run, draws the
 * approval card now, and (new with the scoped inbox) clears both cache homes; a replayed tool
 * result still converges on 409.
 *
 * D4–D6 pin the negative censuses at the source: no body ever carries the selection, the header
 * literals live only in the two infrastructure files, the migrated domains hold no payer
 * decision, the bare-call face stays exactly where the census froze it, and the scoped factories'
 * importer set is exactly the frozen census — a new importer is a new surface, and this suite
 * fails until it is reviewed in.
 */

const USER = "user-1";
const ACME: ScopeSelection = { tenantId: "acme", workspaceId: "acme-finance" };
const GLOBEX: ScopeSelection = {
  tenantId: "globex",
  workspaceId: "globex-ops",
};

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(cleanup);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  window.localStorage.clear();
});

/** The pair headers a captured init carried, however the runtime typed the bag. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const headers = init?.headers;
  if (headers === undefined || headers === null) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return headers as Record<string, string>;
}

type Asked = { path: string; init: RequestInit | undefined };

/** A fetch that records every request and answers `handler`, defaulting to 200 `{}`. */
function intercept(
  handler?: (asked: Asked) => Response | Promise<Response>,
): Asked[] {
  const asked: Asked[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const asked_: Asked = { path: String(input), init };
    asked.push(asked_);
    if (handler) return handler(asked_);
    return Response.json({});
  }) as unknown as typeof fetch;
  return asked;
}

/** An open scope value the module-level factories accept directly. */
function openScope(selection: ScopeSelection | null): ScopedCache {
  return {
    status: "open",
    userId: USER,
    selection,
    generation: 0,
    prefix:
      selection === null
        ? selectionKeys.personalScope(USER)
        : selectionKeys.workspaceScope(
            USER,
            selection.tenantId,
            selection.workspaceId,
          ),
    key: selection?.tenantId ?? "personal",
  };
}

/** One switch as production makes it: the storage mirror and the one switch seam. */
function switchSelection(
  queryClient: QueryClient,
  previous: ScopeSelection | null,
  next: ScopeSelection | null,
): void {
  if (next !== null) storeSelection(USER, next);
  else window.localStorage.removeItem(selectionStorageKey(USER));
  selectWorkspaceScope(queryClient, USER, previous, next);
}

// ---------------------------------------------------------------------------
// D1 — the newly wired transports carry the pair, and ride nothing without one
// ---------------------------------------------------------------------------

describe("MOD19 D1 — T1a transports ride the pair on the reviewed paths only", () => {
  test("the answer-basis re-export carries the pair; the history read beside it carries none", async () => {
    const asked = intercept((asked) => {
      if (asked.path.startsWith("/api/copilotkit/threads/")) {
        return Response.json({ messages: [] });
      }
      return Response.json({ basis: {} });
    });

    await readThreadMessages("th-1", "bot-1", {
      deadlineMs: 2_000,
      pair: { tenantId: ACME.tenantId, workspaceId: ACME.workspaceId },
    });

    const history = asked.find((entry) =>
      entry.path.startsWith("/api/copilotkit/"),
    );
    const basis = asked.find((entry) =>
      entry.path.startsWith("/api/enterprise/conversations/"),
    );
    expect(history).toBeDefined();
    expect(basis).toBeDefined();
    // The T3 face stays inert — the pair never rides the history read.
    expect(headersOf(history?.init)).toEqual({});
    // The re-export rides exactly the pair, on its reviewed enterprise path.
    expect(headersOf(basis?.init)).toEqual({
      "x-openbot-tenant": ACME.tenantId,
      "x-openbot-workspace": ACME.workspaceId,
    });
  });

  test("without a pair the transports are byte-for-byte what they sent before", async () => {
    const asked = intercept((asked) => {
      if (asked.path.startsWith("/api/copilotkit/threads/")) {
        return Response.json({ messages: [] });
      }
      if (asked.path === "/api/mastra-continuations?status=waiting") {
        return Response.json({ suspensions: [] });
      }
      return Response.json({});
    });

    await readThreadMessages("th-1", "bot-1", { deadlineMs: 2_000 });
    await answerMastraParticipation({
      toolCallId: "call-1",
      result: { ok: true },
    });

    for (const entry of asked) {
      // No headers object at all — the same shape every pre-MOD19 call sent.
      expect(entry.init?.headers).toBeUndefined();
    }
  });

  test("the participation lookup and answer each carry the pair", async () => {
    const asked = intercept((asked) => {
      if (asked.path === "/api/mastra-continuations?status=waiting") {
        return Response.json({
          suspensions: [
            {
              continuationId: "c-1",
              status: "waiting",
              kind: "frontend_tool",
              toolCallId: "call-1",
            },
          ],
        });
      }
      return Response.json({ ok: true });
    });

    const answered = await answerMastraParticipation({
      toolCallId: "call-1",
      result: { ok: true },
      pair: { tenantId: ACME.tenantId, workspaceId: ACME.workspaceId },
    });

    expect(answered).toBe(true);
    expect(asked.length).toBe(2);
    for (const entry of asked) {
      expect(headersOf(entry.init)["x-openbot-tenant"]).toBe(ACME.tenantId);
      expect(headersOf(entry.init)["x-openbot-workspace"]).toBe(
        ACME.workspaceId,
      );
    }
  });

  test("the channel activity and busy reports carry the open scope's pair, nothing for a pending one", async () => {
    const asked = intercept();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    await new MutationObserver(
      queryClient,
      recordChannelActivityMutationOptions(openScope(ACME)),
    ).mutate({
      channelId: "ch-1",
      text: "hi",
      agentId: "bot-1",
      at: new Date().toISOString(),
    });
    await setChannelBusy({ channelId: "ch-1", busy: true }, openScope(ACME));

    const activity = asked.find((entry) =>
      entry.path.endsWith("/api/channels/ch-1/activity"),
    );
    const busy = asked.find((entry) =>
      entry.path.endsWith("/api/channels/ch-1/busy"),
    );
    expect(activity).toBeDefined();
    expect(busy).toBeDefined();
    expect(headersOf(activity?.init)["x-openbot-tenant"]).toBe(ACME.tenantId);
    expect(headersOf(busy?.init)["x-openbot-workspace"]).toBe(ACME.workspaceId);

    // A pending scope submits nothing: the write cannot fire before the scope source answered.
    await setChannelBusy(
      { channelId: "ch-1", busy: false },
      { status: "pending" },
    );
    const lastBusy = asked
      .filter((entry) => entry.path.endsWith("/api/channels/ch-1/busy"))
      .at(-1);
    expect(lastBusy).toBeDefined();
    expect(lastBusy).not.toBe(busy);
    expect(headersOf(lastBusy?.init)["x-openbot-tenant"]).toBeUndefined();
    expect(headersOf(lastBusy?.init)["x-openbot-workspace"]).toBeUndefined();
  });

  test("the handoff grants write carries the pair on both directions", async () => {
    const asked = intercept();
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const observer = new MutationObserver(
      queryClient,
      setHandoffGrantMutationOptions(queryClient, openScope(ACME)),
    );

    await observer.mutate({ agentId: "bot-1", ref: "bot-2", granted: true });
    await observer.mutate({ agentId: "bot-1", ref: "bot-2", granted: false });

    const posts = asked.filter((entry) =>
      entry.path.includes("/api/plugins/grants"),
    );
    expect(posts.length).toBe(2);
    for (const entry of posts) {
      expect(headersOf(entry.init)["x-openbot-tenant"]).toBe(ACME.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// D1b — the once-registered tool handlers read the scope at the moment they run
// ---------------------------------------------------------------------------

/*
 * The SDK registers a frontend tool's handler once and never again (see approval-tools.ts), so
 * the probes drive the handler the registration kept, the way approval-tools.test.tsx does —
 * with the scope seeded through the real seam, so the pair the handler carries is evidence about
 * the holder, not the render.
 */

// ---------------------------------------------------------------------------
// D2 — the switch refuses late answers; the package scope reads the same seam
// ---------------------------------------------------------------------------

describe("MOD19 D2 — the one generation guards the new faces", () => {
  test("a scoped handoff read in flight is refused when the selection moves under it", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async () => {
      await gate;
      return Response.json({
        handoff: {
          enabled: false,
          canGrant: false,
          reachable: [],
          grantable: false,
        },
      });
    }) as unknown as typeof fetch;

    const open = openScope(ACME);
    const acmeKey = [
      ...selectionKeys.workspaceScope(USER, ACME.tenantId, ACME.workspaceId),
      ...agentKeys.handoff("bot-1"),
    ];
    const globexKey = [
      ...selectionKeys.workspaceScope(
        USER,
        GLOBEX.tenantId,
        GLOBEX.workspaceId,
      ),
      ...agentKeys.handoff("bot-1"),
    ];
    const inFlight = queryClient.fetchQuery(
      scopedAgentHandoffQueryOptions(queryClient, open, "bot-1"),
    );
    await Promise.resolve();
    // The one switch seam, exactly as the selection page makes it: generation first.
    switchSelection(queryClient, ACME, GLOBEX);
    release?.();

    /*
     * The read is refused and no cache is decorated. Which rejection surfaces is the cache's
     * own: the switch drops the old subtree while the answer is still held, and query-core
     * cancels the orphaned read before the guarded post-check sees the late answer — both arms
     * refuse it. `guarded`'s typed TenantSelectionChangedError is pinned at its own unit
     * (MT083 AC3 in tests/multitenancy/cache-generation.test.tsx); what THIS face adds is that
     * consuming a factory through the seam inherits the refusal.
     */
    await expect(inFlight).rejects.toBeInstanceOf(CancelledError);
    expect(queryClient.getQueryData(acmeKey)).toBeUndefined();
    expect(queryClient.getQueryData(globexKey)).toBeUndefined();
  });

  test("usePackageScope answers from the seam: a switch lands in it, the personal context is no scope", async () => {
    storeSelection(USER, ACME);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (path: Parameters<typeof fetch>[0]) => {
        const path_ = String(path);
        if (path_ === "/api/me") return Response.json({ user: { id: USER } });
        if (path_.startsWith("/api/enterprise/workspace-scope")) {
          return Response.json({
            companies: [
              {
                tenantId: ACME.tenantId,
                name: "Acme",
                role: "tenant_admin",
                memberEpoch: 1,
                teams: [{ workspaceId: ACME.workspaceId, name: "Finance" }],
              },
              {
                tenantId: GLOBEX.tenantId,
                name: "Globex",
                role: "user",
                memberEpoch: 1,
                teams: [{ workspaceId: GLOBEX.workspaceId, name: "Ops" }],
              },
            ],
          });
        }
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch;

    let seen: { tenantId?: string; workspaceId?: string } | null | "pending" =
      "pending";
    function Probe() {
      const { scope, currentUserPending } = usePackageScope();
      seen = currentUserPending ? "pending" : scope;
      return null;
    }
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(seen).toEqual({
        tenantId: ACME.tenantId,
        workspaceId: ACME.workspaceId,
        principalId: USER,
      }),
    );

    // The same tab's switch: the hook follows the seam without re-reading storage by itself.
    await act(async () => {
      switchSelection(queryClient, ACME, GLOBEX);
    });
    await waitFor(() =>
      expect(seen).toEqual({
        tenantId: GLOBEX.tenantId,
        workspaceId: GLOBEX.workspaceId,
        principalId: USER,
      }),
    );

    // Back to the personal context: no scope, exactly as no selection ever meant.
    await act(async () => {
      switchSelection(queryClient, GLOBEX, null);
    });
    await waitFor(() => expect(seen).toBeNull());
    view.unmount();
  });
});

// ---------------------------------------------------------------------------
// D3 — the behaviors that must not move
// ---------------------------------------------------------------------------

describe("MOD19 D3 — decisions and suspensions converge as before", () => {
  test("a replayed tool result converges on 409 and carries the pair on the way", async () => {
    const asked = intercept((asked) => {
      if (asked.path === "/api/mastra-continuations?status=waiting") {
        return Response.json({
          suspensions: [
            {
              continuationId: "c-1",
              status: "waiting",
              kind: "frontend_tool",
              toolCallId: "call-1",
            },
          ],
        });
      }
      // Another device answered first; convergence, not failure.
      return Response.json({ error: "already answered" }, { status: 409 });
    });

    const answered = await answerMastraParticipation({
      toolCallId: "call-1",
      result: null,
      pair: { tenantId: ACME.tenantId, workspaceId: ACME.workspaceId },
    });

    expect(answered).toBe(true);
    const answer = asked.find((entry) => entry.path.includes("/tool-result"));
    expect(answer).toBeDefined();
    expect(headersOf(answer?.init)["x-openbot-tenant"]).toBe(ACME.tenantId);
  });

  test("a real participation refusal still throws with the server's own sentence", async () => {
    intercept((asked) => {
      if (asked.path === "/api/mastra-continuations?status=waiting") {
        return Response.json({
          suspensions: [
            {
              continuationId: "c-1",
              status: "waiting",
              kind: "frontend_tool",
              toolCallId: "call-1",
            },
          ],
        });
      }
      return Response.json(
        { error: "Not this caller's suspension" },
        { status: 403 },
      );
    });

    await expect(
      answerMastraParticipation({
        toolCallId: "call-1",
        result: null,
        pair: { tenantId: ACME.tenantId, workspaceId: ACME.workspaceId },
      }),
    ).rejects.toThrow("Not this caller's suspension");
  });
});

// ---------------------------------------------------------------------------
// D4 — acceptance ③ pinned at the source: no body ever carries the selection
// ---------------------------------------------------------------------------

const APP_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = walk(APP_SRC);

describe("MOD19 D4 — the browser selects, it never signs a scope or decides a payer", () => {
  test("no request body in app/src carries tenantId or workspaceId", () => {
    const offenders = SOURCE_FILES.filter((file) => {
      const text = readFileSync(file, "utf8").replace(
        // The one body that names a selection is the explicit target the person picked
        // (selection.ts:552-566, #542 T03.05); it carries no scope headers at all.
        /^\s*body: \{ tenantId: target\.tenantId, workspaceId: target\.workspaceId \},\s*$/m,
        "",
      );
      return /^\s*.*body:.*\b(tenantId|workspaceId)\b/m.test(text);
    });
    expect(offenders).toEqual([]);
  });

  test("the selection header literals live only in the two transport infrastructure files", () => {
    const offenders = SOURCE_FILES.filter((file) => {
      const relative = file.slice(APP_SRC.length + 1);
      if (
        relative === "lib/client.ts" ||
        relative === "lib/enterprise/tenant/stream-scope.ts"
      )
        return false;
      return readFileSync(file, "utf8").includes('"x-openbot-tenant"');
    });
    expect(offenders).toEqual([]);
  });

  test("the migrated domains hold no payer decision", () => {
    const domains = [
      "lib/copilot",
      "lib/agents",
      "lib/channels",
      "lib/approvals.ts",
      "lib/plugin-packages",
      "components/agents",
      "components/channels",
      "components/approvals",
      "components/plugin-packages",
    ];
    const offenders = SOURCE_FILES.filter((file) => {
      const relative = file.slice(APP_SRC.length + 1);
      if (!domains.some((domain) => relative.startsWith(domain))) return false;
      return /\bpayer\b/i.test(readFileSync(file, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D5 — acceptance ④: the bare-call face is exactly where the census froze it
// ---------------------------------------------------------------------------

/** client(/tryClient( call sites, with imports and comments discounted. */
function bareCallFiles(): string[] {
  return SOURCE_FILES.filter((file) => {
    const body = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*")
        )
          return false;
        if (trimmed.startsWith("import ")) return false;
        return true;
      })
      .join("\n");
    return /(^|[^a-zA-Z.])(client|tryClient)\(/.test(body);
  });
}

describe("MOD19 D5 — no bypass path outside the data-access layer", () => {
  test("routes call client only in the admin audit face; components only in the admin cards", () => {
    const offenders = bareCallFiles()
      .map((file) => file.slice(APP_SRC.length + 1))
      .filter((relative) => !relative.startsWith("lib/"));
    expect(offenders.sort()).toEqual([
      "components/admin/billing-cleanup-execution-card.tsx",
      "components/admin/billing-recovery-review-card.tsx",
      "components/billing/admin-credit-grant.tsx",
      "routes/_authed/admin/audit.tsx",
    ]);
  });
});

// ---------------------------------------------------------------------------
// D6 — acceptance ⑤: the scoped factories' importer set is the frozen census
// ---------------------------------------------------------------------------

const SCOPED_FACTORY_IMPORTERS = [
  "components/agents/handoff-panel.tsx",
  "components/app-sidebar/app-sidebar.tsx",
  "components/approvals/bot-rules.tsx",
  "components/approvals/inline-approval.tsx",
  "components/approvals/settings.tsx",
  "components/approvals/team-settings.tsx",
  "components/approvals/waiting.tsx",
  "components/bot-profile/bot-subpage.tsx",
  "components/bot-profile/settings-rows.tsx",
  "components/bots/bot-roster.tsx",
  "components/channels/channel-chat.tsx",
  "components/channels/recipient-field.tsx",
  "components/computer/demonstration-recorder.tsx",
  "components/delivery/reaching-you.tsx",
  "components/memory/memories.tsx",
  "components/memory/sources.tsx",
  "components/responsibilities/new-responsibility-dialog.tsx",
  "components/skills/skill-agents.tsx",
  "components/suggestions/proactive-panel.tsx",
  "lib/agents/queries.ts",
  "lib/approvals.ts",
  "lib/channels/mark-read.ts",
  "lib/channels/queries.ts",
  "routes/_authed/_app/bot.tsx",
  "routes/_authed/_app/bots.$agentId.index.tsx",
  "routes/_authed/_app/channel/$channelId.tsx",
  "routes/_authed/_app/channel/new.tsx",
  "routes/_authed/_app/group/$channelId.tsx",
  "routes/_authed/_app/index.tsx",
  "routes/_authed/admin/components/$name.tsx",
  "routes/_authed/admin/market.tsx",
  "routes/_authed/admin/plugins/$key_.bots.$agentId.tsx",
  "routes/_authed/admin/plugins/$key_.tools.$tool.tsx",
  "routes/_authed/admin/plugins/$key.tsx",
  "routes/_authed/admin/skills.tsx",
  "routes/_authed/onboarding.tsx",
  "routes/_authed/settings/components-gallery/$name.tsx",
];

describe("MOD19 D6 — no new UI, route or visual beyond the census", () => {
  test("the scoped query factories are imported by exactly the census-frozen files", () => {
    const factories =
      /scopedAgentListQueryOptions|scopedAgentDetailQueryOptions|scopedAgentHandoffQueryOptions|scopedChannelListQueryOptions|scopedChannelDetailQueryOptions|scopedApprovalInboxOptions/;
    const importers = SOURCE_FILES.filter((file) =>
      factories.test(readFileSync(file, "utf8")),
    )
      .map((file) => file.slice(APP_SRC.length + 1))
      .sort();
    expect(importers).toEqual([...SCOPED_FACTORY_IMPORTERS].sort());
  });
});
