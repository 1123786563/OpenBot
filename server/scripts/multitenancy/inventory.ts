/**
 * MT001（Issue #44）：多租户覆盖入口清单生成器。
 *
 * 契约（稳定，后续闭环 Ticket 与验收 harness MT132 消费，勿私自改字段名）：
 *
 *   CoverageInventory = {
 *     schemaVersion: 1,
 *     generatedAt: string,            // ISO-8601；不参与 digest
 *     digest: string,                 // 除 generatedAt 外全量内容的 SHA-256
 *     assemblies:   Array<{ name, entrance, status, routeEntries, note? }>,
 *     entrances:    Array<{ id, entrance, method, path, kind, type,
 *                            businessClosure, ownerTicket, status,
 *                            registration, registeredIn, registrations }>,
 *     backgroundPrograms: Array<{ id, name, source, evidence,
 *                                  businessClosure, ownerTicket, status }>,
 *     serviceSurfaces: Array<{ id, name, evidence, businessClosure,
 *                              assemblyStatus, routeEnumeration,
 *                              ownerTicket, status, note }>,
 *     dataTables:   Array<{ id, table, schema, businessClosure,
 *                            ownerTicket, status }>,
 *     externalDependencies: Array<{ id, dependency, configKeys,
 *                                    businessClosure, ownerTicket, status }>,
 *     unmappedConfigKeys: string[],   // 配置面提取中未映射的外部依赖键
 *     stages:       Array<{ stage, status, reason?, requires?, result? }>,
 *     summary: { ... 见类型定义 ... },
 *   }
 *
 * - `entrance`：入口（"GET /api/agents"）；`type`：http | stream | internal；
 *   `businessClosure`：所属业务闭环（分类表驱动；未匹配 → "unclassified"，
 *   在缺口报告显式列出——未分类路由阻断统一上线）；`ownerTicket`：负责人
 *   任务（默认 null，通过 --ownership 输入）；`status`：owned | unowned。
 * - 入口清单来自真实应用装配而非手写常量：部署入口 createApp（src/app.ts，
 *   即 src/index.ts 的装配工厂）的 bare / full 两个变体，企业入口
 *   src/enterprise/conversations 的真实与降级（unavailable）装配线，以及
 *   kb 服务入口（src/kb/router）。动态与条件注册的路由由此自然进入清单
 *   （registration=conditional 表示仅出现在全量装配）。
 * - serve() 层的 WebSocket 升级入口（电脑流、Craft webapp HMR）不在 Hono
 *   路由表里，以静态提取 + 真实纯函数/源码校验登记；src/index.ts 中的
 *   server.upgrade( 分支数作为 tripwire 与已登记数比对。
 * - 后台程序 / 数据表 / 外部依赖为静态候选提取（Scope boundary），均带
 *   证据（文件:行）。数据表来自 drizzle schema 的真实导入。后台程序覆盖
 *   常驻 daemon 的实际形态：顶层 `void main()` 守护启动（worker 循环）、
 *   BullMQ `new Worker(`（kb worker）、`start*()`/`.start()`/`setInterval`
 *   （部署入口），以及文档声明的 CronJob 驱动脚本（scripts/fire-*、cull-*）。
 * - serviceSurfaces：已知部署但不在四个应用装配内的服务面（supervisor、
 *   go-runtime、agent-computer、agent-sandbox）。它们只被登记
 *   （assemblyStatus=unassembled、routeEnumeration=not_enumerated），
 *   绝不因其被列出而声称路由已覆盖；证据为源码/compose 行。
 * - 缺少测试数据库配置时命令仍可运行；需要数据库的阶段在 `stages` 里显式
 *   记录 skipped 与原因，绝不回退 DATABASE_URL，也不把 skipped 记为通过。
 *
 * 用法：
 *   bun server/scripts/multitenancy/inventory.ts [--pretty] \
 *        [--ownership ownership.json] [--out inventory.json] [--report gaps.md]
 *
 * 默认 JSON 打到 stdout，人类可读缺口报告打到 stderr；--out/--report 落盘。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SQL } from "bun";
import { getTableConfig } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { createApp } from "../../src/app";
import { streamPathBotId } from "../../src/computer/stream-path";
import { type DeploymentConfig, loadConfig } from "../../src/config";
import { createCraftRoutes } from "../../src/craft/routes";
import {
  createConversationRoutes,
  createUnavailableConversationRoutes,
} from "../../src/enterprise/conversations/routes";
import { classifyManagementPlane } from "../../src/enterprise/tenancy/admin-separation";
import { createWorkshopPublicRoutes } from "../../src/workshop/public-routes";
import { createWorkshopRoutes } from "../../src/workshop/routes";
import { testEnvironment } from "../../tests/support/environment";

export const SCHEMA_VERSION = 1;

const SERVER_ROOT = resolve(import.meta.dir, "../..");

// ---------------------------------------------------------------------------
// 契约类型
// ---------------------------------------------------------------------------

export type EntranceType = "http" | "stream" | "internal";
export type EntranceKind = "route" | "catchall" | "serve-upgrade";
export type CoverageStatus = "owned" | "unowned";
export type Registration = "always" | "conditional" | "serve-level";

export interface EntranceEntry {
  /** 稳定主键："METHOD path"。 */
  id: string;
  /** 入口，如 "GET /api/agents"。 */
  entrance: string;
  method: string;
  path: string;
  kind: EntranceKind;
  type: EntranceType;
  /** 所属业务闭环 id；无法分类时为 "unclassified"（缺口报告必须显式列出）。 */
  businessClosure: string;
  /** 负责人任务；null = 未归属（缺口）。 */
  ownerTicket: string | null;
  status: CoverageStatus;
  registration: Registration;
  registeredIn: string[];
  /** 同一 (method, path) 在同一装配里的注册次数（守卫链会造成多次注册）。 */
  registrations: number;
}

export interface BackgroundProgramEntry {
  id: string;
  name: string;
  source: string;
  evidence: string;
  businessClosure: string;
  ownerTicket: string | null;
  status: CoverageStatus;
}

/**
 * 已知部署但不在应用装配内的服务面（supervisor / go-runtime /
 * agent-computer / agent-sandbox 等）。unassembled + not_enumerated 是
 * 诚实语义：登记存在 ≠ 路由已覆盖；缺口报告必须显式呈现这一区别。
 */
export interface ServiceSurfaceEntry {
  id: string;
  name: string;
  /** 源码/compose 中的存在证据（文件:行: 内容）。 */
  evidence: string[];
  businessClosure: string;
  /** 该面是否已被本清单的真实装配枚举；已知四面均为 unassembled。 */
  assemblyStatus: "assembled" | "unassembled";
  /** not_enumerated = 只登记服务存在，绝不声称其 HTTP 路由已覆盖。 */
  routeEnumeration: "assembled" | "not_enumerated";
  ownerTicket: string | null;
  status: CoverageStatus;
  note: string;
}

export interface DataTableEntry {
  id: string;
  /** 物理表名（drizzle pgTable 的 name）。 */
  table: string;
  schema: string;
  businessClosure: string;
  ownerTicket: string | null;
  status: CoverageStatus;
}

export interface ExternalDependencyEntry {
  id: string;
  dependency: string;
  configKeys: string[];
  businessClosure: string;
  ownerTicket: string | null;
  status: CoverageStatus;
}

export interface StageRecord {
  stage: string;
  status: "ok" | "skipped" | "failed";
  reason?: string;
  requires?: string;
  result?: Record<string, unknown>;
}

export interface AssemblyInfo {
  name: string;
  /** 该装配对应的入口面（deployment / enterprise / kb-service）。 */
  entrance: string;
  status: "assembled" | "failed";
  routeEntries: number;
  note?: string;
}

