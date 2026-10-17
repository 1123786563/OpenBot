#!/usr/bin/env bun
/**
 * MT001 — multitenancy entry inventory.
 *
 * The inventory is the coverage fact source for the multitenancy program: it extracts the registered
 * HTTP surface from the REAL deployment assembly (`createApp` in `server/src/app.ts` — mounts
 * included, never hand-written constants), lists the tables of both databases, and carries the
 * background-program candidate registry. The gap report then tells the program which entries still
 * have no owning ticket.
 *
 * Static by construction: building it never opens a database connection, so it runs with or without
 * `TEST_DATABASE_URL`. When the script is executed directly it writes the JSON inventory to stdout
 * (or `--out <file>`) and a human summary to stderr.
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { createCraftRoutes } from "../../src/craft/routes";
import * as schema from "../../src/db/schema";
import { githubCallbackRoutes } from "../../src/identity/github-callback";
import * as kbSchema from "../../src/kb/db/schema";
import { createWorkshopPublicRoutes } from "../../src/workshop/public-routes";
import { createWorkshopRoutes } from "../../src/workshop/routes";
import { testEnvironment } from "../../tests/support/environment";

export interface InventoryRoute {
  readonly method: string;
  readonly path: string;
  readonly note?: string;
}

export interface RouterSection {
  readonly prefix: string;
  readonly routes: readonly InventoryRoute[];
  /** Set when the real factory could not be built with stubs and a marker entry stands in. */
  readonly fallback?: string;
}

export interface BackgroundEntry {
  readonly name: string;
  readonly path: string;
  readonly note: string;
  readonly status: "present" | "missing";
}

export interface Inventory {
  readonly generated_at: string;
  readonly base: { readonly kind: "git" | "unknown"; readonly commit: string };
  readonly routes: readonly InventoryRoute[];
  /** Factory-built router sections, reported separately so fallback markers stay visible. */
  readonly router_sections: readonly RouterSection[];
  readonly tables: {
    readonly main: readonly string[];
    readonly kb: readonly string[];
  };
  readonly background: readonly BackgroundEntry[];
  readonly counts: {
    readonly routes: number;
    readonly tables_main: number;
    readonly tables_kb: number;
    readonly background: number;
  };
}

export interface OwnerRule {
  /** Path prefix (exact segment match, e.g. `/api/channels`) that the ticket owns. */
  readonly prefix: string;
  readonly ticket: string;
}

/**
 * Background programs that are not HTTP routes in the deployment app. These are candidates: each one
 * is reconciled by the ticket that owns it (worker → MT041+, supervisor/agents → MT048/MT049, the
 * scheduled script → MT053/MT122+), and `MT105` re-checks the list at assembly closure.
 */
export const BACKGROUND_CANDIDATES = [
  { name: "worker", path: "worker/src/index.ts", note: "工作队列执行进程" },
  {
    name: "kb-worker",
    path: "server/src/kb/worker.ts",
    note: "知识库异步任务进程",
  },
  {
    name: "workshop-schedules",
    path: "server/scripts/fire-workshop-schedules.ts",
    note: "Workshop 计划触发脚本",
  },
  { name: "supervisor", path: "supervisor/src", note: "电脑/浏览器监督进程" },
  {
    name: "agent-computer",
    path: "agent-computer/src",
    note: "电脑 agent 服务",
  },
  { name: "agent-sandbox", path: "agent-sandbox/src", note: "沙箱 agent 服务" },
] as const;

export function routeKey(route: InventoryRoute): string {
  return `${route.method} ${route.path}`;
}

/** Structural router shape: anything with a flattened route table, so Hono generics never leak here. */
export interface RouterLike {
  readonly routes: readonly { method: string; path: string }[];
}

/** Extracts the flattened route surface of a Hono app, deduplicated and sorted for stable baselines. */
export function collectRoutes(app: RouterLike): InventoryRoute[] {
  const rows = app.routes.map((r) => ({
    method: String(r.method),
    path: String(r.path),
  }));
  const seen = new Set<string>();
  const routes: InventoryRoute[] = [];
  for (const row of rows) {
    const key = routeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(row);
  }
  routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
  return routes;
}

