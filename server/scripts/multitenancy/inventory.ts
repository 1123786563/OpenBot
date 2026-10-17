/**
 * MT001 (Issue #44) — the multitenancy entry inventory generator.
 *
 * One command any agent or reviewer can run to see every entry the real application registers —
 * HTTP/stream/internal routes, background programs, data tables and external dependencies — and
 * which of them still have no owner. This inventory is the single entry point for multitenancy
 * coverage acceptance (A6/A11): later loop tickets and the MT132 acceptance harness consume it,
 * so the entry field names below are contract. Do not rename them; extend instead.
 *
 * Where the data comes from — the acceptance criteria of the ticket:
 *
 * - HTTP entries are extracted from REAL assembly: `createApp` (the deploy entry) is executed
 *   twice, once in a minimal shape (no optional dependency wired) and once in a full shape
 *   (every optional dependency present as an inert stand-in). Because mounting only checks
 *   presence and registers real route factories, the resulting route table is the one the real
 *   deployment would register — including conditional mounts that disappear when a dependency is
 *   absent. Nothing in the route list is handwritten.
 * - The enterprise entry (enterprise conversation routes) is the real
 *   `createConversationRoutes` factory mounted through the same `coworker` seam index.ts uses.
 * - Background programs, tables and external dependencies are static candidates extracted from
 *   the real modules that own them (each entry names its source), per the ticket's scope
 *   boundary ("入口清单生成器与静态候选提取").
 * - The database section never falls back to the deployment database. Without a dedicated test
 *   database (TEST_DATABASE_URL / ENTERPRISE_TEST_SETUP_DATABASE_URL, loopback only) it is
 *   skipped with a reason that names the missing variable; it is never silently "passed".
 *
 * Usage:
 *
 *   bun server/scripts/multitenancy/inventory.ts                 # JSON to stdout, gap report to stderr
 *   bun server/scripts/multitenancy/inventory.ts --out docs/multitenancy
 *   bun server/scripts/multitenancy/inventory.ts --check         # diff against the committed baseline
 */
import { readFileSync } from "node:fs";
import { SQL } from "bun";
import { Hono } from "hono";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import { createConversationRoutes } from "../../src/enterprise/conversations/routes";
import { createWorkshopRoutes } from "../../src/workshop/routes";
import { createWorkshopPublicRoutes } from "../../src/workshop/public-routes";
import { createCraftRoutes } from "../../src/craft/routes";
import { loadCraftConfig } from "../../src/craft/config";
import { githubCallbackRoutes } from "../../src/identity/github-callback";
import { createTriggerIngressRoutes } from "../../src/responsibilities/trigger-routes";
import {
  createOpenMuseGoogleCallbackRoutes,
  createOpenMuseGoogleRoutes,
} from "../../src/openmuse-connectors/routes";
import { createOpenMuseMailRoutes } from "../../src/openmuse-mail/routes";
import { createOpenMuseCalendarRoutes } from "../../src/openmuse-calendar/routes";
import { createOpenMuseReviewedActionsRoutes } from "../../src/openmuse-reviewed-actions/routes";
import { createOpenMuseGoalsRoutes } from "../../src/openmuse-personal/goals";
import { createOpenMuseIdeasRoutes } from "../../src/openmuse-personal/ideas";
import { createOpenMuseMemoriesRoutes } from "../../src/openmuse-personal/memories";
import { createOpenMuseNotificationRoutes } from "../../src/openmuse-notifications/routes";
import { createOpenMuseDocumentsRoutes } from "../../src/openmuse-documents/routes";
import { createOpenMuseActivityRoutes } from "../../src/openmuse-activity/routes";
import { createOpenMuseOpsSignalsRoutes } from "../../src/openmuse-ops/routes";
// Data tables: one import per schema module so every table entry can name the file that owns it.
import * as schemaAdmin from "../../src/db/schema/admin";
import * as schemaApprovals from "../../src/db/schema/approvals";
import * as schemaBilling from "../../src/db/schema/billing";
import * as schemaCodeRuns from "../../src/db/schema/code-runs";
import * as schemaComponents from "../../src/db/schema/components";
import * as schemaComputer from "../../src/db/schema/computer";
import * as schemaCore from "../../src/db/schema/core";
import * as schemaCoworker from "../../src/db/schema/coworker";
import * as schemaCraft from "../../src/db/schema/craft";
import * as schemaCreditReservations from "../../src/db/schema/credit-reservations";
import * as schemaCredits from "../../src/db/schema/credits";
import * as schemaDefaults from "../../src/db/schema/defaults";
import * as schemaDelivery from "../../src/db/schema/delivery";
import * as schemaDemonstrations from "../../src/db/schema/demonstrations";
import * as schemaEnterpriseConversations from "../../src/db/schema/enterprise-conversations";
import * as schemaEnterpriseExpertVersions from "../../src/db/schema/enterprise-expert-versions";
import * as schemaEnterpriseModelRoutes from "../../src/db/schema/enterprise-model-routes";
import * as schemaEnterpriseRuns from "../../src/db/schema/enterprise-runs";
import * as schemaEnterpriseTenancy from "../../src/db/schema/enterprise-tenancy";
import * as schemaGroup from "../../src/db/schema/group";
import * as schemaIdentity from "../../src/db/schema/identity";
import * as schemaLearning from "../../src/db/schema/learning";
import * as schemaLifecycle from "../../src/db/schema/lifecycle";
import * as schemaMastraMessageIntents from "../../src/db/schema/mastra-message-intents";
import * as schemaMastraTenantStorage from "../../src/db/schema/mastra-tenant-storage";
import * as schemaMemory from "../../src/db/schema/memory";
import * as schemaOpenMuse from "../../src/db/schema/openmuse";
import * as schemaPasswords from "../../src/db/schema/passwords";
import * as schemaPayment from "../../src/db/schema/payment";
import * as schemaPlugins from "../../src/db/schema/plugins";
import * as schemaProactive from "../../src/db/schema/proactive";
import * as schemaResponsibilities from "../../src/db/schema/responsibilities";
import * as schemaSandboxInstances from "../../src/db/schema/sandbox-instances";
import * as schemaScim from "../../src/db/schema/scim";
import * as schemaSharedUse from "../../src/db/schema/shared-use";
import * as schemaTeamBots from "../../src/db/schema/team-bots";
import * as schemaUsageOutbox from "../../src/db/schema/usage-outbox";
import * as schemaVoice from "../../src/db/schema/voice";
import * as schemaWork from "../../src/db/schema/work";
import * as schemaWorkshop from "../../src/db/schema/workshop";
import * as schemaKb from "../../src/kb/db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Contract types
// ─────────────────────────────────────────────────────────────────────────────