export interface CoverageInventory {
  schemaVersion: number;
  generatedAt: string;
  digest: string;
  assemblies: AssemblyInfo[];
  entrances: EntranceEntry[];
  backgroundPrograms: BackgroundProgramEntry[];
  serviceSurfaces: ServiceSurfaceEntry[];
  dataTables: DataTableEntry[];
  externalDependencies: ExternalDependencyEntry[];
  unmappedConfigKeys: string[];
  stages: StageRecord[];
  summary: {
    totalEntrances: number;
    routeEntrances: number;
    catchallEntrances: number;
    unownedEntrances: number;
    unclassifiedEntrances: number;
    serveUpgradeBranches: number;
    serveUpgradeEntrances: number;
    dataTables: number;
    backgroundPrograms: number;
    serviceSurfaces: number;
    externalDependencies: number;
    byClosure: Record<string, { total: number; unowned: number }>;
    /** MT075（Issue #118）：管理面分类回写（同一分类函数在真实装配上计算）。 */
    managementPlanes: { platform: number; company: number };
  };
}

/** 归属输入：ticket -> 规则。匹配优先级：精确 entrance > 前缀 > 闭环/表/程序。 */
export interface OwnershipInput {
  [ticket: string]: {
    entrances?: string[];
    entrancePrefixes?: string[];
    closures?: string[];
    tablePrefixes?: string[];
    programs?: string[];
  };
}

export interface BuildOptions {
  now?: () => Date;
  /** 阶段解析用的环境（默认 process.env）；绝不读取 DATABASE_URL 兜底。 */
  environment?: Record<string, string | undefined>;
  ownership?: OwnershipInput;
  /** 只保留指定装配（模拟“删除一个入口来源后重跑”）。 */
  assemblies?: string[];
  /**
   * 装配后对真实 app 的变异钩子（drift 测试用：新增一个入口后重跑清单）。
   * 提供该钩子时装配缓存被绕过。
   */
  mutateApp?: (name: string, app: RouteApp) => void;
  /** 服务面 drift 测试用：对静态登记的服务面清单的变异钩子。 */
  mutateServiceSurfaces?: (surfaces: ServiceSurfaceEntry[]) => void;
}

// ---------------------------------------------------------------------------
// 真实装配
// ---------------------------------------------------------------------------

/** Hono 路由表的最小读取面。 */
export interface RouteApp {
  routes: Array<{ method: string; path: string }>;
}

/** 一个“处处在场”的替身：让条件装配成立，但不承载任何行为。 */
function presence(): never {
  const target = function stub() {} as unknown as object;
  return new Proxy(target, {
    get(_target, property) {
      if (property === Symbol.toPrimitive) return () => "presence";
      if (property === "then") return undefined;
      return presence();
    },
    apply() {
      return presence();
    },
  }) as unknown as never;
}

const P = presence;