function tableNames(mod: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const value of Object.values(mod)) {
    try {
      names.add(getTableConfig(value as never).name);
    } catch {
      // Not a table export (enum, relation, helper) — nothing to inventory.
    }
  }
  return [...names].sort();
}

function backgroundEntries(): BackgroundEntry[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const root = path.resolve(import.meta.dir, "../../..");
  return BACKGROUND_CANDIDATES.map((c) => ({
    ...c,
    status: fs.existsSync(path.resolve(root, c.path))
      ? ("present" as const)
      : ("missing" as const),
  }));
}

function gitBase(): { kind: "git" | "unknown"; commit: string } {
  try {
    return {
      kind: "git",
      commit: execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(),
    };
  } catch {
    return { kind: "unknown", commit: "" };
  }
}

/**
 * A callable Proxy stub that answers every property with another stub (and every router read of
 * `.routes` with an empty array). Optional dependencies in `createApp` are truthiness-gated at
 * registration time, so filling every optional slot with a stub opens all conditional mounts without
 * touching a database, the runtime, or a real provider.
 */
function anyStub(): never {
  const fn = function stub(): never {
    return anyStub();
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === "routes") return [];
      if (prop === "then" || prop === "catch" || prop === "finally")
        return undefined;
      if (prop === Symbol.toPrimitive) return () => "stub";
      return anyStub();
    },
    has() {
      return true;
    },
  }) as never;
}

const requireUserStub = async (_c: unknown, next: () => Promise<void>) => {
  await next();
};

/**
 * Routers the deployment builds from FACTORY arguments rather than importing: the inventory builds
 * each with the real factory and stub dependencies, so their surface is extracted, not guessed. If a
 * factory cannot even be constructed with stubs, a marker entry still keeps the entry point visible
 * in the inventory instead of silently dropping it.
 */
function factoryRouterSections(): RouterSection[] {
  const sections: RouterSection[] = [];
  const attempt = (prefix: string, build: () => RouterLike) => {
    try {
      // A standalone sub-app carries its own relative paths; the deployment flattens them at mount
      // time, so the inventory applies the mount prefix itself to keep sections comparable.
      const routes = collectRoutes(build()).map((r) => ({
        ...r,
        path: r.path === "/" ? prefix : `${prefix}${r.path}`,
      }));
      sections.push({ prefix, routes });
    } catch (error) {
      sections.push({
        prefix,
        routes: [
          {
            method: "ALL",
            path: `${prefix}/*`,
            note: "factory placeholder — real factory failed with stubs",
          },
        ],
        fallback: error instanceof Error ? error.message : String(error),
      });
    }
  };
  attempt("/api/workshop", () =>
    createWorkshopRoutes({
      requireUser: requireUserStub as never,
      canUseBot: async () => true,
      deps: anyStub(),
    }),
  );
  attempt("/api/public/workshop", () => createWorkshopPublicRoutes(anyStub()));
  attempt("/api/craft", () =>
    createCraftRoutes({
      requireUser: requireUserStub as never,
      deps: anyStub(),
    }),
  );
  attempt("/api/identity/github/callback", () =>
    githubCallbackRoutes(anyStub()),
  );
  return sections;
}

/**
 * Builds the app with every optional dependency present as a stub (the same degraded-defaults rule
 * the app documents: absent stores answer 503 at request time, they never unregister routes), so the
 * extracted surface is the complete real one — conditional mounts included — without a database.
 */