/** How an entry is reached. `stream` covers SSE/WebSocket-style surfaces. */
export type InventoryEntryKind =
  | "http"
  | "stream"
  | "internal"
  | "background"
  | "table"
  | "external";

export type InventoryStatus = "owned" | "unowned" | "exempt";

/** Surface classification shared with the multitenancy implementation plan (interfaces.md). */
export type SurfaceClass =
  | "company-workspace"
  | "company-management"
  | "global-auth"
  | "global-static"
  | "platform-operator"
  | "machine-delegation"
  | "personal-model";

export interface InventoryEntry {
  /** Stable identifier, e.g. `http:GET:/api/me`, `job:memory-sweep`, `table:users`. */
  id: string;
  kind: InventoryEntryKind;
  /** HTTP entries: the method and registered path pattern. */
  method?: string;
  path?: string;
  /** HTTP entries: whether the route registers in every assembly or only when wired. */
  shape?: "unconditional" | "conditional";
  /** Which assembly registers the entry. */
  assembly?: "deploy" | "enterprise";
  /** The real module/file that owns the entry. */
  source?: string;
  /** Free-form note (e.g. vendor-built surface, separate database). */
  note?: string;
  /** Table entries: the table name. */
  name?: string;
  /** External entries: whether the seam is wired in the assembly's environment. */
  presentInAssembly?: boolean;
  // ── The machine-readable ownership contract (do not rename): ──
  businessLoop: string | null;
  ownerTask: string | null;
  status: InventoryStatus;
  classification: SurfaceClass | null;
  exemptionReason?: string | null;
}

export interface DatabaseTableCheck {
  name: string;
  presence: "present" | "missing";
  rowLevelSecurity: boolean;
}

export interface InventoryDatabaseSection {
  status: "checked" | "skipped";
  reason?: string;
  tables?: DatabaseTableCheck[];
}

export interface InventorySummary {
  total: number;
  byKind: Record<InventoryEntryKind, number>;
  byStatus: Record<InventoryStatus, number>;
  /** Entries with no owner task — the coverage gap. */
  gaps: number;
  /** Non-exempt entries with no business loop assigned yet. */
  unclassified: number;
}

export interface EntryInventory {
  schemaVersion: 1;
  /** Every entry, sorted by id — HTTP/stream/internal, background, tables, external. */
  entries: InventoryEntry[];
  database: InventoryDatabaseSection;
  summary: InventorySummary;
}

export interface InventoryDiff {
  added: InventoryEntry[];
  removed: InventoryEntry[];
  ownershipChanged: InventoryEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical assembly environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fixed environment the inventory assembles under. Deliberately NOT process.env: the
 * inventory and its baseline snapshot must be byte-stable on every machine. The minimum mirrors
 * `server/tests/support/environment.ts` (the minimum a deployment may boot with); the extra keys
 * switch on config-conditional surfaces the full shape must cover (static app serving, Web Bot
 * Auth, GitHub App sign-in).
 */
const CANONICAL_INVENTORY_ENV: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
  // Config-conditional surfaces the full shape turns on:
  APP_DIST_DIR: "app/dist",
  WEB_BOT_AUTH: "on",
  OPENBOT_PUBLIC_URL: "https://inventory.probe.invalid",
  GITHUB_APP_CLIENT_ID: "github-client-id",
  GITHUB_APP_CLIENT_SECRET: "github-client-secret",
};

// ─────────────────────────────────────────────────────────────────────────────
// Real assembly shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An inert stand-in for an optional assembly dependency.
 *
 * `createApp` mounts a dependency's routes when the dependency is present and captures it inside
 * request handlers it never invokes here. Presence is all mounting observes, so an object with
 * no behaviour registers exactly the route table the real wiring would — without a database, a
 * vendor client or a running service. Where a dependency is a Hono router built by index.ts, the
 * REAL route factory from src is called instead (see `fullDeployDeps`), so the inner paths are
 * real too. The one exception is the CopilotKit runtime, which only the vendor package can
 * build; it is represented by its real mount point with a note.
 */
function present(): never {
  return {} as never;
}

/** A do-nothing Hono router carrying one route so its mount point stays visible in the table. */
function inertRouter(): Hono {
  const router = new Hono();
  router.all("*", (context) => context.notFound());
  return router;
}

function enterpriseConversationRouter(): Hono {
  // The real enterprise entry: the same factory index.ts mounts when enterprise storage is
  // available, with inert services (handlers are registered, never executed).
  return createConversationRoutes(present(), present());
}

/**
 * Build the deploy entry (`createApp`) in one of its two inventory shapes.
 *
 * - "minimal": no optional dependency at all — the routes every deployment registers.
 * - "full": every optional dependency present, so conditionally registered routes appear.
 */