/** 逐个可选面尝试装配：失败降级为缺席并留下可见 note，绝不静默。 */
async function attempt(
  label: string,
  build: () => unknown | Promise<unknown>,
): Promise<{ value?: unknown; note?: string }> {
  try {
    return { value: await build() };
  } catch (error) {
    return {
      note: `${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const noOpMiddleware = async (_context: unknown, next: () => Promise<void>) => {
  await next();
};

/** 部署入口的配置：最小可启动环境 + 全特性开关（覆盖配置条件路由）。 */
function deploymentConfigEnvironment(): Record<string, string | undefined> {
  return {
    ...testEnvironment(),
    OPENBOT_PUBLIC_URL: "https://inventory.openbot.test",
    WEB_BOT_AUTH: "on",
    APP_DIST_DIR: "/tmp/openbot-inventory-app-dist",
    GITHUB_APP_CLIENT_ID: "inventory-github-app",
    GITHUB_APP_CLIENT_SECRET: "inventory-github-secret",
  };
}

async function honoOrEmpty(
  label: string,
  build: () => unknown | Promise<unknown>,
  notes: string[],
): Promise<Hono> {
  const built = await attempt(label, build);
  if (built.value instanceof Hono) return built.value;
  if (built.note) notes.push(built.note);
  return new Hono();
}

/**
 * 组装 createApp 的全量位置参数（按 src/app.ts 的形参顺序，见
 * tests/shared-wiring.integration.test.ts 的同一约定）。所有会被
 * app.route() 挂载的参数都是真实 Hono（来自真实路由工厂）；其余依赖用
 * presence 替身让条件装配成立。
 */
async function deploymentFullArgs(
  config: DeploymentConfig,
  enterprise: "real" | "unavailable",
  notes: string[],
): Promise<unknown[]> {
  const args: unknown[] = new Array(createApp.length).fill(undefined);
  args[0] = config;
  args[1] = {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: {
          id: "inventory-actor",
          email: "inventory@openbot.test",
          name: "Inventory",
          image: null,
        },
      }),
    },
  };
  args[2] = { rolesForUser: async () => ["admin"] };
  for (let index = 3; index <= 33; index += 1) {
    args[index] = P();
  }
  // CopilotKit runtime（/api/copilotkit）：vendor 面，动态导入真实挂载。
  args[6] = await attempt("copilot-runtime", async () => {
    const { mountCopilotRuntime } = await import("../../src/copilot");
    const runtime = mountCopilotRuntime(config, P(), P(), P(), {});
    const handler = (runtime as { handler?: { routes?: unknown } }).handler;
    // vendor 自带的 hono 副本与服务器的不属同一实例，按结构判定。
    if (!handler || !Array.isArray(handler.routes)) {
      throw new Error("runtime handler has no route table");
    }
    return handler;
  }).then((built) => {
    if (built.note) notes.push(built.note);
    return built.value;
  });
  args[27] = "inventory-desktop-host-token";
  args[34] = await coworkerBag(enterprise, notes);
  args[35] = P();
  args[36] = {
    service: P(),
    externalCustomerKey: "inventory-deployment",
    customerName: "inventory-deployment",
    creditWriter: P(),
  };
  args[37] = { broker: P() };
  args[38] = { service: P(), activePlanCode: async () => null };
  args[39] = P();
  args[40] = P();
  args[41] = P();
  args[42] = ({
    requireUser,
    canUseBot,
  }: {
    requireUser: never;
    canUseBot: never;
  }) => {
    // 真实路由工厂（同步）；deps 用 presence 替身，仅完成路由注册。
    try {
      return createWorkshopRoutes({
        requireUser,
        canUseBot,
        deps: P(),
      });
    } catch (error) {
      notes.push(
        `workshop-routes: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Hono();
    }
  };
  args[43] = () => {
    try {
      return createWorkshopPublicRoutes({
        sharing: {
          resolveShareActor: P(),
          underRateLimit: P(),
          signArtifactUrl: P(),
        },
        listArtifacts: async () => [],
        readArtifactFile: async () => null,
      } as never);
    } catch (error) {
      notes.push(
        `workshop-public-routes: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Hono();
    }
  };
  args[44] = ({ requireUser }: { requireUser: never }) => {
    try {
      return createCraftRoutes({ requireUser, deps: P() });
    } catch (error) {
      notes.push(
        `craft-routes: ${error instanceof Error ? error.message : String(error)}`,
      );
      return new Hono();
    }
  };
  args[45] = await openMuseSeams(notes);
  args[46] = P();
  args[47] = await honoOrEmpty(
    "identity-github-callback",
    async () => {
      const { githubCallbackRoutes } = await import(
        "../../src/identity/github-callback"
      );
      return githubCallbackRoutes({
        clientId: "inventory-github-app",
        clientSecret: "inventory-github-secret",
        publicUrl: "https://inventory.openbot.test",
        appUrl: undefined,
        encryptionKey: config.keyEncryptionKey,
        personIsActive: async () => true,
        credentials: P(),
        identity: P(),
        auditStore: P(),
      } as never);
    },
    notes,
  );
  return args;
}

async function coworkerBag(
  enterprise: "real" | "unavailable",
  notes: string[],
): Promise<Record<string, unknown>> {
  const enterpriseConversations =
    enterprise === "real"
      ? await honoOrEmpty(
          "enterprise-conversations-real",
          () => createConversationRoutes(P(), P()),
          notes,
        )
      : await honoOrEmpty(
          "enterprise-conversations-unavailable",
          () => createUnavailableConversationRoutes(),
          notes,
        );
  const triggers = await attempt(
    "responsibilities-trigger-routes",
    async () => {
      const ingress = await import("../../src/responsibilities/trigger-routes");
      const email = await import("../../src/responsibilities/email");
      return {
        store: P(),
        emailDomain: "inventory.test",
        ingressRoutes: ingress.createTriggerIngressRoutes(P()),
        emailRoutes: email.createEmailTriggerRoutes({
          store: P(),
          resolveBinding: P(),
          ingest: P(),
          config: P(),
          verify: P(),
          confirmSubscription: P(),
        } as never),
      };
    },
  );
  const workspaceScope = await honoOrEmpty(
    "enterprise-workspace-scope",
    async () => {
      const { createWorkspaceScopeRoutes } = await import(
        "../../src/enterprise/tenancy/workspace-scope-routes"
      );
      // 真实路由工厂；清单装配没有会话源与管理通道——管理半边在清单里
      // 就是生产在 operator 通道未接线时的 503 形态，绝不伪造可用。
      return createWorkspaceScopeRoutes({
        authenticate: async () => null,
        lister: P() as never,
      });
    },
    notes,
  );
  if (triggers.note) notes.push(triggers.note);
  return {
    demonstrations: P(),
    approvals: P(),
    shared: P(),
    passwords: P(),
    delivery: P(),
    memory: P(),
    proactive: P(),
    responsibilities: {
      store: P(),
      engine: P(),
      bindings: P(),
      ...(triggers.value ? { triggers: triggers.value } : {}),
    },
    groups: P(),
    enterpriseConversations,
    ...(workspaceScope.routes.length
      ? { enterpriseWorkspaceScope: workspaceScope }
      : {}),
    teamBots: P(),
    lifecycle: P(),
    marketplace: P(),
  };
}

async function openMuseSeams(
  notes: string[],
): Promise<Record<string, unknown>> {
  const seam = (label: string, build: () => unknown | Promise<unknown>) =>
    honoOrEmpty(label, build, notes).then((router) =>
      router.routes.length ? router : undefined,
    );
  const connectors = async () => import("../../src/openmuse-connectors/routes");
  return {
    templateStore: P(),
    templateRevisions: P(),
    files: P(),
    tasks: P(),
    googleOAuth: {
      app: await seam("openmuse-google-app", async () =>
        (await connectors()).createOpenMuseGoogleRoutes({
          service: P(),
          requireUser: noOpMiddleware as never,
        } as never),
      ),
      callback: await seam("openmuse-google-callback", async () =>
        (await connectors()).createOpenMuseGoogleCallbackRoutes({
          service: P(),
          resolveActor: async () => ({ id: "inventory-actor" }),
        } as never),
      ),
    },
    mail: await seam("openmuse-mail", async () =>
      (await import("../../src/openmuse-mail/routes")).createOpenMuseMailRoutes(
        {
          service: P(),
          requireUser: noOpMiddleware as never,
          ownerDisabled: P(),
        } as never,
      ),
    ),
    reviewedActions: await seam("openmuse-reviewed-actions", async () =>
      (
        await import("../../src/openmuse-reviewed-actions/routes")
      ).createOpenMuseReviewedActionsRoutes(P()),
    ),
    goals: await seam("openmuse-goals", async () =>
      (
        await import("../../src/openmuse-personal/goals")
      ).createOpenMuseGoalsRoutes(P()),
    ),
    calendar: await seam("openmuse-calendar", async () =>
      (
        await import("../../src/openmuse-calendar/routes")
      ).createOpenMuseCalendarRoutes({
        service: P(),
        requireUser: noOpMiddleware as never,
        ownerDisabled: P(),
      } as never),
    ),
    ideas: await seam("openmuse-ideas", async () =>
      (
        await import("../../src/openmuse-personal/ideas")
      ).createOpenMuseIdeasRoutes(P()),
    ),
    memories: await seam("openmuse-memories", async () =>
      (
        await import("../../src/openmuse-personal/memories")
      ).createOpenMuseMemoriesRoutes(P()),
    ),
    documents: await seam("openmuse-documents", async () =>
      (
        await import("../../src/openmuse-documents/routes")
      ).createOpenMuseDocumentsRoutes(P()),
    ),
    notifications: await seam("openmuse-notifications", async () =>
      (
        await import("../../src/openmuse-notifications/routes")
      ).createOpenMuseNotificationRoutes(P()),
    ),
    accountDeletion: P(),
    deletionShutdown: P(),
    deletionRevoke: P(),
    deletionManifest: P(),
    deletionRevokeSessions: P(),
    deletionNoteBackupRetention: P(),
    deletionAdmin: P(),
    activity: await seam("openmuse-activity", async () =>
      (
        await import("../../src/openmuse-activity/routes")
      ).createOpenMuseActivityRoutes(P()),
    ),
    opsSignals: await seam("openmuse-ops", async () =>
      (
        await import("../../src/openmuse-ops/routes")
      ).createOpenMuseOpsSignalsRoutes(P()),
    ),
  };
}

export interface AssembledApp {
  name: string;
  entrance: string;
  app: RouteApp;
  notes: string[];
}

const ASSEMBLY_CACHE = new Map<string, RouteApp>();

async function cacheOrBuild(
  name: string,
  build: () => Promise<RouteApp>,
  bypass: boolean,
): Promise<RouteApp> {
  if (!bypass && ASSEMBLY_CACHE.has(name)) {
    return ASSEMBLY_CACHE.get(name) as RouteApp;
  }
  const app = await build();
  if (!bypass) ASSEMBLY_CACHE.set(name, app);
  return app;
}

/**
 * 真实装配四个入口面：
 *  - deployment-bare：createApp 最小装配（无条件路由基线）。
 *  - deployment-full：全量位置参数 + 特性配置（条件路由）+ 企业真实路由。
 *  - deployment-enterprise-unavailable：企业降级装配线（unavailable 路由）。
 *  - kb-service：kb 服务入口（src/kb/router 的 createApp + buildRoutes）。
 */
export async function assembleInventoryApps(
  mutate?: (name: string, app: RouteApp) => void,
): Promise<AssembledApp[]> {
  const bypass = mutate !== undefined;
  const result: AssembledApp[] = [];

  result.push({
    name: "deployment-bare",
    entrance: "deployment",
    notes: [],
    app: await cacheOrBuild(
      "deployment-bare",
      async () =>
        createApp(loadConfig(testEnvironment())) as unknown as RouteApp,
      bypass,
    ),
  });

  const fullNotes: string[] = [];
  result.push({
    name: "deployment-full",
    entrance: "deployment",
    notes: fullNotes,
    app: await cacheOrBuild(
      "deployment-full",
      () => buildFullDeployment("real", fullNotes),
      bypass,
    ),
  });

  const unavailableNotes: string[] = [];
  result.push({
    name: "deployment-enterprise-unavailable",
    entrance: "enterprise",
    notes: unavailableNotes,
    app: await cacheOrBuild(
      "deployment-enterprise-unavailable",
      () => buildFullDeployment("unavailable", unavailableNotes),
      bypass,
    ),
  });

  const kbNotes: string[] = [];
  result.push({
    name: "kb-service",
    entrance: "kb-service",
    notes: kbNotes,
    app: await cacheOrBuild(
      "kb-service",
      () => buildKbService(kbNotes),
      bypass,
    ),
  });

  for (const assembled of result) {
    mutate?.(assembled.name, assembled.app);
  }
  return result;
}

async function buildFullDeployment(
  enterprise: "real" | "unavailable",
  notes: string[],
): Promise<RouteApp> {
  const config = loadConfig(deploymentConfigEnvironment());
  const args = await deploymentFullArgs(config, enterprise, notes);
  return createApp(
    ...(args as unknown as Parameters<typeof createApp>),
  ) as unknown as RouteApp;
}

async function buildKbService(notes: string[]): Promise<RouteApp> {
  const built = await attempt("kb-service", async () => {
    const { createApp: createKbApp } = await import("../../src/kb/router/app");
    const { buildRoutes } = await import("../../src/kb/router/routes");
    const app = createKbApp();
    buildRoutes(app, P());
    return app as unknown as RouteApp;
  });
  if (built.value) return built.value as RouteApp;
  if (built.note) notes.push(built.note);
  return new Hono() as unknown as RouteApp;
}

// ---------------------------------------------------------------------------
// 路由提取
// ---------------------------------------------------------------------------

export interface RawRoute {
  method: string;
  path: string;
}

export function extractRouteEntrances(app: RouteApp): RawRoute[] {
  return app.routes.map((route) => ({
    method: route.method,
    path: route.path,
  }));
}

// ---------------------------------------------------------------------------
// 业务闭环分类（元数据表：清单来自装配，分类来自本表；未匹配 → unclassified）
// ---------------------------------------------------------------------------

const CLOSURE_BY_PREFIX: Array<[string, string]> = [
  ["/internal", "internal-worker"],
  ["/.well-known", "bot"],
  ["/api/copilotkit", "agent-runtime"],
  ["/api/enterprise/conversations", "conversation"],
  // MT075（Issue #118）：公司/团队管理面（MT006 workspace-scope）有了
  // 自己的闭环归属——管理面分类（platform/company）见
  // src/enterprise/tenancy/admin-separation.ts，随 summary.managementPlanes 回写。
  ["/api/enterprise/workspace-scope", "workspace-admin"],
  ["/api/admin/openmuse-deletion", "openmuse-deletion"],
  ["/api/admin/openmuse-template", "openmuse"],
  ["/api/admin/openmuse-ops", "openmuse"],
  ["/api/admin/billing", "billing"],
  ["/api/admin/learning", "agent-runtime"],
  ["/api/admin", "governance"],
  ["/api/auth", "identity"],
  ["/api/identity", "identity"],
  ["/api/sign-in-requests", "credentials"],
  ["/api/passwords", "credentials"],
  ["/api/me", "identity"],
  ["/api/settings", "identity"],
  ["/api/audio", "voice"],
  ["/api/voice", "voice"],
  ["/api/computers", "computer"],
  ["/api/demonstrations", "computer"],
  ["/api/codesandbox", "codesandbox"],
  ["/api/sandboxed", "plugins"],
  ["/api/public/workshop", "workshop"],
  ["/api/workshop", "workshop"],
  ["/api/craft", "craft"],
  ["/api/public/openmuse-google", "openmuse"],
  ["/api/mobile/openmuse", "openmuse"],
  ["/api/mobile", "conversation"],
  ["/api/host-access", "host-access"],
  ["/api/agents", "bot"],
  ["/api/marketplace", "bot"],
  ["/api/route", "bot"],
  ["/api/bots", "bot"],
  ["/api/team-bots", "bot"],
  ["/api/proactive", "bot"],
  ["/api/channels", "conversation"],
  ["/api/attachments", "conversation"],
  ["/api/groups", "conversation"],
  ["/api/threads", "conversation"],
  ["/api/routines", "responsibilities"],
  ["/api/responsibilities", "responsibilities"],
  ["/api/events", "responsibilities"],
  ["/api/delivery", "delivery"],
  ["/api/approvals", "approvals"],
  ["/api/plugins", "plugins"],
  ["/api/components", "plugins"],
  ["/api/agent-tools", "plugins"],
  ["/api/memory", "memory"],
  ["/api/knowledge", "knowledge"],
  ["/kb", "knowledge"],
  ["/api/billing", "billing"],
  ["/api/payments", "billing"],
  ["/api/model-provider", "agent-runtime"],
  ["/api/desktop", "platform"],
  ["/api/capabilities", "platform"],
  ["/health", "platform"],
  ["/ready", "platform"],
  ["/*", "platform"],
];

const CLOSURE_LABELS: Record<string, string> = {
  platform: "平台与静态面",
  identity: "身份与组织",
  "workspace-admin": "公司/团队管理",
  credentials: "凭据与密码库",
  governance: "治理与管理审计",
  bot: "Bot 与团队 Bot",
  conversation: "会话与频道",
  "agent-runtime": "Agent 运行时",
  computer: "电脑与实例",
  codesandbox: "代码沙箱",
  knowledge: "知识库",
  memory: "记忆",
  plugins: "插件与组件",
  approvals: "审批",
  responsibilities: "职责与定时任务",
  delivery: "投递通道",
  workshop: "Workshop",
  craft: "Craft",
  openmuse: "OpenMuse 业务",
  "openmuse-deletion": "删除恢复",
  billing: "计费与付款",
  "internal-worker": "内部 Worker 入口",
  "host-access": "主机访问",
  voice: "语音与听写",
  unclassified: "未分类（阻断统一上线）",
};

export function classifyPath(path: string): string {
  const normalized = path.replace(/\*+$/, "").replace(/\/+$/, "");
  if (normalized === "" || normalized === "/") return "platform";
  // 全局中间件注册形如 ALL /api/*：归 platform；真正的 /api/... 路由
  // 必须命中分类表，否则落入 unclassified（新面不被吞掉）。
  if (normalized === "/api") return "platform";
  for (const [prefix, closure] of CLOSURE_BY_PREFIX) {
    if (
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      normalized.startsWith(`${prefix}-`)
    ) {
      return closure;
    }
  }
  return "unclassified";
}

export function classifyStream(path: string): EntranceType {
  if (path.startsWith("/internal")) return "internal";
  if (/\/events$/.test(path)) return "stream";
  if (/\/stream$/.test(path)) return "stream";
  return "http";
}

// ---------------------------------------------------------------------------
// serve() 层 stream 入口（静态提取 + 真实纯函数/源码校验）
// ---------------------------------------------------------------------------

async function serveLevelEntrances(): Promise<{
  entrances: EntranceEntry[];
  upgradeBranches: number;
  verification: string[];
}> {
  const entrances: EntranceEntry[] = [];
  const verification: string[] = [];
  const indexPath = resolve(SERVER_ROOT, "src/index.ts");
  const indexSource = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : "";
  const upgradeBranches = (indexSource.match(/server\.upgrade\(/g) ?? [])
    .length;

  // 1) 电脑流代理：路径判定来自真实纯函数 streamPathBotId（探测验证）。
  const probeBotId = "inventory-probe-bot";
  const probed = streamPathBotId(`/api/computers/${probeBotId}/stream`);
  verification.push(
    `streamPathBotId("/api/computers/${probeBotId}/stream") === "${probed}"`,
  );
  entrances.push({
    id: "WS /api/computers/:botId/stream",
    entrance: "WS /api/computers/:botId/stream",
    method: "WS",
    path: "/api/computers/:botId/stream",
    kind: "serve-upgrade",
    type: "stream",
    businessClosure: classifyPath("/api/computers/x/stream"),
    ownerTicket: null,
    status: "unowned",
    registration: "serve-level",
    registeredIn: ["deployment-serve"],
    registrations: 1,
  });

  // 2) Craft webapp HMR：路径正则从真实模块源码提取。
  const webappPath = resolve(SERVER_ROOT, "src/craft/webapp-proxy.ts");
  const match = existsSync(webappPath)
    ? readFileSync(webappPath, "utf8").match(
        /WEBAPP_HMR_PATH\s*=\s*(\/.+?\/[a-z]*)/,
      )
    : undefined;
  const hmrPattern = match?.[1] ?? "(WEBAPP_HMR_PATH 未提取)";
  verification.push(
    match
      ? `WEBAPP_HMR_PATH = ${match[1]} (src/craft/webapp-proxy.ts)`
      : "src/craft/webapp-proxy.ts 中未找到 WEBAPP_HMR_PATH",
  );
  entrances.push({
    id: `WS ${hmrPattern}`,
    entrance: `WS ${hmrPattern}`,
    method: "WS",
    path: hmrPattern,
    kind: "serve-upgrade",
    type: "stream",
    businessClosure: "craft",
    ownerTicket: null,
    status: "unowned",
    registration: "serve-level",
    registeredIn: ["deployment-serve"],
    registrations: 1,
  });

  // 3) 通道活动 socket 是普通 Hono 路由（GET /api/channels/events，
  //    upgradeWebSocket），在 deployment-full 的路由表里自然出现。

  return { entrances, upgradeBranches, verification };
}

// ---------------------------------------------------------------------------
// 静态候选提取：后台程序 / 数据表 / 外部依赖
// ---------------------------------------------------------------------------

const BACKGROUND_SOURCES = [
  "src/index.ts",
  "src/kb/worker.ts",
  "../worker/src/index.ts",
  "scripts/fire-routines.ts",
  "scripts/fire-workshop-schedules.ts",
  "scripts/cull-idle-computers.ts",
  "scripts/cull-staged-attachments.ts",
];

const PROGRAM_CLOSURES: Array<[RegExp, string]> = [
  [/^startRetention|Retention/i, "governance"],
  [/^startUsageDelivery/i, "billing"],
  [/^startPayment/i, "billing"],
  [/learning/i, "agent-runtime"],
  [/handoff/i, "bot"],
  [/proactive/i, "bot"],
  [/wakeUp/i, "bot"],
  [/memory/i, "memory"],
  [/group/i, "conversation"],
  [/delivery/i, "delivery"],
  [/task/i, "openmuse"],
  [/routine/i, "responsibilities"],
  [/workshop/i, "workshop"],
  [/computer/i, "computer"],
  [/attachment/i, "conversation"],
  [/sweep|Sweep|setInterval/, "responsibilities"],
];

/** 已知常驻 worker 的源级归属（名字本身过泛，不足以分类）。 */
const PROGRAM_CLOSURES_BY_SOURCE: Array<[string, string]> = [
  ["../worker/src/index.ts", "responsibilities"],
  ["src/kb/worker.ts", "knowledge"],
];

function classifyProgram(name: string, source: string): string {
  for (const [file, closure] of PROGRAM_CLOSURES_BY_SOURCE) {
    if (source === file) return closure;
  }
  for (const [pattern, closure] of PROGRAM_CLOSURES) {
    if (pattern.test(name)) return closure;
  }
  return "unclassified";
}

export function extractBackgroundPrograms(): BackgroundProgramEntry[] {
  const entries = new Map<string, BackgroundProgramEntry>();
  for (const relative of BACKGROUND_SOURCES) {
    const path = resolve(SERVER_ROOT, relative);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    const stem = relative.split("/").pop()?.replace(/\.ts$/, "") ?? "program";
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // cron 声明在文档注释里（"Run from a CronJob …"）：先于注释守卫判定。
      const cronDoc = /\bRun from a CronJob\b/.test(trimmed);
      if (
        !cronDoc &&
        (trimmed.startsWith("import ") || trimmed.startsWith("*"))
      ) {
        return;
      }
      // 形态优先级：cron 文档声明 > 顶层 void 守护启动（worker 循环 daemon）
      // > 常驻 Worker 实例化（BullMQ）> start*() / .start() / setInterval()。
      const name = cronDoc
        ? stem
        : (trimmed.match(
            /^void\s+([a-zA-Z][A-Za-z0-9_]*)\s*\(\s*\)\s*;/,
          )?.[1] ??
          trimmed.match(
            /([a-zA-Z][A-Za-z0-9_]*)\s*=\s*new\s+Worker\s*\(/,
          )?.[1] ??
          trimmed.match(/\b(start[A-Z][A-Za-z0-9_]*)\s*\(/)?.[1] ??
          trimmed.match(/([a-zA-Z][A-Za-z0-9_]*)\.start\(\)/)?.[1] ??
          (/\bsetInterval\s*\(/.test(trimmed) ? "setInterval" : undefined));
      if (!name) return;
      const id = `${relative}#${name}`;
      if (entries.has(id)) return;
      entries.set(id, {
        id,
        name,
        source: relative,
        evidence: `${relative}:${index + 1}: ${trimmed.slice(0, 120)}`,
        businessClosure: classifyProgram(name, relative),
        ownerTicket: null,
        status: "unowned",
      });
    });
  }
  return [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

const TABLE_CLOSURES: Array<[string, string]> = [
  ["users", "identity"],
  ["session", "identity"],
  ["account", "identity"],
  ["verification", "identity"],
  ["identity", "identity"],
  ["sso", "identity"],
  ["scim", "identity"],
  ["onboarding", "identity"],
  ["audit", "governance"],
  ["admin", "governance"],
  ["agent", "bot"],
  ["bot", "bot"],
  ["marketplace", "bot"],
  ["proactive", "bot"],
  ["wake_up", "bot"],
  ["team_bot", "bot"],
  ["channel", "conversation"],
  ["message", "conversation"],
  ["thread", "conversation"],
  ["group", "conversation"],
  ["mastra", "conversation"],
  ["enterprise", "conversation"],
  ["knowledge", "knowledge"],
  ["kb_", "knowledge"],
  ["chunk", "knowledge"],
  ["document", "knowledge"],
  ["memory", "memory"],
  ["mcp", "plugins"],
  ["plugin", "plugins"],
  ["component", "plugins"],
  ["shared_use", "plugins"],
  ["approval", "approvals"],
  ["responsibility", "responsibilities"],
  ["routine", "responsibilities"],
  ["trigger", "responsibilities"],
  ["delivery", "delivery"],
  ["workshop", "workshop"],
  ["craft", "craft"],
  ["openmuse", "openmuse"],
  ["credit", "billing"],
  ["billing", "billing"],
  ["payment", "billing"],
  ["subscription", "billing"],
  ["usage", "billing"],
  ["computer", "computer"],
  ["page_frame", "computer"],
  ["demonstration", "computer"],
  ["sandbox", "codesandbox"],
  ["code_run", "codesandbox"],
  ["voice", "voice"],
  ["password", "credentials"],
  ["credential", "credentials"],
];

function classifyTable(table: string): string {
  for (const [prefix, closure] of TABLE_CLOSURES) {
    if (table.startsWith(prefix)) return closure;
  }
  return "unclassified";
}

export async function extractDataTables(): Promise<DataTableEntry[]> {
  const entries: DataTableEntry[] = [];
  const schemas: Array<{ schema: string; module: object }> = [];
  // 真实 schema 导入（drizzle 表定义，无连接副作用）。
  const server = await attempt(
    "drizzle-schema",
    () => import("../../src/db/schema"),
  );
  if (server.value) schemas.push({ schema: "server", module: server.value });
  const kb = await attempt(
    "kb-drizzle-schema",
    () => import("../../src/kb/db/schema"),
  );
  if (kb.value) schemas.push({ schema: "kb", module: kb.value });
  for (const { schema, module } of schemas) {
    for (const value of Object.values(module)) {
      let table: string | undefined;
      try {
        table = getTableConfig(value as never).name;
      } catch {
        table = undefined;
      }
      if (!table) continue;
      entries.push({
        id: `${schema}.${table}`,
        table,
        schema,
        businessClosure: classifyTable(table),
        ownerTicket: null,
        status: "unowned",
      });
    }
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
}

const CONFIG_SOURCES = [
  "src/config.ts",
  "src/redis.ts",
  "src/kb/config/index.ts",
];

const EXTERNAL_DEPS: Array<[string, string, string]> = [
  // env 前缀 → 依赖名 → 业务闭环
  ["DATABASE_URL", "PostgreSQL（主库）", "platform"],
  ["ENTERPRISE_DIRECTORY_DATABASE_URL", "PostgreSQL（企业目录库）", "identity"],
  ["ENTERPRISE_DATA_DATABASE_URL", "PostgreSQL（企业数据库）", "conversation"],
  [
    "TENANT_STORAGE_RUNTIME_DATABASE_URL",
    "PostgreSQL（租户运行时库）",
    "conversation",
  ],
  ["KB_DATABASE_URL", "PostgreSQL（KB 服务库）", "knowledge"],
  ["OPENBOT_REDIS_URL", "Redis（workshop 总线与锁）", "workshop"],
  ["WORKSHOP_REQUIRE_REDIS", "Redis（workshop 总线与锁）", "workshop"],
  ["KB_REDIS_URL", "Redis（KB BullMQ 队列）", "knowledge"],
  ["INTELLIGENCE_", "Intelligence 运行时", "agent-runtime"],
  ["COPILOTKIT_", "CopilotKit Runtime", "agent-runtime"],
  ["MANAGED_AGENT_", "受管 Agent（AG-UI）", "agent-runtime"],
  ["LAGO_", "Lago 计费", "billing"],
  ["ALIPAY_", "支付宝", "billing"],
  ["WXPAY_", "微信支付", "billing"],
  ["COMPOSIO_", "Composio 应用目录", "plugins"],
  ["OPENCONNECTOR_", "OpenConnector", "openmuse"],
  ["GITHUB_APP_", "GitHub App", "identity"],
  ["GOOGLE_OAUTH_", "Google OAuth", "identity"],
  ["AGENT_COMPUTER_", "agent-computer 服务", "computer"],
  ["COMPUTER_SANDBOX_", "代码沙箱", "codesandbox"],
  ["COMPUTER_", "computer 基础设施", "computer"],
  ["QDRANT_", "Qdrant 向量库", "knowledge"],
  ["KB_QDRANT_BATCH", "Qdrant 向量库", "knowledge"],
  ["OLLAMA_", "Ollama 嵌入", "knowledge"],
  ["DOCREADER_", "Docreader 文档解析服务", "knowledge"],
  ["KB_RERANK_URL", "Reranker 服务", "knowledge"],
  ["SMTP", "SMTP 邮件", "responsibilities"],
  ["SES_", "AWS SES", "responsibilities"],
  ["SNS_", "AWS SNS", "responsibilities"],
  ["SANDBOX_TOKEN", "CodeSandbox", "codesandbox"],
];

export function extractExternalDependencies(): {
  entries: ExternalDependencyEntry[];
  unmappedKeys: string[];
} {
  const keys = new Map<string, string>();
  for (const relative of CONFIG_SOURCES) {
    const path = resolve(SERVER_ROOT, relative);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      // 三种真实配置面形态：src/config.ts 的 optional(environment, "KEY")、
      // 参数名不为 environment 的直接成员访问（如 src/redis.ts 的
      // env.OPENBOT_REDIS_URL）、src/kb/config/index.ts 的 env/envInt/
      // envFloat/envBool("KEY") 辅助函数。
      const match = line.match(
        /(?:optional|required)\(\s*environment,\s*"([A-Z0-9_]+)"\s*\)/,
      );
      if (match) keys.set(match[1], `${relative}:${index + 1}`);
      const helper = line.match(/\benv(?:Int|Float|Bool)?\(\s*"([A-Z0-9_]+)"/);
      if (helper) keys.set(helper[1], `${relative}:${index + 1}`);
      const direct = line.match(/(?:environment|env)\.([A-Z][A-Z0-9_]+)/);
      if (direct) keys.set(direct[1], `${relative}:${index + 1}`);
    });
  }
  const byDependency = new Map<string, { closure: string; keys: string[] }>();
  const unmapped: string[] = [];
  for (const key of [...keys.keys()].sort()) {
    const mapping = EXTERNAL_DEPS.find(([prefix]) => key.startsWith(prefix));
    if (!mapping) {
      unmapped.push(key);
      continue;
    }
    const [, dependency, closure] = mapping;
    const existing = byDependency.get(dependency) ?? {
      closure,
      keys: [] as string[],
    };
    existing.keys.push(key);
    byDependency.set(dependency, existing);
  }
  const entries = [...byDependency.entries()]
    .map(([dependency, info]) => ({
      id: dependency,
      dependency,
      configKeys: info.keys,
      businessClosure: info.closure,
      ownerTicket: null,
      status: "unowned" as const,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { entries, unmappedKeys: unmapped };
}

// ---------------------------------------------------------------------------
// 已知部署但未装配的服务面（静态登记 + 源码/compose 证据）
// ---------------------------------------------------------------------------

interface SurfaceSpec {
  id: string;
  businessClosure: string;
  note: string;
  /** 存在性证据：仓库根相对文件 → 首个命中行。 */
  markers: Array<{ file: string; pattern: RegExp }>;
}

/**
 * 四个应用装配（deployment-bare/full、enterprise 降级、kb-service）之外的
 * 已知部署服务面。无法安全导入装配（supervisor 顶层 serve() 自启动、
 * go-runtime 是 Go 进程、两个 agent-* 是 compose 镜像），因此只登记为
 * unassembled / not_enumerated：登记不构成路由覆盖。
 */
const SERVICE_SURFACE_SPECS: SurfaceSpec[] = [
  {
    id: "supervisor",
    businessClosure: "computer",
    note: "独立 Bun/Hono 进程（token 门禁）；模块顶层 serve() 自启动，导入即起服务，无法在清单装配内安全枚举路由。仅登记为已知部署服务面，不构成路由覆盖。",
    markers: [
      { file: "supervisor/src/index.ts", pattern: /new Hono\(\)/ },
      { file: "supervisor/src/index.ts", pattern: /^serve\(/ },
    ],
  },
  {
    id: "go-runtime",
    businessClosure: "agent-runtime",
    note: "Go 独立执行运行时（compose profile go-runtime，默认关闭；企业 run gateway 直连）。跨语言进程无法由本清单装配枚举；仅登记服务面。",
    markers: [
      { file: "docker-compose.yml", pattern: /^\s{2}go-runtime:$/ },
      {
        file: "runtime-go/cmd/runtime/main.go",
        pattern: /http\.Server\{/,
      },
    ],
  },
  {
    id: "agent-computer",
    businessClosure: "computer",
    note: "compose 构建镜像；由 supervisor 按 Bot 启动独立 computer 容器。容器内部入口面未枚举，仅登记服务面。",
    markers: [
      { file: "docker-compose.yml", pattern: /^\s{2}agent-computer:$/ },
    ],
  },
  {
    id: "agent-sandbox",
    businessClosure: "codesandbox",
    note: "compose 独立沙箱服务镜像。容器内部入口面未枚举，仅登记服务面。",
    markers: [{ file: "docker-compose.yml", pattern: /^\s{2}agent-sandbox:$/ }],
  },
];

/**
 * 逐面从真实源码/compose 提取存在性证据行；标记未命中时在 note 里显式
 * 标注，绝不静默丢弃，也绝不因登记而声称路由覆盖。
 */
export function extractServiceSurfaces(): ServiceSurfaceEntry[] {
  const repoRoot = resolve(SERVER_ROOT, "..");
  return SERVICE_SURFACE_SPECS.map((spec) => {
    const evidence: string[] = [];
    const missing: string[] = [];
    for (const marker of spec.markers) {
      const path = resolve(repoRoot, marker.file);
      let found = false;
      if (existsSync(path)) {
        const lines = readFileSync(path, "utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          if (marker.pattern.test(lines[index])) {
            evidence.push(
              `${marker.file}:${index + 1}: ${lines[index].trim()}`,
            );
            found = true;
            break;
          }
        }
      }
      if (!found) missing.push(marker.file);
    }
    return {
      id: spec.id,
      name: spec.id,
      evidence,
      businessClosure: spec.businessClosure,
      assemblyStatus: "unassembled" as const,
      routeEnumeration: "not_enumerated" as const,
      ownerTicket: null,
      status: "unowned" as const,
      note: missing.length
        ? `${spec.note}（⚠️ 证据标记未找到：${missing.join(", ")}）`
        : spec.note,
    };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 归属输入
// ---------------------------------------------------------------------------

interface Ownable {
  ownerTicket: string | null;
  status: CoverageStatus;
  businessClosure: string;
}

function applyOwnership<T extends Ownable>(
  entries: T[],
  ownership: OwnershipInput,
  targets: {
    exact?: (entry: T) => string | undefined;
    prefix?: (entry: T) => string | undefined;
    tableId?: (entry: T) => string | undefined;
    programName?: (entry: T) => string | undefined;
  },
): void {
  const tickets = Object.keys(ownership);
  for (const entry of entries) {
    entry.ownerTicket = null;
    const exact = targets.exact?.(entry);
    const prefix = targets.prefix?.(entry);
    const tableId = targets.tableId?.(entry);
    const programName = targets.programName?.(entry);
    let owner: string | null = null;
    for (const ticket of tickets) {
      const rule = ownership[ticket];
      if (exact && rule.entrances?.includes(exact)) {
        owner = ticket;
        break;
      }
    }
    if (!owner) {
      for (const ticket of tickets) {
        const rule = ownership[ticket];
        if (
          prefix &&
          rule.entrancePrefixes?.some((value) => prefix.startsWith(value))
        ) {
          owner = ticket;
          break;
        }
      }
    }
    if (!owner) {
      for (const ticket of tickets) {
        const rule = ownership[ticket];
        if (
          rule.closures?.includes(entry.businessClosure) ||
          (tableId &&
            rule.tablePrefixes?.some((value) => tableId.includes(value))) ||
          (programName && rule.programs?.includes(programName))
        ) {
          owner = ticket;
          break;
        }
      }
    }
    entry.ownerTicket = owner;
    entry.status = owner ? "owned" : "unowned";
  }
}

// ---------------------------------------------------------------------------
// 数据库阶段（显式跳过，绝不回退开发库）
// ---------------------------------------------------------------------------

function resolveTestDatabaseUrl(
  environment: Record<string, string | undefined>,
): { url: string } | { refused: string } {
  const raw = environment.TEST_DATABASE_URL?.trim();
  if (!raw) {
    return {
      refused:
        "TEST_DATABASE_URL 未配置；拒绝回退 DATABASE_URL（专用测试库要求）。静态清单已完整生成，仅跳过在线表清单比对。",
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refused: "TEST_DATABASE_URL 不是合法 URL。" };
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
    return { refused: "TEST_DATABASE_URL 必须使用 postgres:// 协议。" };
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    return { refused: "TEST_DATABASE_URL 必须指名数据库。" };
  }
  if (database === "openbot") {
    return { refused: "TEST_DATABASE_URL 不得指向 openbot 开发库。" };
  }
  return { url: raw };
}

async function liveTableCrosscheck(
  staticTables: DataTableEntry[],
  environment: Record<string, string | undefined>,
): Promise<StageRecord> {
  const resolved = resolveTestDatabaseUrl(environment);
  if ("refused" in resolved) {
    return {
      stage: "live-table-crosscheck",
      status: "skipped",
      reason: resolved.refused,
      requires: "TEST_DATABASE_URL（专用 PostgreSQL 测试库）",
    };
  }
  try {
    const sql = new SQL(resolved.url);
    try {
      const rows = (await sql`select table_name from information_schema.tables
        where table_schema = 'public' order by table_name`) as Array<{
        table_name: string;
      }>;
      const live = rows.map((row) => row.table_name);
      const parsed = staticTables.map((entry) => entry.table);
      return {
        stage: "live-table-crosscheck",
        status: "ok",
        result: {
          liveTables: live.length,
          missingInDatabase: parsed.filter((name) => !live.includes(name)),
          extraInDatabase: live.filter((name) => !parsed.includes(name)),
        },
      };
    } finally {
      await sql.close();
    }
  } catch (error) {
    return {
      stage: "live-table-crosscheck",
      status: "failed",
      reason: `连接或查询失败：${error instanceof Error ? error.message : String(error)}`,
      requires: "TEST_DATABASE_URL（专用 PostgreSQL 测试库）",
    };
  }
}

async function enterpriseCapabilityStage(
  environment: Record<string, string | undefined>,
): Promise<StageRecord> {
  const requires =
    "ENTERPRISE_DIRECTORY_DATABASE_URL + ENTERPRISE_DATA_DATABASE_URL + TENANT_STORAGE_RUNTIME_DATABASE_URL";
  const directory = environment.ENTERPRISE_DIRECTORY_DATABASE_URL?.trim();
  const data = environment.ENTERPRISE_DATA_DATABASE_URL?.trim();
  const runtime = environment.TENANT_STORAGE_RUNTIME_DATABASE_URL?.trim();
  if (!directory || !data || !runtime) {
    return {
      stage: "enterprise-capability-assembly",
      status: "skipped",
      reason:
        "企业目录/数据/租户运行时数据库未全部配置；生产装配在该条件下挂载 createUnavailableConversationRoutes()（已由 deployment-enterprise-unavailable 装配单独覆盖），真实能力装配未验证。",
      requires,
    };
  }
  try {
    const connections = await import(
      "../../src/enterprise/tenancy/connections"
    );
    const { createDatabase } = await import("../../src/db/client");
    const directoryDatabase = createDatabase(directory);
    const dataDatabase = createDatabase(data);
    try {
      await Promise.all([
        connections.verifyDirectoryDatabase(directoryDatabase),
        connections.verifyDataDatabase(dataDatabase),
      ]);
      return {
        stage: "enterprise-capability-assembly",
        status: "ok",
        result: { verified: ["directory", "data"] },
      };
    } finally {
      await directoryDatabase.$client.close();
      await dataDatabase.$client.close();
    }
  } catch (error) {
    return {
      stage: "enterprise-capability-assembly",
      status: "failed",
      reason: `企业库能力校验失败：${error instanceof Error ? error.message : String(error)}`,
      requires,
    };
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeDigest(
  inventory: Omit<CoverageInventory, "digest" | "generatedAt">,
): string {
  return createHash("sha256").update(stableStringify(inventory)).digest("hex");
}

function digestOf(inventory: Omit<CoverageInventory, "digest">): string {
  const { generatedAt: _generatedAt, ...rest } = inventory;
  return computeDigest(rest);
}

function mergeEntrances(
  assemblies: AssembledApp[],
  selected: Set<string>,
): { entrances: EntranceEntry[]; assembliesInfo: AssemblyInfo[] } {
  const merged = new Map<string, EntranceEntry>();
  const assembliesInfo: AssemblyInfo[] = [];
  for (const assembled of assemblies) {
    if (!selected.has(assembled.name)) continue;
    const counted = new Map<string, number>();
    for (const route of extractRouteEntrances(assembled.app)) {
      const id = `${route.method} ${route.path}`;
      counted.set(id, (counted.get(id) ?? 0) + 1);
    }
    assembliesInfo.push({
      name: assembled.name,
      entrance: assembled.entrance,
      status: "assembled",
      routeEntries: counted.size,
      note: assembled.notes.length ? assembled.notes.join("; ") : undefined,
    });
    for (const [id, count] of counted) {
      const method = id.slice(0, id.indexOf(" "));
      const path = id.slice(id.indexOf(" ") + 1);
      const existing = merged.get(id);
      if (existing) {
        existing.registeredIn.push(assembled.name);
        existing.registrations = Math.max(existing.registrations, count);
      } else {
        merged.set(id, {
          id,
          entrance: id,
          method,
          path,
          kind: method === "ALL" ? "catchall" : "route",
          type: classifyStream(path),
          businessClosure: classifyPath(path),
          ownerTicket: null,
          status: "unowned",
          registration: "conditional",
          registeredIn: [assembled.name],
          registrations: count,
        });
      }
    }
  }
  for (const entry of merged.values()) {
    // bare 装配里出现 = 无条件注册；kb-service 独有 = kb 服务自身的固定面。
    if (
      entry.registeredIn.includes("deployment-bare") ||
      entry.registeredIn.every((name) => name === "kb-service")
    ) {
      entry.registration = "always";
    }
  }
  const entrances = [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { entrances, assembliesInfo };
}

export async function buildInventory(
  options: BuildOptions = {},
): Promise<CoverageInventory> {
  const environment = options.environment ?? process.env;
  const ownership = options.ownership ?? {};
  const assemblies = await assembleInventoryApps(options.mutateApp);
  const selected = options.assemblies
    ? new Set(options.assemblies)
    : new Set(assemblies.map((assembled) => assembled.name));

  const { entrances, assembliesInfo } = mergeEntrances(assemblies, selected);

  const serve = await serveLevelEntrances();
  entrances.push(...serve.entrances);
  entrances.sort((a, b) => (a.id < b.id ? -1 : 1));

  const backgroundPrograms = extractBackgroundPrograms();
  const dataTables = await extractDataTables();
  const { entries: externalDependencies, unmappedKeys } =
    extractExternalDependencies();
  const serviceSurfaces = extractServiceSurfaces();
  options.mutateServiceSurfaces?.(serviceSurfaces);

  applyOwnership(entrances, ownership, {
    exact: (entry) => entry.entrance,
    prefix: (entry) => entry.path,
  });
  applyOwnership(backgroundPrograms, ownership, {
    programName: (entry) => entry.name,
  });
  applyOwnership(dataTables, ownership, {
    tableId: (entry) => entry.id,
  });
  applyOwnership(externalDependencies, ownership, {
    tableId: (entry) => entry.id,
  });
  applyOwnership(serviceSurfaces, ownership, {});

  const stages: StageRecord[] = [];
  stages.push(await liveTableCrosscheck(dataTables, environment));
  stages.push(await enterpriseCapabilityStage(environment));

  const byClosure: Record<string, { total: number; unowned: number }> = {};
  for (const entry of entrances) {
    let bucket = byClosure[entry.businessClosure];
    if (!bucket) {
      bucket = { total: 0, unowned: 0 };
      byClosure[entry.businessClosure] = bucket;
    }
    bucket.total += 1;
    if (entry.status === "unowned") bucket.unowned += 1;
  }

  const inventory: Omit<CoverageInventory, "digest"> = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    assemblies: assembliesInfo,
    entrances,
    backgroundPrograms,
    serviceSurfaces,
    dataTables,
    externalDependencies,
    unmappedConfigKeys: unmappedKeys,
    stages,
    summary: {
      totalEntrances: entrances.length,
      routeEntrances: entrances.filter((entry) => entry.kind === "route")
        .length,
      catchallEntrances: entrances.filter((entry) => entry.kind === "catchall")
        .length,
      unownedEntrances: entrances.filter((entry) => entry.status === "unowned")
        .length,
      unclassifiedEntrances: entrances.filter(
        (entry) => entry.businessClosure === "unclassified",
      ).length,
      serveUpgradeBranches: serve.upgradeBranches,
      serveUpgradeEntrances: serve.entrances.length,
      dataTables: dataTables.length,
      backgroundPrograms: backgroundPrograms.length,
      serviceSurfaces: serviceSurfaces.length,
      externalDependencies: externalDependencies.length,
      byClosure,
      managementPlanes: {
        platform: entrances.filter(
          (entry) => classifyManagementPlane(entry) === "platform",
        ).length,
        company: entrances.filter(
          (entry) => classifyManagementPlane(entry) === "company",
        ).length,
      },
    },
  };

  return { ...inventory, digest: digestOf(inventory) };
}

// ---------------------------------------------------------------------------
// 人类可读缺口报告
// ---------------------------------------------------------------------------

export function renderGapReport(inventory: CoverageInventory): string {
  const { summary } = inventory;
  const lines: string[] = [];
  lines.push("# MT001 多租户覆盖清单 — 缺口报告");
  lines.push("");
  lines.push(`- 生成时间：${inventory.generatedAt}`);
  lines.push(`- digest：\`${inventory.digest}\``);
  lines.push(
    `- 入口：${summary.totalEntrances}（route ${summary.routeEntrances} / catchall ${summary.catchallEntrances}；未归属 ${summary.unownedEntrances}；未分类 ${summary.unclassifiedEntrances}）`,
  );
  lines.push(
    `- 后台程序 ${summary.backgroundPrograms} · 数据表 ${summary.dataTables} · 外部依赖 ${summary.externalDependencies}`,
  );
  lines.push(
    `- 服务面 ${summary.serviceSurfaces}（已知部署、未装配、路由未枚举——列出不构成路由覆盖）`,
  );
  lines.push(
    `- serve() 升级分支 ${summary.serveUpgradeBranches} 个，已登记 stream 入口 ${summary.serveUpgradeEntrances} 个${
      summary.serveUpgradeBranches > summary.serveUpgradeEntrances
        ? "（⚠️ 存在未登记的升级分支）"
        : ""
    }`,
  );
  lines.push("");
  lines.push("## 装配（入口事实源）");
  lines.push("");
  lines.push("| 装配 | 入口面 | 状态 | 唯一路由 |");
  lines.push("| --- | --- | --- | --- |");
  for (const assembly of inventory.assemblies) {
    lines.push(
      `| ${assembly.name} | ${assembly.entrance} | ${assembly.status} | ${assembly.routeEntries} |`,
    );
    if (assembly.note) lines.push(`  - note: ${assembly.note}`);
  }
  lines.push("");
  lines.push("## 服务面（已知部署 · 未装配 · 路由未枚举 ≠ 已覆盖）");
  lines.push("");
  for (const surface of inventory.serviceSurfaces) {
    lines.push(
      `- \`${surface.id}\`（${surface.businessClosure}，${surface.assemblyStatus}，路由${
        surface.routeEnumeration === "not_enumerated" ? "未枚举" : "已枚举"
      }，${surface.status}）— ${surface.note}`,
    );
    for (const line of surface.evidence) {
      lines.push(`  - 证据：${line}`);
    }
  }
  lines.push("");
  lines.push(
    "> 上述服务面为已知部署但未进入四个应用装配的进程；登记不构成路由覆盖，统一上线验收前须为其单独补装配或显式登记为未覆盖。",
  );
  lines.push("");
  lines.push("## 未归属入口（按业务闭环）");
  for (const [closure, bucket] of Object.entries(summary.byClosure).sort()) {
    const label = CLOSURE_LABELS[closure] ?? closure;
    lines.push("");
    lines.push(
      `### ${closure}（${label}）— 未归属 ${bucket.unowned}/${bucket.total}`,
    );
    for (const entry of inventory.entrances) {
      if (entry.businessClosure !== closure || entry.status !== "unowned") {
        continue;
      }
      lines.push(
        `- \`${entry.entrance}\`（${entry.type}/${entry.kind}，${entry.registration}，${entry.registeredIn.join("+")}）`,
      );
    }
  }
  const unclassified = inventory.entrances.filter(
    (entry) => entry.businessClosure === "unclassified",
  );
  if (unclassified.length) {
    lines.push("");
    lines.push("## ⚠️ 未分类入口（阻断统一上线）");
    for (const entry of unclassified) {
      lines.push(`- \`${entry.entrance}\``);
    }
  }
  lines.push("");
  const unownedTables = inventory.dataTables.filter(
    (entry) => entry.status === "unowned",
  );
  const unclassifiedTables = inventory.dataTables.filter(
    (entry) => entry.businessClosure === "unclassified",
  );
  lines.push(
    `## 数据表 — 共 ${inventory.dataTables.length} 张；未归属 ${unownedTables.length}；未分类 ${unclassifiedTables.length}`,
  );
  if (unclassifiedTables.length) {
    lines.push(
      `- 未分类示例：${unclassifiedTables
        .slice(0, 20)
        .map((entry) => entry.id)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## 后台程序（静态候选提取）");
  for (const program of inventory.backgroundPrograms) {
    lines.push(
      `- ${program.name}（${program.businessClosure}，${program.status}）— ${program.evidence}`,
    );
  }
  lines.push("");
  lines.push("## 外部依赖（配置面提取）");
  for (const dependency of inventory.externalDependencies) {
    lines.push(
      `- ${dependency.dependency}（${dependency.businessClosure}）：${dependency.configKeys.join(", ")}`,
    );
  }
  if (inventory.unmappedConfigKeys.length) {
    lines.push(
      `- 未映射配置键（待归类）：${inventory.unmappedConfigKeys.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## 数据库阶段（显式跳过 = 未通过，不静默）");
  for (const stage of inventory.stages) {
    lines.push(
      `- ${stage.stage}: ${stage.status}${stage.reason ? ` — ${stage.reason}` : ""}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const flags = {
    pretty: false,
    ownership: undefined as string | undefined,
    out: undefined as string | undefined,
    report: undefined as string | undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pretty") flags.pretty = true;
    else if (arg === "--ownership") flags.ownership = argv[index + 1];
    else if (arg === "--out") flags.out = argv[index + 1];
    else if (arg === "--report") flags.report = argv[index + 1];
  }
  return flags;
}

/** 装配期间把第三方库打到 stdout 的日志收进缓冲，装配完转移到 stderr。 */
async function withCleanStdout<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  const captured: string[] = [];
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = original;
    for (const chunk of captured) process.stderr.write(chunk);
  }
}

async function main() {
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
  const flags = parseArgs(process.argv.slice(2));
  let ownership: OwnershipInput = {};
  if (flags.ownership) {
    try {
      ownership = JSON.parse(readFileSync(flags.ownership, "utf8"));
    } catch (error) {
      process.stderr.write(
        `ownership 文件解析失败（${flags.ownership}）：${String(error)}\n`,
      );
      process.exit(1);
    }
  }
  const inventory = await withCleanStdout(() => buildInventory({ ownership }));
  const json = JSON.stringify(inventory, null, flags.pretty ? 2 : undefined);
  if (flags.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(flags.out, `${json}\n`);
    process.stderr.write(`JSON 已写入 ${flags.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  const report = renderGapReport(inventory);
  if (flags.report) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(flags.report, report);
    process.stderr.write(`缺口报告已写入 ${flags.report}\n`);
  } else {
    process.stderr.write(`${report}\n`);
  }
}

if (import.meta.main) {
  await main();
}