function deploymentRoutes(): {
  routes: InventoryRoute[];
  factorySections: RouterSection[];
} {
  // createApp takes its services positionally; the first three are required for every route
  // registration, everything after is optional and truthiness-gated at mount time.
  const args: unknown[] = new Array(createApp.length).fill(anyStub());
  args[0] = loadConfig(testEnvironment());
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: { getSession: async () => null },
  };
  args[2] = { rolesForUser: async () => [] };
  const assemble = createApp as unknown as (...a: unknown[]) => RouterLike;
  const own = collectRoutes(assemble(...args));
  const factorySections = factoryRouterSections();
  // The CopilotKit AG-UI endpoint is built from the runtime (which Bun tests cannot import), so it is
  // recorded as a single marker entry rather than being expanded.
  const copilot: InventoryRoute = {
    method: "POST",
    path: "/",
    note: "CopilotKit AG-UI endpoint (runtime-built)",
  };
  const merged = new Map<string, InventoryRoute>();
  for (const route of [
    copilot,
    ...own,
    ...factorySections.flatMap((s) => s.routes),
  ]) {
    const key = routeKey(route);
    if (!merged.has(key)) merged.set(key, route);
  }
  const routes = [...merged.values()].sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
  return { routes, factorySections };
}

export function buildInventory(): Inventory {
  const { routes, factorySections } = deploymentRoutes();
  const tables = {
    main: tableNames(schema as Record<string, unknown>),
    kb: tableNames(kbSchema as Record<string, unknown>),
  };
  const background = backgroundEntries();
  return {
    generated_at: new Date().toISOString(),
    base: gitBase(),
    routes,
    router_sections: factorySections,
    tables,
    background,
    counts: {
      routes: routes.length,
      tables_main: tables.main.length,
      tables_kb: tables.kb.length,
      background: background.length,
    },
  };
}

/** Longest-prefix owner wins, so a broad rule (`/api`) cannot shadow a specific one (`/api/channels`). */
export function ownerFor(
  route: InventoryRoute,
  owners: readonly OwnerRule[],
): string | null {
  let best: OwnerRule | null = null;
  for (const rule of owners) {
    const owns =
      route.path === rule.prefix || route.path.startsWith(`${rule.prefix}/`);
    if (!owns) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best?.ticket ?? null;
}

export interface GapReport {
  readonly routes: number;
  readonly assigned: number;
  readonly unassigned: number;
  readonly unassignedSample: readonly string[];
}

export function gapReport(
  inventory: Pick<Inventory, "routes">,
  owners: readonly OwnerRule[],
): GapReport {
  const unassigned: string[] = [];
  let assigned = 0;
  for (const route of inventory.routes) {
    if (ownerFor(route, owners)) assigned += 1;
    else unassigned.push(routeKey(route));
  }
  return {
    routes: inventory.routes.length,
    assigned,
    unassigned: unassigned.length,
    unassignedSample: unassigned.slice(0, 40),
  };
}

function isMainModule(): boolean {
  return typeof Bun !== "undefined" && import.meta.main;
}

if (isMainModule()) {
  const outIndex = process.argv.indexOf("--out");
  const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  let owners: OwnerRule[] = [];
  const ownersIndex = process.argv.indexOf("--owners");
  if (ownersIndex >= 0 && process.argv[ownersIndex + 1]) {
    owners = JSON.parse(
      require("node:fs").readFileSync(process.argv[ownersIndex + 1], "utf8"),
    ) as OwnerRule[];
  }
  const inventory = buildInventory();
  const report = gapReport(inventory, owners);
  const fallbacks = inventory.router_sections.filter((s) => s.fallback);
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  if (outFile) {
    require("node:fs").writeFileSync(outFile, json);
  } else {
    process.stdout.write(json);
  }
  process.stderr.write(
    `${[
      `multitenancy entry inventory @ ${inventory.base.commit.slice(0, 8) || "unknown"}`,
      `  routes: ${inventory.counts.routes} (assigned ${report.assigned}, unassigned ${report.unassigned})`,
      `  tables: main ${inventory.counts.tables_main}, kb ${inventory.counts.tables_kb}`,
      `  background: ${inventory.counts.background}`,
      ...(fallbacks.length > 0
        ? [
            `  factory fallbacks:`,
            ...fallbacks.map(
              (s) => `    ${s.prefix}: ${s.fallback?.slice(0, 120)}`,
            ),
          ]
        : []),
      ...(report.unassigned > 0
        ? [
            "  unassigned sample:",
            ...report.unassignedSample.slice(0, 10).map((k) => `    ${k}`),
          ]
        : ["  coverage: all routes assigned"]),
    ].join("\n")}\n`,
  );
}