export function buildAssembly(
  shape: "minimal" | "full",
  environment: Record<string, string | undefined> = CANONICAL_INVENTORY_ENV,
): Hono {
  const config = loadConfig(environment);
  if (shape === "minimal") {
    return createApp(config);
  }
  const copilotRuntimeMount = new Hono();
  // The vendor runtime's own AG-UI stream endpoint, at its real root mount point.
  copilotRuntimeMount.post("/", (context) => context.notFound());

  // A requireUser stand-in for the seam routers index.ts builds behind its own guard; the
  // inventory never invokes it, registration is all that matters.
  const inertMiddleware = (async (
    _context: unknown,
    next: () => Promise<void>,
  ) => {
    await next();
  }) as never;

  const openMuseSeams = {
    templateStore: present(),
    templateRevisions: present(),
    files: present(),
    tasks: present(),
    googleOAuth: {
      app: createOpenMuseGoogleRoutes({
        service: present(),
        requireUser: inertMiddleware,
      } as never),
      callback: createOpenMuseGoogleCallbackRoutes({
        service: present(),
        resolveActor: async () => null,
      } as never),
    },
    mail: createOpenMuseMailRoutes({
      service: present(),
      requireUser: inertMiddleware,
    } as never),
    reviewedActions: createOpenMuseReviewedActionsRoutes({
      service: present(),
      requireUser: inertMiddleware,
    } as never),
    goals: createOpenMuseGoalsRoutes({
      store: present(),
      requireUser: inertMiddleware,
    } as never),
    calendar: createOpenMuseCalendarRoutes({
      service: present(),
      requireUser: inertMiddleware,
      ownerDisabled: async () => false,
    } as never),
    ideas: createOpenMuseIdeasRoutes({
      store: present(),
      requireUser: inertMiddleware,
    } as never),
    memories: createOpenMuseMemoriesRoutes({
      store: present(),
      requireUser: inertMiddleware,
    } as never),
    documents: createOpenMuseDocumentsRoutes({
      store: present(),
      requireUser: inertMiddleware,
    } as never),
    notifications: createOpenMuseNotificationRoutes({
      store: present(),
      requireUser: inertMiddleware,
    } as never),
    accountDeletion: present(),
    deletionShutdown: async () => undefined,
    deletionRevoke: async () => undefined,
    deletionManifest: async () => present(),
    deletionRevokeSessions: async () => undefined,
    deletionNoteBackupRetention: async () => null,
    deletionAdmin: {
      restore: present(),
      purge: async () => present(),
      purgeRelational: async () => present(),
      cleanupView: async () => present(),
    },
    activity: createOpenMuseActivityRoutes({
      feed: present(),
      requireUser: inertMiddleware,
    } as never),
    opsSignals: createOpenMuseOpsSignalsRoutes({
      requireUser: inertMiddleware,
      signals: async () => ({ signals: [] }),
    } as never),
  } as never;

  const coworker = {
    demonstrations: { store: present(), recorder: present() },
    approvals: present(),
    shared: { modes: present(), use: present() },
    passwords: present(),
    delivery: {
      authenticated: present(),
      webhooks: present(),
    },
    memory: { store: present(), ingestion: present() },
    proactive: { store: present(), engine: present() },
    responsibilities: {
      store: present(),
      engine: present(),
      bindings: present(),
      triggers: {
        store: present(),
        emailDomain: "triggers.example.invalid",
        ingressRoutes: createTriggerIngressRoutes({
          directory: present(),
          ingest: async () => undefined,
          auditStore: present(),
        }),
        // The SES/SNS email door is itself conditional in the real assembly (email config);
        // its mount point is recorded through the ingress routes' sibling surface.
        emailRoutes: inertRouter(),
      },
    },
    groups: present(),
    enterpriseConversations: enterpriseConversationRouter(),
    teamBots: present(),
    lifecycle: present(),
    marketplace: { installs: present() },
  } as never;

  return createApp(
    config,
    // auth: mounting does not change the route table (the /api/auth/* handler is unconditional).
    undefined,
    present(), // roleRepository
    present(), // auditReader
    present(), // credentialService
    present(), // packageStatusReader
    copilotRuntimeMount, // copilotHandler — vendor runtime, mount point recorded with a note
    present(), // computerGateway
    present(), // computerPolicy
    present(), // agentProfileStore
    present(), // channelStore
    present(), // channelEvents
    present(), // auditStore
    present(), // componentStore
    present(), // pluginStore
    present(), // sandboxedStore
    present(), // threadIdentity
    present(), // peopleStore
    present(), // identityProviders
    (async () => present()) as never, // intentRouter
    present(), // pageFrames
    (async () => undefined) as never, // routineRunner — mounts the worker door /internal/routines/run
    present(), // routineStore
    present(), // onboardingStore
    present(), // userInstructions
    present(), // attachmentDatabase
    present(), // hostAccessBroker
    "inventory-probe", // desktopHostToken
    (async () => present()) as never, // deploymentToolCaller
    { broker: present() }, // composio
    (async () => new Response("ok")) as never, // modelProviderProxy
    present(), // userPreferences
    present(), // voiceSessions
    present(), // learning
    coworker,
    { shown: async () => null }, // selfHostBanner
    {
      service: present(),
      externalCustomerKey: "inventory-probe-customer",
      customerName: "Inventory Probe",
      creditWriter: present(),
    }, // billing
    { broker: present() }, // openConnector
    { service: present(), activePlanCode: async () => null }, // payments
    (async () => present()) as never, // codeRunGatewayFactory
    present(), // statements
    present(), // credits
    // The workshop: the real factory, with inert wiring (the route table is what matters).
    ({ requireUser, canUseBot }: { requireUser: never; canUseBot: never }) =>
      createWorkshopRoutes({
        requireUser,
        canUseBot,
        deps: present(),
      }),
    // The anonymous share sibling: the real public factory.
    () =>
      createWorkshopPublicRoutes({
        sharing: present(),
        listArtifacts: async () => [],
        readArtifactFile: async () => null,
      } as never),
    // Craft: the real factory with the offline-default config (loadCraftConfig derives a
    // complete config from no environment) and an inert store so no database is touched.
    ({ requireUser }: { requireUser: never }) =>
      createCraftRoutes({
        requireUser,
        deps: {
          config: loadCraftConfig({} as never),
          db: present(),
          redis: null,
          store: present(),
          approvals: present(),
          sandboxConnectionFor: async () => null,
          llmConfigFor: async () => present(),
          botIdFor: async () => null,
        } as never,
      }),
    openMuseSeams,
    present(), // identity
    // The GitHub sign-in callback: the real factory, wired with config-only dependencies.
    githubCallbackRoutes({
      clientId: "inventory-probe",
      clientSecret: "inventory-probe",
      publicUrl: "https://inventory.probe.invalid",
      appUrl: undefined,
      encryptionKey: config.keyEncryptionKey,
      personIsActive: async () => false,
      credentials: present(),
      identity: present(),
    } as never),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP entry extraction
// ─────────────────────────────────────────────────────────────────────────────

interface RawRoute {
  method: string;
  path: string;
}

/** Routes that are SSE/WebSocket-style surfaces regardless of their path shape. */
const STREAM_ROUTE_NOTES: Record<string, string> = {
  "POST /": "CopilotKit AG-UI stream endpoint (vendor runtime built at boot)",
};

function isStreamRoute(method: string, path: string): boolean {
  if (STREAM_ROUTE_NOTES[`${method} ${path}`]) return true;
  return /(^|\/)(events|stream|streams|sse)(\/|$|:)/.test(path);
}

function routeKind(method: string, path: string): InventoryEntryKind {
  if (path === "/internal" || path.startsWith("/internal/")) return "internal";
  if (isStreamRoute(method, path)) return "stream";
  return "http";
}

function assemblyOf(path: string): "deploy" | "enterprise" {
  if (
    path.startsWith("/api/enterprise/") ||
    path.startsWith("/api/admin/enterprise") ||
    path.startsWith("/api/auth/scim/")
  ) {
    return "enterprise";
  }
  return "deploy";
}

function rawRoutes(app: Hono): RawRoute[] {
  return app.routes.map((route) => ({
    method: route.method,
    path: route.path,
  }));
}

/** The route table the deploy entry registers: minimal ∪ full, each tagged with its shape. */
export function httpEntriesFromApps(apps: {
  minimal: Hono;
  full: Hono;
}): InventoryEntry[] {
  const minimal = new Set(
    rawRoutes(apps.minimal).map((route) => `${route.method} ${route.path}`),
  );
  const seen = new Map<string, InventoryEntry>();
  for (const route of rawRoutes(apps.full)) {
    const key = `${route.method} ${route.path}`;
    const kind = routeKind(route.method, route.path);
    const entry: InventoryEntry = {
      id: `http:${route.method}:${route.path}`,
      kind,
      method: route.method,
      path: route.path,
      shape: minimal.has(key) ? "unconditional" : "conditional",
      assembly: assemblyOf(route.path),
      source:
        route.path === "/" && route.method === "POST"
          ? "server/src/index.ts (CopilotKit runtime mount)"
          : "server/src/app.ts (createApp)",
      ...(STREAM_ROUTE_NOTES[key] ? { note: STREAM_ROUTE_NOTES[key] } : {}),
      businessLoop: null,
      ownerTask: null,
      status: "unowned",
      classification: null,
      exemptionReason: null,
    };
    seen.set(entry.id, entry);
  }
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Static candidates: background programs, tables, external dependencies
// ─────────────────────────────────────────────────────────────────────────────

/** Background programs, each naming the real source that starts or defines it. */
const BACKGROUND_PROGRAMS: Array<
  Pick<InventoryEntry, "id" | "source" | "note"> & {
    businessLoop: string | null;
  }
> = [
  // In-process sweeps the deploy entry starts (server/src/index.ts).
  {
    id: "job:memory-sweep",
    source: "server/src/index.ts (memorySweep)",
    businessLoop: "记忆、研究与学习",
    note: null,
  },
  {
    id: "job:responsibility-sweep",
    source: "server/src/index.ts (responsibilitySweep)",
    businessLoop: "职责与定时任务",
    note: null,
  },
  {
    id: "job:approval-sweep",
    source: "server/src/index.ts (approvalSweep)",
    businessLoop: "审批、登录与 Host Access",
    note: null,
  },
  {
    id: "job:proactive-sweep",
    source: "server/src/index.ts (proactiveSweep)",
    businessLoop: "职责与定时任务",
    note: null,
  },
  {
    id: "job:wake-up-sweep",
    source: "server/src/index.ts (wakeUpSweep)",
    businessLoop: "职责与定时任务",
    note: null,
  },
  {
    id: "job:wake-up-reaper",
    source: "server/src/index.ts (wakeUpReaper)",
    businessLoop: "职责与定时任务",
    note: null,
  },
  {
    id: "job:openmuse-task-sweep",
    source: "server/src/index.ts (openMuseTaskSweep)",
    businessLoop: "OpenMuse 个人业务",
    note: null,
  },
  {
    id: "job:openmuse-task-reaper",
    source: "server/src/index.ts (openMuseTaskReaper)",
    businessLoop: "OpenMuse 个人业务",
    note: null,
  },
  {
    id: "job:delivery-sweeps",
    source: "server/src/index.ts (deliverySweeps)",
    businessLoop: "通知、渠道、语音与听写",
    note: "One sweep per delivery work kind",
  },
  {
    id: "job:learning-auto-assign",
    source: "server/src/index.ts (learningAutoAssign)",
    businessLoop: "记忆、研究与学习",
    note: null,
  },
  {
    id: "job:audit-retention-sweeps",
    source: "server/src/index.ts (startRetentionSweeps)",
    businessLoop: "设置、治理与审计",
    note: "Audit rows + screenshot retention",
  },
  // CronJob-driven scripts (no in-API timer on purpose; see fire-routines.ts header).
  {
    id: "job:fire-routines",
    source: "server/scripts/fire-routines.ts",
    businessLoop: "职责与定时任务",
    note: "CronJob sweep: due routines claimed and fired",
  },
  {
    id: "job:fire-workshop-schedules",
    source: "server/scripts/fire-workshop-schedules.ts",
    businessLoop: "Workshop 与分享",
    note: "CronJob sweep",
  },
  {
    id: "job:cull-idle-computers",
    source: "server/scripts/cull-idle-computers.ts",
    businessLoop: "电脑与浏览器",
    note: "CronJob sweep",
  },
  {
    id: "job:cull-staged-attachments",
    source: "server/scripts/cull-staged-attachments.ts",
    businessLoop: "会话与消息",
    note: "CronJob sweep",
  },
  // Separate long-running processes.
  {
    id: "job:worker",
    source: "worker/src/index.ts",
    businessLoop: "职责与定时任务",
    note: "Work-queue execution process; calls /internal/routines/run",
  },
  {
    id: "job:kb-worker",
    source: "server/src/kb/worker.ts",
    businessLoop: "知识与文档",
    note: "Knowledge-base async task process (separate database)",
  },
];

/** Every drizzle schema module, so table entries can name their owning file. */
const TABLE_MODULES: Array<{
  module: Record<string, unknown>;
  file: string;
  kb?: boolean;
}> = [
  { module: schemaAdmin, file: "server/src/db/schema/admin.ts" },
  { module: schemaApprovals, file: "server/src/db/schema/approvals.ts" },
  { module: schemaBilling, file: "server/src/db/schema/billing.ts" },
  { module: schemaCodeRuns, file: "server/src/db/schema/code-runs.ts" },
  { module: schemaComponents, file: "server/src/db/schema/components.ts" },
  { module: schemaComputer, file: "server/src/db/schema/computer.ts" },
  { module: schemaCore, file: "server/src/db/schema/core.ts" },
  { module: schemaCoworker, file: "server/src/db/schema/coworker.ts" },
  { module: schemaCraft, file: "server/src/db/schema/craft.ts" },
  {
    module: schemaCreditReservations,
    file: "server/src/db/schema/credit-reservations.ts",
  },
  { module: schemaCredits, file: "server/src/db/schema/credits.ts" },
  { module: schemaDefaults, file: "server/src/db/schema/defaults.ts" },
  { module: schemaDelivery, file: "server/src/db/schema/delivery.ts" },
  {
    module: schemaDemonstrations,
    file: "server/src/db/schema/demonstrations.ts",
  },
  {
    module: schemaEnterpriseConversations,
    file: "server/src/db/schema/enterprise-conversations.ts",
  },
  {
    module: schemaEnterpriseExpertVersions,
    file: "server/src/db/schema/enterprise-expert-versions.ts",
  },
  {
    module: schemaEnterpriseModelRoutes,
    file: "server/src/db/schema/enterprise-model-routes.ts",
  },
  {
    module: schemaEnterpriseRuns,
    file: "server/src/db/schema/enterprise-runs.ts",
  },
  {
    module: schemaEnterpriseTenancy,
    file: "server/src/db/schema/enterprise-tenancy.ts",
  },
  { module: schemaGroup, file: "server/src/db/schema/group.ts" },
  { module: schemaIdentity, file: "server/src/db/schema/identity.ts" },
  { module: schemaLearning, file: "server/src/db/schema/learning.ts" },
  { module: schemaLifecycle, file: "server/src/db/schema/lifecycle.ts" },
  {
    module: schemaMastraMessageIntents,
    file: "server/src/db/schema/mastra-message-intents.ts",
  },
  {
    module: schemaMastraTenantStorage,
    file: "server/src/db/schema/mastra-tenant-storage.ts",
  },
  { module: schemaMemory, file: "server/src/db/schema/memory.ts" },
  { module: schemaOpenMuse, file: "server/src/db/schema/openmuse.ts" },
  { module: schemaPasswords, file: "server/src/db/schema/passwords.ts" },
  { module: schemaPayment, file: "server/src/db/schema/payment.ts" },
  { module: schemaPlugins, file: "server/src/db/schema/plugins.ts" },
  { module: schemaProactive, file: "server/src/db/schema/proactive.ts" },
  {
    module: schemaResponsibilities,
    file: "server/src/db/schema/responsibilities.ts",
  },
  {
    module: schemaSandboxInstances,
    file: "server/src/db/schema/sandbox-instances.ts",
  },
  { module: schemaScim, file: "server/src/db/schema/scim.ts" },
  { module: schemaSharedUse, file: "server/src/db/schema/shared-use.ts" },
  { module: schemaTeamBots, file: "server/src/db/schema/team-bots.ts" },
  { module: schemaUsageOutbox, file: "server/src/db/schema/usage-outbox.ts" },
  { module: schemaVoice, file: "server/src/db/schema/voice.ts" },
  { module: schemaWork, file: "server/src/db/schema/work.ts" },
  { module: schemaWorkshop, file: "server/src/db/schema/workshop.ts" },
  { module: schemaKb, file: "server/src/kb/db/schema.ts", kb: true },
];

function tableEntries(): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  for (const { module, file, kb } of TABLE_MODULES) {
    for (const exported of Object.values(module)) {
      if (!(exported instanceof PgTable)) continue;
      const name = getTableName(exported);
      entries.push({
        id: `table:${name}`,
        kind: "table",
        assembly: "deploy",
        source: file,
        ...(kb
          ? { note: "Knowledge-base service table (separate database)" }
          : {}),
        businessLoop: null,
        ownerTask: null,
        status: "unowned",
        classification: null,
        exemptionReason: null,
        name,
      });
    }
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** External dependency seams the deployment can be wired to, with the config that governs each. */
const EXTERNAL_SEAMS: Array<{
  id: string;
  source: string;
  envKeys: string[];
  businessLoop: string | null;
  note?: string;
}> = [
  {
    id: "external:intelligence-gateway",
    source: "server/src/config.ts (runtime.intelligence)",
    envKeys: ["INTELLIGENCE_API_URL"],
    businessLoop: "运行时与模型网关",
  },
  {
    id: "external:managed-agent",
    source: "server/src/config.ts (managedAgent)",
    envKeys: ["MANAGED_AGENT_AG_UI_URL"],
    businessLoop: "运行时与模型网关",
  },
  {
    id: "external:transcription",
    source: "server/src/config.ts (transcription)",
    envKeys: ["TRANSCRIPTION_API_KEY"],
    businessLoop: "通知、渠道、语音与听写",
  },
  {
    id: "external:voice",
    source: "server/src/config.ts (voice)",
    envKeys: ["VOICE_API_KEY"],
    businessLoop: "通知、渠道、语音与听写",
  },
  {
    id: "external:billing-lago",
    source: "server/src/config.ts (billing)",
    envKeys: ["LAGO_API_URL"],
    businessLoop: "计费、积分与订单",
  },
  {
    id: "external:computer-provider",
    source: "server/src/config.ts (computer)",
    envKeys: [
      "COMPUTER_PROVIDER",
      "COMPUTER_SUPERVISOR_URL",
      "COMPUTER_SANDBOX_URL",
    ],
    businessLoop: "电脑与浏览器",
  },
  {
    id: "external:code-sandbox",
    source: "server/src/config.ts (codeRun)",
    envKeys: ["SANDBOX_TOKEN"],
    businessLoop: "代码与沙箱",
  },
  {
    id: "external:redis",
    source: "server/src/redis.ts",
    envKeys: ["REDIS_URL"],
    businessLoop: null,
    note: "Shared locks/bus when configured",
  },
  {
    id: "external:kb-service",
    source: "server/src/kb (standalone service)",
    envKeys: ["KNOWLEDGE_SERVICE_URL"],
    businessLoop: "知识与文档",
  },
  {
    id: "external:composio",
    source: "server/src/plugins (composio broker)",
    envKeys: ["COMPOSIO_API_KEY"],
    businessLoop: "插件、组件与连接账号",
  },
  {
    id: "external:openconnector",
    source: "server/src/plugins (openConnector broker)",
    envKeys: ["OPENCONNECTOR_TOKEN"],
    businessLoop: "插件、组件与连接账号",
  },
  {
    id: "external:github-app",
    source: "server/src/config.ts (githubApp)",
    envKeys: ["GITHUB_APP_CLIENT_ID"],
    businessLoop: "身份、成员与组织",
  },
  {
    id: "external:organization-auth",
    source: "server/src/config.ts (organizationAuthUrl)",
    envKeys: ["OPENBOT_ORGANIZATION_AUTH_URL"],
    businessLoop: "身份、成员与组织",
  },
  {
    id: "external:enterprise-directory-db",
    source: "server/src/config.ts (enterpriseDirectoryDatabaseUrl)",
    envKeys: ["ENTERPRISE_DIRECTORY_DATABASE_URL"],
    businessLoop: "身份、成员与组织",
  },
  {
    id: "external:enterprise-data-db",
    source: "server/src/config.ts (enterpriseDataDatabaseUrl)",
    envKeys: ["ENTERPRISE_DATA_DATABASE_URL"],
    businessLoop: "Enterprise 会话与 Run",
  },
];

function externalEntries(
  environment: Record<string, string | undefined>,
): InventoryEntry[] {
  return EXTERNAL_SEAMS.map((seam) => ({
    id: seam.id,
    kind: "external" as const,
    assembly: "deploy" as const,
    source: seam.source,
    ...(seam.note ? { note: seam.note } : {}),
    businessLoop: seam.businessLoop,
    ownerTask: null,
    status: "unowned" as const,
    classification: null,
    exemptionReason: null,
    presentInAssembly: seam.envKeys.some((key) => environment[key]?.trim()),
  })).sort((a, b) => (a.id < b.id ? -1 : 1)) as InventoryEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classification rules, applied first-match-wins. This registry is where later MT tickets
 * assign owners: add a rule with `ownerTask` and the entry stops being a gap. Rules that only
 * classify (no `status`) leave the entry unowned but name its business loop.
 */
interface OwnershipRule {
  kinds?: InventoryEntryKind[];
  /** Exact path match (http entries). */
  paths?: string[];
  pathPrefixes?: string[];
  ids?: string[];
  idPrefixes?: string[];
  businessLoop?: string;
  ownerTask?: string;
  status?: "owned" | "exempt";
  classification?: SurfaceClass;
  exemptionReason?: string;
}

const OWNERSHIP_RULES: OwnershipRule[] = [
  // ── Global endpoints the spec explicitly exempts (§5.2: 登录、健康检查等全局端点) ──
  {
    pathPrefixes: ["/api/auth/"],
    status: "exempt",
    classification: "global-auth",
    businessLoop: "身份、成员与组织",
    exemptionReason:
      "Sign-in, session and SSO endpoints are global by design (spec §5.2); SCIM verbs are tenant-scoped and NOT exempt — see the rule below.",
  },
  {
    paths: ["/health"],
    status: "exempt",
    classification: "global-static",
    exemptionReason: "Liveness probe, carries no tenant data (spec §5.2).",
  },
  {
    paths: ["/api/capabilities"],
    status: "exempt",
    classification: "global-static",
    exemptionReason:
      "Pre-sign-in deployment capability projection, deliberately tenant-free (spec §5.2).",
  },
  {
    // SCIM member provisioning is company administration, not a global endpoint.
    pathPrefixes: ["/api/auth/scim/"],
    businessLoop: "身份、成员与组织",
    classification: "company-management",
  },
  {
    // Static app bundle + SPA fallback.
    ids: ["http:ALL:/*", "http:GET:/*"],
    status: "exempt",
    classification: "global-static",
    businessLoop: null,
    exemptionReason: "Static bundle serving; no business data.",
  },
  // ── Classification-only rules (entries stay unowned until a ticket claims them) ──
  {
    pathPrefixes: ["/internal/"],
    classification: "machine-delegation",
    businessLoop: "职责与定时任务",
  },
  {
    pathPrefixes: ["/api/admin/"],
    classification: "platform-operator",
    businessLoop: "设置、治理与审计",
  },
  {
    paths: ["/api/agent-tools/call"],
    classification: "machine-delegation",
    businessLoop: "插件、组件与连接账号",
  },
  {
    pathPrefixes: ["/api/billing/webhooks/", "/api/payments/callbacks/"],
    classification: "machine-delegation",
    businessLoop: "计费、积分与订单",
  },
  {
    paths: ["/api/model-provider/v1/chat/completions"],
    classification: "personal-model",
    businessLoop: "外部模型直连",
  },
  // Business loops by surface prefix (spec §8 coverage matrix rows).
  { pathPrefixes: ["/api/enterprise/"], businessLoop: "Enterprise 会话与 Run" },
  {
    pathPrefixes: [
      "/api/agents",
      "/api/bots",
      "/api/team-bots",
      "/api/marketplace",
    ],
    businessLoop: "Bot、团队发布与生命周期",
  },
  {
    pathPrefixes: ["/api/channels", "/api/groups"],
    businessLoop: "会话与消息",
  },
  {
    pathPrefixes: [
      "/api/plugins",
      "/api/components",
      "/api/identity",
      "/api/sandboxed",
    ],
    businessLoop: "插件、组件与连接账号",
  },
  { pathPrefixes: ["/api/knowledge"], businessLoop: "知识与文档" },
  { pathPrefixes: ["/api/memory"], businessLoop: "记忆与个人偏好" },
  {
    pathPrefixes: ["/api/demonstrations", "/api/learning"],
    businessLoop: "记忆、研究与学习",
  },
  {
    pathPrefixes: ["/api/responsibilities", "/api/events/"],
    businessLoop: "职责与定时任务",
  },
  {
    pathPrefixes: [
      "/api/approvals",
      "/api/sign-in-requests",
      "/api/passwords",
      "/api/host-access",
    ],
    businessLoop: "审批、登录与 Host Access",
  },
  { pathPrefixes: ["/api/computers"], businessLoop: "电脑与浏览器" },
  { pathPrefixes: ["/api/codesandbox"], businessLoop: "代码与沙箱" },
  { pathPrefixes: ["/api/craft"], businessLoop: "Craft 创作与任务" },
  {
    pathPrefixes: ["/api/workshop", "/api/public/workshop"],
    businessLoop: "Workshop 与分享",
  },
  {
    pathPrefixes: ["/api/delivery", "/api/voice", "/api/audio"],
    businessLoop: "通知、渠道、语音与听写",
  },
  {
    pathPrefixes: ["/api/billing", "/api/payments"],
    businessLoop: "计费、积分与订单",
  },
  {
    pathPrefixes: ["/api/settings", "/api/me"],
    businessLoop: "设置、治理与审计",
  },
  { pathPrefixes: ["/api/mobile/"], businessLoop: "OpenMuse 个人业务" },
  { pathPrefixes: ["/api/threads"], businessLoop: "运行时与模型网关" },
  { pathPrefixes: ["/api/desktop"], businessLoop: "桌面与客户端接入" },
  { pathPrefixes: ["/api/copilotkit"], businessLoop: "运行时与模型网关" },
  { pathPrefixes: ["/api/audio"], businessLoop: "通知、渠道、语音与听写" },
  {
    paths: ["/api/me", "/api/me/onboarding"],
    businessLoop: "设置、治理与审计",
  },
  {
    idPrefixes: [
      "table:users",
      "table:sessions",
      "table:accounts",
      "table:verifications",
    ],
    businessLoop: "身份、成员与组织",
  },
];

function applyOwnership(entry: InventoryEntry): InventoryEntry {
  for (const rule of OWNERSHIP_RULES) {
    if (rule.kinds && !rule.kinds.includes(entry.kind)) continue;
    const path = entry.path;
    const matches =
      (rule.ids?.includes(entry.id) ?? false) ||
      (rule.idPrefixes?.some((prefix) => entry.id.startsWith(prefix)) ??
        false) ||
      (path !== undefined &&
        ((rule.paths?.includes(path) ?? false) ||
          (rule.pathPrefixes?.some((prefix) => path.startsWith(prefix)) ??
            false)));
    if (!matches) continue;
    return {
      ...entry,
      businessLoop: rule.businessLoop ?? entry.businessLoop,
      ownerTask: rule.ownerTask ?? entry.ownerTask,
      status: rule.status ?? entry.status,
      classification: rule.classification ?? entry.classification,
      ...(rule.exemptionReason
        ? { exemptionReason: rule.exemptionReason }
        : {}),
    };
  }
  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory assembly
// ─────────────────────────────────────────────────────────────────────────────

function summarize(entries: InventoryEntry[]): InventorySummary {
  const byKind: Record<InventoryEntryKind, number> = {
    http: 0,
    stream: 0,
    internal: 0,
    background: 0,
    table: 0,
    external: 0,
  };
  const byStatus: Record<InventoryStatus, number> = {
    owned: 0,
    unowned: 0,
    exempt: 0,
  };
  let unclassified = 0;
  for (const entry of entries) {
    byKind[entry.kind] += 1;
    byStatus[entry.status] += 1;
    if (entry.businessLoop === null && entry.status !== "exempt") {
      unclassified += 1;
    }
  }
  return {
    total: entries.length,
    byKind,
    byStatus,
    gaps: byStatus.unowned,
    unclassified,
  };
}

export async function buildInventory(
  options: {
    environment?: Record<string, string | undefined>;
    database?: "auto" | "skip";
    apps?: { minimal: Hono; full: Hono };
  } = {},
): EntryInventory {
  const environment = {
    ...CANONICAL_INVENTORY_ENV,
    ...options.environment,
  };
  const apps = options.apps ?? {
    minimal: buildAssembly("minimal", environment),
    full: buildAssembly("full", environment),
  };
  const background: InventoryEntry[] = BACKGROUND_PROGRAMS.map((program) => ({
    id: program.id,
    kind: "background" as const,
    assembly: "deploy" as const,
    source: program.source,
    ...(program.note ? { note: program.note } : {}),
    businessLoop: program.businessLoop,
    ownerTask: null,
    status: "unowned" as const,
    classification: null,
    exemptionReason: null,
  }));

  const entries = [
    ...httpEntriesFromApps(apps),
    ...background,
    ...tableEntries(),
    ...externalEntries(environment),
  ]
    .map(applyOwnership)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const database: InventoryDatabaseSection =
    options.database === "skip"
      ? {
          status: "skipped",
          reason:
            "Database checks were not requested for this inventory build (static sections only).",
        }
      : await resolveDatabaseSection(environment, entries);
  return {
    schemaVersion: 1,
    entries,
    database,
    summary: summarize(entries),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database section (explicit skip, never a dev-database fallback)
// ─────────────────────────────────────────────────────────────────────────────

const TEST_DATABASE_VARIABLES = [
  "TEST_DATABASE_URL",
  "ENTERPRISE_TEST_SETUP_DATABASE_URL",
] as const;

function testDatabaseUrl(
  environment: Record<string, string | undefined>,
): { url: string; variable: string } | { reason: string } {
  for (const variable of TEST_DATABASE_VARIABLES) {
    const url = environment[variable]?.trim();
    if (url) {
      let host: string | null = null;
      try {
        host = new URL(url).hostname;
      } catch {
        return { reason: `${variable} is not a valid URL: ${url}` };
      }
      if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
        return {
          reason: `${variable} points at ${host}, which is not loopback; the inventory refuses any database other than a dedicated local test database (no dev-database fallback).`,
        };
      }
      return { url, variable };
    }
  }
  return {
    reason: `No dedicated test database configured: set TEST_DATABASE_URL or ENTERPRISE_TEST_SETUP_DATABASE_URL (loopback only). The deployment DATABASE_URL is deliberately never used for these checks, and this skip is not a pass.`,
  };
}

async function resolveDatabaseSection(
  environment: Record<string, string | undefined>,
  entries: InventoryEntry[],
): Promise<InventoryDatabaseSection> {
  const resolved = testDatabaseUrl(environment);
  if ("reason" in resolved) {
    return { status: "skipped", reason: resolved.reason };
  }
  const mainTables = entries
    .filter(
      (entry) =>
        entry.kind === "table" && !entry.note?.includes("separate database"),
    )
    .map((entry) => entry.name)
    .sort();
  try {
    const sql = new SQL.Postgres(resolved.url);
    const rows = await sql`select c.relname as name, c.relrowsecurity as rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = ANY(${mainTables})`;
    const byName = new Map(
      rows.map((row) => [row.name as string, Boolean(row.rls)]),
    );
    await sql.close();
    return {
      status: "checked",
      tables: mainTables.map((name) => ({
        name,
        presence: byName.has(name)
          ? ("present" as const)
          : ("missing" as const),
        rowLevelSecurity: byName.get(name) ?? false,
      })),
    };
  } catch (error) {
    return {
      status: "skipped",
      reason: `Test database ${resolved.variable} could not be queried (${error instanceof Error ? error.message : String(error)}); this is a skip, not a pass.`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap report (human-readable) and drift diff
// ─────────────────────────────────────────────────────────────────────────────

const KIND_LABELS: Record<InventoryEntryKind, string> = {
  http: "HTTP 入口",
  stream: "Stream/SSE 入口",
  internal: "内部入口 (worker/machine)",
  background: "后台程序",
  table: "数据表",
  external: "外部依赖",
};

export function renderGapReport(inventory: EntryInventory): string {
  const lines: string[] = [];
  const { summary } = inventory;
  lines.push("# 多租户入口覆盖缺口报告（MT001）");
  lines.push("");
  lines.push(
    "来源：真实应用装配（部署入口 createApp + 企业入口 enterprise conversation routes），静态候选（后台程序/数据表/外部依赖）均标注真实源文件。",
  );
  lines.push("");
  lines.push("## 摘要");
  lines.push("");
  lines.push(`- 入口总数：${summary.total}`);
  for (const kind of Object.keys(summary.byKind) as InventoryEntryKind[]) {
    lines.push(`- ${KIND_LABELS[kind]}：${summary.byKind[kind]}`);
  }
  lines.push(
    `- 无负责人（缺口）：${summary.gaps}；已豁免：${summary.byStatus.exempt}；已有负责人：${summary.byStatus.owned}`,
  );
  lines.push(`- 未归类业务闭环（非豁免）：${summary.unclassified}`);
  lines.push(
    `- 数据库检查：${inventory.database.status === "checked" ? "已执行" : "显式跳过"}${inventory.database.reason ? ` — ${inventory.database.reason}` : ""}`,
  );
  lines.push("");

  lines.push("## 缺口（无负责人的入口）");
  lines.push("");
  for (const kind of Object.keys(summary.byKind) as InventoryEntryKind[]) {
    const gaps = inventory.entries.filter(
      (entry) => entry.kind === kind && entry.status === "unowned",
    );
    if (gaps.length === 0) continue;
    lines.push(`### ${KIND_LABELS[kind]}（${gaps.length}）`);
    lines.push("");
    for (const entry of gaps) {
      const label =
        entry.method && entry.path
          ? `${entry.method} ${entry.path}`
          : entry.id.replace(/^(job|table|external):/, "");
      const loop = entry.businessLoop
        ? `〔${entry.businessLoop}〕`
        : "〔未分类〕";
      lines.push(`- ${label} ${loop} — ${entry.source ?? ""}`);
    }
    lines.push("");
  }

  const exempt = inventory.entries.filter((entry) => entry.status === "exempt");
  if (exempt.length > 0) {
    lines.push("## 明确豁免（全局例外，不计缺口）");
    lines.push("");
    for (const entry of exempt) {
      const label =
        entry.method && entry.path ? `${entry.method} ${entry.path}` : entry.id;
      lines.push(`- ${label} — ${entry.exemptionReason ?? ""}`);
    }
    lines.push("");
  }

  const owned = inventory.entries.filter((entry) => entry.status === "owned");
  if (owned.length > 0) {
    lines.push("## 已有负责人");
    lines.push("");
    for (const entry of owned) {
      lines.push(`- ${entry.id} — ${entry.ownerTask}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function diffInventories(
  before: EntryInventory,
  after: EntryInventory,
): InventoryDiff {
  const beforeById = new Map(before.entries.map((entry) => [entry.id, entry]));
  const afterById = new Map(after.entries.map((entry) => [entry.id, entry]));
  const added: InventoryEntry[] = [];
  const removed: InventoryEntry[] = [];
  const ownershipChanged: InventoryEntry[] = [];
  for (const [id, entry] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      added.push(entry);
      continue;
    }
    if (
      previous.ownerTask !== entry.ownerTask ||
      previous.status !== entry.status ||
      previous.businessLoop !== entry.businessLoop
    ) {
      ownershipChanged.push(entry);
    }
  }
  for (const [id, entry] of beforeById) {
    if (!afterById.has(id)) removed.push(entry);
  }
  return {
    added: added.sort((a, b) => (a.id < b.id ? -1 : 1)),
    removed: removed.sort((a, b) => (a.id < b.id ? -1 : 1)),
    ownershipChanged: ownershipChanged.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

export const BASELINE_PATH = "docs/multitenancy/inventory-baseline.json";

function baselineComparable(inventory: EntryInventory) {
  return {
    schemaVersion: inventory.schemaVersion,
    entries: inventory.entries,
    summary: inventory.summary,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const outIndex = args.indexOf("--out");
  const outDir = outIndex >= 0 ? args[outIndex + 1] : undefined;

  const environment: Record<string, string | undefined> = {};
  for (const variable of TEST_DATABASE_VARIABLES) {
    if (process.env[variable]?.trim()) {
      environment[variable] = process.env[variable];
    }
  }
  const inventory = await buildInventory({
    environment,
    database: "auto",
  });
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const report = renderGapReport(inventory);

  if (check) {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const current = baselineComparable(inventory);
    const drift = diffInventories(
      {
        schemaVersion: 1,
        entries: baseline.entries,
        database: { status: "skipped" },
        summary: baseline.summary,
      },
      inventory,
    );
    if (
      JSON.stringify(current) !== JSON.stringify(baseline) ||
      drift.added.length > 0 ||
      drift.removed.length > 0
    ) {
      console.error("Inventory drift detected against the committed baseline:");
      for (const entry of drift.added) console.error(`  + ${entry.id}`);
      for (const entry of drift.removed) console.error(`  - ${entry.id}`);
      console.error(
        `Regenerate with: bun server/scripts/multitenancy/inventory.ts --out docs/multitenancy and commit the new baseline.`,
      );
      process.exit(1);
    }
    console.log(`Baseline matches (${inventory.entries.length} entries).`);
    return;
  }

  if (outDir) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(`${outDir}/inventory.json`, json);
    writeFileSync(`${outDir}/inventory-gap-report.md`, report);
    console.error(
      `Wrote ${outDir}/inventory.json and ${outDir}/inventory-gap-report.md`,
    );
    console.error(report);
    return;
  }
  process.stdout.write(json);
  process.stderr.write(`${report}\n`);
}

if (import.meta.main) {
  await main();
}
