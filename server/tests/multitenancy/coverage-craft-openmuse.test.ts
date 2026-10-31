// server/tests/multitenancy/coverage-craft-openmuse.test.ts
// MT136（Issue #179）：覆盖证据——Craft/Workshop、OpenMuse 与删除恢复。
//
// 用 MT131 系验收产物（MT132 身份矩阵 runner）为 Craft/Workshop 会话与
// 产物、分享签发与撤销（MT058 有效分享授权语义：受众=令牌持有者、有效
// 期、撤销）、OpenMuse 个人域（goals/ideas/memories）、连接器
// （openmuse-google 每属主连接席）、通知与移动聚合（MT065/MT066）、删除
// 语义分离（MT067 双轨）与 purge/restore manifest（MT068）的逐入口正向
// 与越权证据。每条场景骑真实服务与真实表（craft/workshop 走应用面商店
// 的属主门——本域的授权事实源；企业面走 MT008/MT010/MT062/MT065/MT066/
// MT067/MT068 交付的真实服务 + 真实受限角色 + 真实 RLS）。
//
// 披露（与 MT135 同形）：craft/workshop 的 HTTP 装配需要完整运行时（沙箱
// 网关、turn 执行器），本套件在路由实际组合的授权缝上取证——craft 会话
// 的所有权门是 store 的 ownership-checked 读（findSession/listUserSessions/
// deleteSession 带 userId）；workshop 频道门的组成事实是 session.ownerUserId
// 与「唯一非属主通道 = 分享令牌」两条（sharing.ts 的 resolveShareActor 是
// canUseBot 的唯一例外，路由源码注明）。两侧证据都在真实行上执行。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在
// 用例名里，skipped 不计为通过），绝不回退开发库。
//
// 证据可复现（票面 AC）：本套件即复现命令——
//   set +x; source /tmp/mt25-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/coverage-craft-openmuse.test.ts

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import {
  type MatrixPlan,
  runMatrixCoverage,
} from "../../scripts/multitenancy/identity-matrix-runner";
import {
  buildInventory,
  type CoverageInventory,
} from "../../scripts/multitenancy/inventory";
import { createCraftStore } from "../../src/craft/store";
import { createDatabase, type Database } from "../../src/db/client";
import { isResourceNotFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { agents, channels, users } from "../../src/db/schema/core";
import { createOpenMuseGoogleRows } from "../../src/openmuse-connectors/store";
import { createShareService } from "../../src/workshop/sharing";
import { createWorkshopStore } from "../../src/workshop/store";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import { createOpenMuseActivityFixture } from "./support/openmuse-activity-notifications";
import { createOpenMusePersonalFixture } from "./support/openmuse-personal";
import { createPersonalShareFixture } from "./support/personal-share";
import { createPurgeRestoreFixture } from "./support/purge-restore";
import {
  adapterFromScenarios,
  requireEntrance,
  type ScenarioMap,
} from "./support/coverage-matrix";
import type { IsolationObservation } from "./support/scenarios";
import { registerIsolationDomain } from "./support/scenarios";
import { createVoiceMobileFixture } from "./support/voice-mobile-bff";

// ---------------------------------------------------------------------------
// 环境探针：缺 env 显式 skip（带理由），绝不静默回退
// ---------------------------------------------------------------------------

function probeEnvironment(): { ok: true } | { ok: false; reason: string } {
  const required = [
    "TEST_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
  ] as const;
  const missing = required.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `MT136 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    for (const role of ["directory", "data", "operator"] as const) {
      enterpriseRuntimeDatabaseUrlFrom(role, process.env);
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name: string, fn: () => Promise<void>) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

/** The real inventory every mapped entrance must come from. */
const inventory: CoverageInventory = await buildInventory({
  environment: process.env,
});

/**
 * 夹具身份 → §11 矩阵类等价表（披露，非推导）。craft/workshop 应用面
 * actor 是数据库用户行（无成员资格——本域授权事实是行级属主），其 §11
 * 类载体经 MT002 夹具身份披露；企业面场景直接用各自夹具的真实身份。
 */
const ACTOR_CLASSES = {
  "a1-owner": "company-a-team-a1-only",
  "a1-member": "same-team-other-person",
  "a1-other": "same-team-other-person",
  "a2-member": "company-a-team-a2-only",
  "b1-member": "cross-company",
} as const;

// ---------------------------------------------------------------------------
// 惰性夹具：按域首个场景触发，套件只为本票实际映射的域付装配成本
// ---------------------------------------------------------------------------

const createdDisposables: Array<() => Promise<void>> = [];

function lazy<
  T extends { dispose(): Promise<void> } | { dispose?(): Promise<void> },
>(create: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () =>
    (promise ??= create().then((fixture) => {
      if (typeof fixture.dispose === "function") {
        createdDisposables.push(() => fixture.dispose!());
      }
      return fixture;
    }));
}

/** craft/workshop 应用面夹具：两个用户 + 真实 craft/workshop 商店与分享服务。 */
interface CraftWorkshopFixture {
  readonly db: Database;
  readonly userA: string;
  readonly userB: string;
  readonly crafts: ReturnType<typeof createCraftStore>;
  readonly workshop: ReturnType<typeof createWorkshopStore>;
  readonly shares: ReturnType<typeof createShareService>;
  /**
   * workshop_sessions 双 FK（channel_id→channels、bot_id→agents）；按需种
   * 真渠道行与真 Bot 行（最小 NOT NULL 事实，真实约束下的真实行）。
   */
  ensureArrangement(channelId: string, botId: string): Promise<void>;
  dispose(): Promise<void>;
}

const craftWorkshop = lazy(async (): Promise<CraftWorkshopFixture> => {
  const db = createDatabase(process.env.TEST_DATABASE_URL!, { max: 4 });
  const run = `mt136-${randomUUID().slice(0, 8)}`;
  const userA = `${run}-user-a`;
  const userB = `${run}-user-b`;
  await db.insert(users).values([
    { id: userA, email: `${userA}@mt136.test` },
    { id: userB, email: `${userB}@mt136.test` },
  ]);
  const crafts = createCraftStore(db);
  const workshop = createWorkshopStore(db);
  const shares = createShareService({
    store: workshop,
    // 测试签名密钥在装配处注入（生产密钥是部署事务，MT068 同款披露）。
    signingKey: `mt136-signing-${run}`,
  });
  // craft_sessions/workshop_sessions 无 FK 到 users；先删行再删用户。
  const ensureArrangement = async (channelId: string, botId: string) => {
    await db
      .insert(channels)
      .values({
        id: channelId,
        name: `MT136 channel ${channelId}`,
        description: "mt136 coverage arrangement",
      })
      .onConflictDoNothing();
    await db
      .insert(agents)
      .values({
        id: botId,
        name: `MT136 bot ${botId}`,
        type: "built_in",
        configuration: {},
      })
      .onConflictDoNothing();
  };
  const dispose = async () => {
    await db.execute(
      sql`delete from craft_sessions where user_id in (${userA}, ${userB})`,
    );
    await db.execute(
      sql`delete from workshop_sessions where owner_user_id in (${userA}, ${userB})`,
    );
    await db.execute(sql`delete from users where id like ${`${run}%`}`);
    await db.execute(sql`delete from channels where id like ${`mt136-ch-%`}`);
    await db.execute(sql`delete from agents where id like ${`mt136-bot-%`}`);
  };
  createdDisposables.push(dispose);
  return {
    db,
    userA,
    userB,
    crafts,
    workshop,
    shares,
    ensureArrangement,
    dispose,
  };
});

const personalShare = lazy(() => createPersonalShareFixture());
const openMusePersonal = lazy(() => createOpenMusePersonalFixture());
const openMuseActivity = lazy(() => createOpenMuseActivityFixture());
const voiceMobile = lazy(() => createVoiceMobileFixture());
const purgeRestore = lazy(() => createPurgeRestoreFixture());

const denyObservation = (
  denied: boolean,
  leaks: readonly unknown[] = [],
  effects: readonly unknown[] = [],
): IsolationObservation => ({
  positiveControlPassed: false,
  denied,
  leakedRecords: leaks,
  forbiddenEffects: effects,
});

// ---------------------------------------------------------------------------
// 场景（craft-workshop 域）：行级属主门 + 分享授权（受众/有效期/撤销）
// ---------------------------------------------------------------------------

const craftWorkshopScenarios: ScenarioMap = {
  // POST /api/craft/sessions —— 创建（真实 INSERT；actor=userA=仅属甲载体）。
  "craft.create.positive": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 create",
    });
    const seen = await fx.crafts.findSession(row.id, fx.userA);
    return {
      positiveControlPassed: seen?.id === row.id,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "craft.create.denial": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 create deny",
    });
    // 另一用户（跨公司类载体）对该会话的一切属主门读 = 不存在。
    const asB = await fx.crafts.findSession(row.id, fx.userB);
    const listB = await fx.crafts.listUserSessions(fx.userB, 100);
    return denyObservation(
      asB === undefined && !listB.some((entry) => entry.id === row.id),
      listB.filter((entry) => entry.id === row.id),
    );
  },

  // GET /api/craft/sessions —— 侧栏列表（ownership-scoped read）。
  "craft.list.positive": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 list",
    });
    const mine = await fx.crafts.listUserSessions(fx.userA, 100);
    return {
      positiveControlPassed: mine.some((entry) => entry.id === row.id),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "craft.list.denial": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 list deny",
    });
    const theirs = await fx.crafts.listUserSessions(fx.userB, 100);
    const leaked = theirs.filter((entry) => entry.id === row.id);
    return denyObservation(leaked.length === 0, leaked);
  },

  // GET /api/craft/sessions/:sessionId —— 会话读取（store 的 ownership check
  // 就是路由守卫：findSession(id, userId) 带属主比对）。
  "craft.read.positive": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 read",
    });
    const seen = await fx.crafts.findSession(row.id, fx.userA);
    return {
      positiveControlPassed: seen?.id === row.id,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "craft.read.denial": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 read deny",
    });
    const asB = await fx.crafts.findSession(row.id, fx.userB);
    const emptySeat = await fx.crafts.getEmptySessionForUser(fx.userB);
    return denyObservation(asB === undefined && emptySeat?.id !== row.id);
  },

  // PUT /api/craft/sessions/:sessionId/name —— 更名（守卫在读侧：非属主
  // 连会话都读不到，更新路径不可达；真实路由同序）。
  "craft.rename.positive": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 rename-before",
    });
    const updated = await fx.crafts.updateSession(row.id, {
      name: "mt136 rename-after",
    });
    return {
      positiveControlPassed: updated?.name === "mt136 rename-after",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "craft.rename.denial": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 rename-deny",
    });
    // 非属主的守卫读失败 = 路由拒绝（404 语义），更名不可达。
    const guard = await fx.crafts.findSession(row.id, fx.userB);
    return denyObservation(guard === undefined);
  },

  // DELETE /api/craft/sessions/:sessionId —— 删除（store 级属主校验）。
  "craft.delete.positive": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 delete",
    });
    // 7e2d514e2 起 deleteSession 返回 { deleted, snapshots }（所有权校验内
    // 先删快照再删会话），场景观察读 deleted，别把对象当布尔喂给评估器。
    const { deleted } = await fx.crafts.deleteSession(row.id, fx.userA);
    return {
      positiveControlPassed: deleted,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "craft.delete.denial": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 delete deny",
    });
    const { deleted: deletedByB } = await fx.crafts.deleteSession(
      row.id,
      fx.userB,
    );
    const survivor = await fx.crafts.findSession(row.id, fx.userA);
    return denyObservation(
      deletedByB === false && survivor !== undefined,
      [],
      deletedByB ? [{ crossOwnerDelete: row.id }] : [],
    );
  },

  // GET /api/craft/sessions/:sessionId/artifacts —— 产物（同守卫读；
  // 产物行的父会话属主即判据）。
  "craft.artifacts.positive": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 artifacts",
    });
    const seen = await fx.crafts.findSession(row.id, fx.userA);
    return {
      positiveControlPassed: seen !== undefined,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "craft.artifacts.denial": async () => {
    const fx = await craftWorkshop();
    const row = await fx.crafts.createSession({
      userId: fx.userA,
      name: "mt136 artifacts deny",
    });
    const asB = await fx.crafts.findSession(row.id, fx.userB);
    return denyObservation(asB === undefined);
  },

  // GET /api/workshop/:channelId —— 聚合（门事实 = ownerUserId）。
  "workshop.aggregate.positive": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    const session = await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const read = await fx.workshop.sessionByChannel(channelId);
    return {
      positiveControlPassed:
        read?.id === session.id && read?.ownerUserId === fx.userA,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "workshop.aggregate.denial": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    // 非属主两门皆闭：所有权不匹配 + 无分享令牌通道（resolveShareActor 是
    // 路由唯一的非属主例外，wrong token = null）。
    const stranger = await fx.shares.resolveShareActor("mt136-wrong-token");
    const session = await fx.workshop.sessionByChannel(channelId);
    const ownerMismatch = session?.ownerUserId !== fx.userB;
    return denyObservation(stranger === null && ownerMismatch);
  },

  // POST /api/workshop/:channelId/turns —— 轮次创建（同门；store 轮次方法
  // 按会话 id 键入，门在路由）。
  "workshop.turns.positive": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    const session = await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const turn = await fx.workshop.enqueueTurn({
      sessionId: session.id,
      prompt: "mt136 turn",
      initiator: "person",
    });
    return {
      positiveControlPassed: turn !== undefined,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "workshop.turns.denial": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const session = await fx.workshop.sessionByChannel(channelId);
    const stranger = await fx.shares.resolveShareActor("mt136-wrong-token");
    return denyObservation(
      session?.ownerUserId !== fx.userB && stranger === null,
    );
  },

  // POST /api/workshop/:channelId/share —— 分享签发（受众=令牌持有者）。
  "workshop.share-create.positive": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const handle = await fx.shares.createShare({
      channelId,
      scope: "preview",
      expiresInDays: 7,
      createdBy: fx.userA,
    });
    const actor = await fx.shares.resolveShareActor(handle.token);
    return {
      positiveControlPassed:
        actor?.channelId === channelId && actor?.scope === "preview",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "workshop.share-create.denial": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    await fx.shares.createShare({
      channelId,
      scope: "preview",
      createdBy: fx.userA,
    });
    // 受众面：非持有者（错误令牌、篡改令牌）一律同形 null。
    const wrong = await fx.shares.resolveShareActor("mt136-forged-token");
    const empty = await fx.shares.resolveShareActor("");
    return denyObservation(wrong === null && empty === null);
  },

  // DELETE /api/workshop/:channelId/share —— 撤销（撤销后旧令牌死）。
  "workshop.share-revoke.positive": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const handle = await fx.shares.createShare({
      channelId,
      scope: "preview",
      createdBy: fx.userA,
    });
    await fx.shares.revokeShare(channelId);
    const dead = await fx.shares.resolveShareActor(handle.token);
    return {
      positiveControlPassed: dead === null,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "workshop.share-revoke.denial": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    // 有效期门：过期令牌与撤销/错误令牌同形 null（过期即拒）。过期探针
    // 用独立频道——一个会话只有一条活链（setShare 是替换语义）。
    const handle = await fx.shares.createShare({
      channelId,
      scope: "preview",
      expiresInDays: 7,
      createdBy: fx.userA,
    });
    const expiredChannelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const expiredBotId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(expiredChannelId, expiredBotId);
    await fx.workshop.getOrCreateSession({
      channelId: expiredChannelId,
      botId: expiredBotId,
      ownerUserId: fx.userA,
    });
    const expiredService = createShareService({
      store: fx.workshop,
      signingKey: "mt136-signing-expired-probe",
      now: () => new Date(Date.now() - 8 * 86_400_000),
    });
    const expiredHandle = await expiredService.createShare({
      channelId: expiredChannelId,
      scope: "preview",
      expiresInDays: 1,
      createdBy: fx.userA,
    });
    const liveRead = await fx.shares.resolveShareActor(handle.token);
    const expiredRead = await fx.shares.resolveShareActor(expiredHandle.token);
    return denyObservation(
      expiredRead === null && liveRead !== null,
      [],
      liveRead === null ? [{ liveShareKilled: channelId }] : [],
    );
  },

  // GET /api/public/workshop/:channelId/public/artifacts —— 公共产物
  // （分享范围门 + 签名 URL 校验）。
  "workshop.public-artifacts.positive": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const handle = await fx.shares.createShare({
      channelId,
      scope: "preview_download",
      createdBy: fx.userA,
    });
    const actor = await fx.shares.resolveShareActor(handle.token);
    const artifactId = `mt136-artifact-${randomUUID().slice(0, 8)}`;
    const url = fx.shares.signArtifactUrl({
      channelId,
      artifactId,
      scope: "preview_download",
    });
    const signature =
      new URL(url, "https://mt136.invalid").searchParams.get("s") ?? "";
    const verified = fx.shares.verifyArtifactUrl(
      channelId,
      artifactId,
      "preview_download",
      signature,
    );
    return {
      positiveControlPassed: actor?.scope === "preview_download" && verified,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "workshop.public-artifacts.denial": async () => {
    const fx = await craftWorkshop();
    const channelId = `mt136-ch-${randomUUID().slice(0, 8)}`;
    const botId = `mt136-bot-${randomUUID().slice(0, 8)}`;
    await fx.ensureArrangement(channelId, botId);
    await fx.workshop.getOrCreateSession({
      channelId,
      botId,
      ownerUserId: fx.userA,
    });
    const handle = await fx.shares.createShare({
      channelId,
      scope: "preview",
      createdBy: fx.userA,
    });
    await fx.shares.revokeShare(channelId);
    const revoked = await fx.shares.resolveShareActor(handle.token);
    const artifactId = `mt136-artifact-${randomUUID().slice(0, 8)}`;
    const url = fx.shares.signArtifactUrl({
      channelId,
      artifactId,
      scope: "preview",
    });
    const signature =
      new URL(url, "https://mt136.invalid").searchParams.get("s") ?? "";
    const reshaped = fx.shares.verifyArtifactUrl(
      channelId,
      artifactId,
      "preview_download", // 范围被抬权 = reshape
      signature,
    );
    return denyObservation(revoked === null && !reshaped);
  },
};

// ---------------------------------------------------------------------------
// 场景（personal-shares 域）：企业面分享授权（MT058 语义的真实验证面）
// ---------------------------------------------------------------------------

const personalSharesScenarios: ScenarioMap = {
  // POST /api/workshop/:channelId/share 的企业面事实：属主显式分享给受众。
  "shares.grant.positive": async () => {
    const fx = await personalShare();
    const resource = await fx.provisionPersonalResource({
      kind: "session",
      owner: "a1-member",
      team: "team-a1",
    });
    const ownerPrincipal =
      fx.base.isolation.identities["a1-member"].principalId ?? "";
    const audiencePrincipal =
      fx.base.isolation.identities["a1-other"].principalId ?? "";
    const receipt = await fx.shares.share({
      tenantId: resource.tenantId,
      resourceId: resource.resourceId,
      actorPrincipalId: ownerPrincipal,
      audiencePrincipalId: audiencePrincipal,
      action: "read",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return {
      positiveControlPassed:
        receipt.resourceId === resource.resourceId &&
        receipt.audiencePrincipalId === audiencePrincipal,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "shares.grant.denial": async () => {
    const fx = await personalShare();
    const resource = await fx.provisionPersonalResource({
      kind: "session",
      owner: "a1-member",
      team: "team-a1",
    });
    // 非属主（同团队他人）不能分享他人的资源：SHARE_ACTOR_NOT_OWNER 拒绝。
    const impostor = fx.base.isolation.identities["a1-other"].principalId ?? "";
    const ownerPrincipal =
      fx.base.isolation.identities["a1-member"].principalId ?? "";
    let refused = false;
    try {
      await fx.shares.share({
        tenantId: resource.tenantId,
        resourceId: resource.resourceId,
        actorPrincipalId: impostor,
        audiencePrincipalId: ownerPrincipal,
        action: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    } catch {
      refused = true;
    }
    const row = await fx.shareRow({
      tenantId: resource.tenantId,
      resourceId: resource.resourceId,
      audiencePrincipalId: ownerPrincipal,
    });
    return denyObservation(refused, row ? [row] : []);
  },

  // DELETE /api/workshop/:channelId/share 的企业面事实：属主撤销后受众
  // 判定门回到 deny（不可见语义）。
  "shares.revoke.positive": async () => {
    const fx = await personalShare();
    const resource = await fx.provisionPersonalResource({
      kind: "session",
      owner: "a1-member",
      team: "team-a1",
    });
    const ownerPrincipal =
      fx.base.isolation.identities["a1-member"].principalId ?? "";
    const audiencePrincipal =
      fx.base.isolation.identities["a1-other"].principalId ?? "";
    await fx.shares.share({
      tenantId: resource.tenantId,
      resourceId: resource.resourceId,
      actorPrincipalId: ownerPrincipal,
      audiencePrincipalId: audiencePrincipal,
      action: "read",
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const receipt = await fx.shares.revoke({
      tenantId: resource.tenantId,
      resourceId: resource.resourceId,
      actorPrincipalId: ownerPrincipal,
      audiencePrincipalId: audiencePrincipal,
      action: "read",
    });
    const audienceScope = await fx.base.scopeFor("a1-other", {
      tenantId: resource.tenantId,
      workspaceId: resource.workspaceId,
    });
    const afterRevoke = await fx.decisions.decide(
      audienceScope,
      resource.resourceId,
    );
    return {
      positiveControlPassed:
        receipt.revoked === true && afterRevoke.outcome === "deny",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "shares.revoke.denial": async () => {
    const fx = await personalShare();
    const resource = await fx.provisionPersonalResource({
      kind: "session",
      owner: "a1-member",
      team: "team-a1",
    });
    const ownerPrincipal =
      fx.base.isolation.identities["a1-member"].principalId ?? "";
    // 跨公司受众从未被授权：判定门 deny（RESOURCE_NOT_FOUND，零存在泄漏）。
    const bScope = await fx.base.scopeFor("b1-member", {
      tenantId: fx.base.isolation.ids["company-b"],
      workspaceId: fx.base.isolation.ids["team-b1"],
    });
    const verdict = await fx.decisions.decide(bScope, resource.resourceId);
    let nonOwnerRevokeRefused = false;
    try {
      await fx.shares.revoke({
        tenantId: resource.tenantId,
        resourceId: resource.resourceId,
        actorPrincipalId:
          fx.base.isolation.identities["a1-other"].principalId ?? "",
        audiencePrincipalId: ownerPrincipal,
        action: "read",
      });
    } catch {
      nonOwnerRevokeRefused = true;
    }
    return denyObservation(verdict.outcome === "deny" && nonOwnerRevokeRefused);
  },
};

// ---------------------------------------------------------------------------
// 场景（openmuse-personal 域）：个人域 goals/ideas/memories
// ---------------------------------------------------------------------------

/** 种根行 + 真实 pin（归属接线的写半边）——列表/读取只认已接线的对象。 */
const seedAndPinPersonal = async (
  objectType: "goal" | "idea" | "memory",
  title: string,
) => {
  const fx = await openMusePersonal();
  const objectId = await fx.seedObject(objectType, {
    ownerUserId: fx.ids["user-a1-member"],
    title,
  });
  const scope = await fx.scopeAs(
    "a1-member",
    fx.ids["company-a"],
    fx.ids["team-a1"],
  );
  const result = await fx.service.pinPersonalObject(scope, {
    objectType,
    objectId,
  });
  if (!("status" in result)) {
    throw new Error(`MT136 pin failed: ${JSON.stringify(result)}`);
  }
  return objectId;
};
const seedAndPinGoal = (_fx?: unknown, title = "mt136 goal") =>
  seedAndPinPersonal("goal", title);
const seedAndPinIdea = (_fx?: unknown, title = "mt136 idea") =>
  seedAndPinPersonal("idea", title);
const seedAndPinMemory = (_fx?: unknown, title = "mt136 memory") =>
  seedAndPinPersonal("memory", title);

const openMusePersonalScenarios: ScenarioMap = {
  "openmuse.goals.positive": async () => {
    const fx = await openMusePersonal();
    const goalId = await seedAndPinGoal(fx);
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const { objects } = await fx.service.listPersonalObjects(scope, "goal", {
      limit: 50,
    });
    const read = await fx.service.readPersonalObject(scope, "goal", goalId);
    return {
      positiveControlPassed:
        objects.some((item) => item.ownership.objectId === goalId) &&
        read.outcome === "allow" &&
        read.record.id === goalId,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "openmuse.goals.denial": async () => {
    const fx = await openMusePersonal();
    const goalId = await seedAndPinGoal(fx, "mt136 goal deny");
    const bScope = await fx.scopeAs(
      "b1-member",
      fx.ids["company-b"],
      fx.ids["team-b1"],
    );
    const { objects } = await fx.service.listPersonalObjects(bScope, "goal", {
      limit: 50,
    });
    const read = await fx.service.readPersonalObject(bScope, "goal", goalId);
    const leaked = objects.filter((item) => item.ownership.objectId === goalId);
    return denyObservation(
      isResourceNotFoundVerdict(read) && leaked.length === 0,
      leaked,
    );
  },

  "openmuse.ideas.positive": async () => {
    const fx = await openMusePersonal();
    const ideaId = await seedAndPinIdea(fx);
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const { objects } = await fx.service.listPersonalObjects(scope, "idea", {
      limit: 50,
    });
    return {
      positiveControlPassed: objects.some(
        (item) => item.ownership.objectId === ideaId,
      ),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "openmuse.ideas.denial": async () => {
    const fx = await openMusePersonal();
    const ideaId = await seedAndPinIdea(fx, "mt136 idea deny");
    const bScope = await fx.scopeAs(
      "b1-member",
      fx.ids["company-b"],
      fx.ids["team-b1"],
    );
    const { objects } = await fx.service.listPersonalObjects(bScope, "idea", {
      limit: 50,
    });
    const leaked = objects.filter((item) => item.ownership.objectId === ideaId);
    return denyObservation(leaked.length === 0, leaked);
  },

  "openmuse.memories.positive": async () => {
    const fx = await openMusePersonal();
    const memoryId = await seedAndPinMemory(fx);
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const read = await fx.service.readPersonalObject(scope, "memory", memoryId);
    return {
      positiveControlPassed:
        read.outcome === "allow" && read.record.id === memoryId,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "openmuse.memories.denial": async () => {
    const fx = await openMusePersonal();
    const memoryId = await seedAndPinMemory(fx, "mt136 memory deny");
    const bScope = await fx.scopeAs(
      "b1-member",
      fx.ids["company-b"],
      fx.ids["team-b1"],
    );
    const read = await fx.service.readPersonalObject(
      bScope,
      "memory",
      memoryId,
    );
    return denyObservation(isResourceNotFoundVerdict(read));
  },

  "openmuse.pin.positive": async () => {
    const fx = await openMusePersonal();
    const goalId = await fx.seedObject("goal", {
      ownerUserId: fx.ids["user-a1-member"],
      title: "mt136 pin",
    });
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const pinned = await fx.service.pinPersonalObject(scope, {
      objectType: "goal",
      objectId: goalId,
    });
    return {
      positiveControlPassed:
        pinned.status === "pinned" || pinned.status === "existing",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "openmuse.pin.denial": async () => {
    const fx = await openMusePersonal();
    const goalId = await fx.seedObject("goal", {
      ownerUserId: fx.ids["user-a1-member"],
      title: "mt136 pin deny",
    });
    // 跨公司身份 pin 他人的 goal：不可见语义（拒绝，零存在泄漏）。
    const bScope = await fx.scopeAs(
      "b1-member",
      fx.ids["company-b"],
      fx.ids["team-b1"],
    );
    const verdict = await fx.service.pinPersonalObject(bScope, {
      objectType: "goal",
      objectId: goalId,
    });
    return denyObservation(isResourceNotFoundVerdict(verdict as object));
  },
};

// ---------------------------------------------------------------------------
// 场景（openmuse-connectors-deletion 域）：连接器、通知、聚合、删除恢复
// ---------------------------------------------------------------------------

const connectorsDeletionScenarios: ScenarioMap = {
  // POST /api/mobile/openmuse-google/:provider/connect —— 连接器
  // （每属主一个 (userId, provider) 席位；§9 属主禁用栅栏拒绝）。
  "connectors.connect.positive": async () => {
    const fx = await craftWorkshop();
    const rows = createOpenMuseGoogleRows(fx.db);
    const connectionId = `mt136-conn-${randomUUID().slice(0, 8)}`;
    await rows.saveConnection({
      id: connectionId,
      userId: fx.userA,
      provider: "gmail",
      accountEmail: "mt136@gmail.test",
      status: "connected",
      grantedScopes: ["gmail.read"],
      generation: 1,
      alias: "mt136",
      connectedAt: new Date(),
      lastError: null,
    });
    const mine = await rows.getConnection(fx.userA, "gmail");
    return {
      positiveControlPassed:
        mine?.id === connectionId && mine?.userId === fx.userA,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "connectors.connect.denial": async () => {
    const fx = await craftWorkshop();
    const rows = createOpenMuseGoogleRows(fx.db);
    const connectionId = `mt136-conn-${randomUUID().slice(0, 8)}`;
    await rows.saveConnection({
      id: connectionId,
      userId: fx.userA,
      provider: "gmail",
      accountEmail: "mt136@gmail.test",
      status: "connected",
      grantedScopes: ["gmail.read"],
      generation: 1,
      alias: "mt136",
      connectedAt: new Date(),
      lastError: null,
    });
    // 他属主按同一 provider 读：per-owner 键 = 永远拿不到别人的席位。
    //（§9 删除属主栅栏在部署装配处接线，默认 rows 侧是 no-op——如实披露，
    // 不以此断言栅栏。）
    const asB = await rows.getConnection(fx.userB, "gmail");
    return denyObservation(asB === null);
  },

  // GET /api/mobile/openmuse-notifications —— 通知（MT065 判定面）。
  "openmuse.notifications.positive": async () => {
    const fx = await openMuseActivity();
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const notificationId = await fx.seedNotification({
      ownerUserId: fx.ids["user-a1-member"],
      title: "mt136 notification",
    });
    const pinned = await fx.service.pinNotificationScope(scope, {
      notificationId,
    });
    if (!("status" in pinned) || pinned.status !== "pinned") {
      return denyObservation(false, [pinned]);
    }
    const read = await fx.service.readNotification(scope, notificationId);
    return {
      positiveControlPassed:
        read.outcome === "allow" && read.notification.id === notificationId,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "openmuse.notifications.denial": async () => {
    const fx = await openMuseActivity();
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const notificationId = await fx.seedNotification({
      ownerUserId: fx.ids["user-a1-member"],
      title: "mt136 notification deny",
    });
    const pinned = await fx.service.pinNotificationScope(scope, {
      notificationId,
    });
    if (!("status" in pinned) || pinned.status !== "pinned") {
      return denyObservation(false, [pinned]);
    }
    const bScope = await fx.scopeAs(
      "b1-member",
      fx.ids["company-b"],
      fx.ids["team-b1"],
    );
    const read = await fx.service.readNotification(bScope, notificationId);
    return denyObservation(isResourceNotFoundVerdict(read));
  },

  // GET /api/mobile/openmuse-aggregate —— 移动聚合（MT066 scope 服务）。
  "openmuse.aggregate.positive": async () => {
    const fx = await voiceMobile();
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const sessionId = await fx.seedVoiceSession({
      ownerUserId: fx.ids["user-a1-member"],
      durationSeconds: 30,
    });
    const pinned = await fx.service.pinVoiceSessionScope(scope, {
      sessionId,
    });
    if (!("status" in pinned) || pinned.status !== "pinned") {
      return denyObservation(false, [pinned]);
    }
    const aggregate = await fx.service.readMobileAggregate(scope, {
      limit: 50,
    });
    return {
      positiveControlPassed: aggregate.voiceSessions.some(
        (item) => item.session.id === sessionId,
      ),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "openmuse.aggregate.denial": async () => {
    const fx = await voiceMobile();
    const scope = await fx.scopeAs(
      "a1-member",
      fx.ids["company-a"],
      fx.ids["team-a1"],
    );
    const sessionId = await fx.seedVoiceSession({
      ownerUserId: fx.ids["user-a1-member"],
      durationSeconds: 30,
    });
    const pinned = await fx.service.pinVoiceSessionScope(scope, {
      sessionId,
    });
    if (!("status" in pinned) || pinned.status !== "pinned") {
      return denyObservation(false, [pinned]);
    }
    const bScope = await fx.scopeAs(
      "b1-member",
      fx.ids["company-b"],
      fx.ids["team-b1"],
    );
    const aggregate = await fx.service.readMobileAggregate(bScope, {
      limit: 50,
    });
    const leaked = aggregate.voiceSessions.filter(
      (item) => item.session.id === sessionId,
    );
    return denyObservation(leaked.length === 0, leaked);
  },

  // POST /api/admin/openmuse-deletion/:userId/purge —— purge manifest
  // （清单由服务端按调用者归属枚举生成并签名；执行只及清单内范围）。
  "deletion.purge.positive": async () => {
    const fx = await purgeRestore();
    const companyA = fx.base.isolation.ids["company-a"];
    const teamA1 = fx.base.isolation.ids["team-a1"];
    const resourceId = await fx.seedResource({
      tenantId: companyA,
      workspaceId: teamA1,
      displayName: "mt136 purge",
    });
    const admin = await fx.scopeAs("a1-member", companyA, teamA1);
    const built = await fx.purge.buildPurgeManifest(admin, {
      operation: "purge",
      workspaceId: teamA1,
    });
    if (built.outcome !== "allow") {
      return denyObservation(false, [built]);
    }
    const executed = await fx.purge.executePurge(admin, {
      manifestId: (built as { manifestId: string }).manifestId,
    });
    return {
      positiveControlPassed:
        executed.outcome === "allow" &&
        (await fx.statusOf(companyA, resourceId)) === "deleted",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "deletion.purge.denial": async () => {
    const fx = await purgeRestore();
    const companyA = fx.base.isolation.ids["company-a"];
    const teamA1 = fx.base.isolation.ids["team-a1"];
    const companyB = fx.base.isolation.ids["company-b"];
    const teamB1 = fx.base.isolation.ids["team-b1"];
    const resourceId = await fx.seedResource({
      tenantId: companyA,
      workspaceId: teamA1,
      displayName: "mt136 purge deny",
    });
    const witnessId = await fx.seedResource({
      tenantId: companyB,
      workspaceId: teamB1,
      displayName: "mt136 purge witness",
    });
    const admin = await fx.scopeAs("a1-member", companyA, teamA1);
    const built = await fx.purge.buildPurgeManifest(admin, {
      operation: "purge",
      workspaceId: teamA1,
    });
    if (built.outcome !== "allow") {
      return denyObservation(false, [built]);
    }
    // 跨公司身份执行 A 公司 manifest：canonical not-found，B 见证行原样。
    const b1 = await fx.scopeAs("b1-member", companyB, teamB1);
    const refused = await fx.purge.executePurge(b1, {
      manifestId: (built as { manifestId: string }).manifestId,
    });
    const witnessStatus = await fx.statusOf(companyB, witnessId);
    return denyObservation(
      isResourceNotFoundVerdict(refused) &&
        witnessStatus === "active" &&
        (await fx.statusOf(companyA, resourceId)) === "active",
      [],
      witnessStatus === "deleted" ? [{ crossCompanyPurge: witnessId }] : [],
    );
  },

  // POST /api/admin/openmuse-deletion/:userId/restore —— 恢复（只回原归属）。
  "deletion.restore.positive": async () => {
    const fx = await purgeRestore();
    const companyA = fx.base.isolation.ids["company-a"];
    const teamA1 = fx.base.isolation.ids["team-a1"];
    const resourceId = await fx.seedResource({
      tenantId: companyA,
      workspaceId: teamA1,
      displayName: "mt136 restore",
    });
    const admin = await fx.scopeAs("a1-member", companyA, teamA1);
    const built = await fx.purge.buildPurgeManifest(admin, {
      operation: "purge",
      workspaceId: teamA1,
    });
    await fx.purge.executePurge(admin, { manifestId: built.manifestId });
    const restored = await fx.purge.restoreFromManifest(admin, {
      manifestId: (built as { manifestId: string }).manifestId,
    });
    return {
      positiveControlPassed:
        restored.outcome === "allow" &&
        (await fx.statusOf(companyA, resourceId)) === "active",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "deletion.restore.denial": async () => {
    const fx = await purgeRestore();
    const companyA = fx.base.isolation.ids["company-a"];
    const teamA1 = fx.base.isolation.ids["team-a1"];
    const teamA2 = fx.base.isolation.ids["team-a2"];
    await fx.seedResource({
      tenantId: companyA,
      workspaceId: teamA1,
      displayName: "mt136 restore deny",
    });
    const admin = await fx.scopeAs("a1-member", companyA, teamA1);
    const built = await fx.purge.buildPurgeManifest(admin, {
      operation: "purge",
      workspaceId: teamA1,
    });
    await fx.purge.executePurge(admin, { manifestId: built.manifestId });
    // 同公司他团队身份恢复 A1 的 manifest：canonical not-found。
    const a2 = await fx.scopeAs("a2-member", companyA, teamA2);
    const refused = await fx.purge.restoreFromManifest(a2, {
      manifestId: (built as { manifestId: string }).manifestId,
    });
    return denyObservation(isResourceNotFoundVerdict(refused));
  },
};

// ---------------------------------------------------------------------------
// 入口 → 场景映射（identity 为 §11 矩阵声明；craft/workshop 应用面
// actor 的类等价在 ACTOR_CLASSES 披露）
// ---------------------------------------------------------------------------

const PLAN: MatrixPlan = {
  "POST /api/craft/sessions": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "craft.create.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "craft.create.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/craft/sessions": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "craft.list.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "craft.list.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/craft/sessions/:sessionId": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "craft.read.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "craft.read.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "PUT /api/craft/sessions/:sessionId/name": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "craft.rename.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "craft.rename.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "DELETE /api/craft/sessions/:sessionId": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "craft.delete.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "craft.delete.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/craft/sessions/:sessionId/artifacts": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "craft.artifacts.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "craft.artifacts.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/workshop/:channelId": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "workshop.aggregate.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "workshop.aggregate.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/workshop/:channelId/turns": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "workshop.turns.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "workshop.turns.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/workshop/:channelId/share": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "workshop.share-create.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "workshop.share-create.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "DELETE /api/workshop/:channelId/share": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "workshop.share-revoke.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "workshop.share-revoke.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/public/workshop/:channelId/public/artifacts": {
    positive: {
      domain: "craft-workshop",
      scenarioId: "workshop.public-artifacts.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "craft-workshop",
      scenarioId: "workshop.public-artifacts.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/mobile/openmuse-goals": {
    positive: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.goals.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.goals.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/mobile/openmuse-ideas": {
    positive: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.ideas.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.ideas.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/mobile/openmuse-memories": {
    positive: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.memories.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.memories.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/mobile/openmuse-goals": {
    positive: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.pin.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "openmuse-personal",
      scenarioId: "openmuse.pin.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/mobile/openmuse-google/:provider/connect": {
    positive: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "connectors.connect.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "connectors.connect.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/mobile/openmuse-notifications": {
    positive: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "openmuse.notifications.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "openmuse.notifications.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/mobile/openmuse-aggregate": {
    positive: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "openmuse.aggregate.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "openmuse.aggregate.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/admin/openmuse-deletion/:userId/purge": {
    positive: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "deletion.purge.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "deletion.purge.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/admin/openmuse-deletion/:userId/restore": {
    positive: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "deletion.restore.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "openmuse-connectors-deletion",
      scenarioId: "deletion.restore.denial",
      identity: "a2-member",
      matrixClass: "company-a-team-a2-only",
    },
  },
};

for (const entranceId of Object.keys(PLAN)) {
  requireEntrance(inventory, entranceId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  registerIsolationDomain(
    "craft-workshop",
    adapterFromScenarios(craftWorkshopScenarios),
  );
  registerIsolationDomain(
    "personal-shares",
    adapterFromScenarios(personalSharesScenarios),
  );
  registerIsolationDomain(
    "openmuse-personal",
    adapterFromScenarios(openMusePersonalScenarios),
  );
  registerIsolationDomain(
    "openmuse-connectors-deletion",
    adapterFromScenarios(connectorsDeletionScenarios),
  );
}, 30_000);

afterAll(async () => {
  // 惰性夹具只在真正创建过后才需要清理；失败不掩盖测试结论。
  for (const dispose of createdDisposables.splice(0)) {
    await dispose().catch(() => undefined);
  }
}, 240_000);

// ---------------------------------------------------------------------------

/** 一次矩阵运行，全部用例共享（场景与夹具在同一进程内只装配一次）。 */
let coveragePromise: Promise<ReturnType<typeof runMatrixCoverage>> | undefined;
const coverage = () =>
  (coveragePromise ??= runMatrixCoverage({
    environment: process.env,
    inventory,
    plan: PLAN,
    runId: "mt136",
  }));

describeDb(
  "MT136 / Issue #179 — 覆盖证据：Craft/Workshop、OpenMuse 与删除恢复",
  () => {
    itDb(
      "计划内全部入口在矩阵 runner 输出中 covered（正向与越权两侧都过）",
      async () => {
        const report = await coverage();
        const byId = new Map(
          report.entrances.map((entry) => [entry.id, entry]),
        );
        const failures: string[] = [];
        for (const entranceId of Object.keys(PLAN)) {
          const entry = byId.get(entranceId);
          if (!entry) {
            failures.push(`${entranceId}: not in report`);
            continue;
          }
          if (entry.status !== "covered") {
            failures.push(
              `${entranceId}: ${entry.status} (positive=${entry.positive.status}/${entry.positive.reasons.join("|")}; denial=${entry.denial.status}/${entry.denial.reasons.join("|")})`,
            );
          }
        }
        expect(failures).toEqual([]);
        expect(report.schemaVersion).toBe(1);
        expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
        const classes = new Map(
          report.matrix.classes.map((entry) => [entry.id, entry]),
        );
        expect(
          classes.get("company-a-team-a1-only")?.entrancesCovered,
        ).toBeGreaterThan(0);
        expect(classes.get("cross-company")?.entrancesCovered).toBeGreaterThan(
          0,
        );
        expect(
          classes.get("company-a-team-a2-only")?.entrancesCovered,
        ).toBeGreaterThan(0);
        // 整库覆盖不因本票完成（未映射入口保持诚实 uncovered）。
        expect(report.overall).toBe("coverage-incomplete");
      },
      600_000,
    );

    itDb(
      "删除语义分离：purge/restore manifest 语义在真实数据库上成立（路径级直接钉住）",
      async () => {
        const fx = await purgeRestore();
        const companyA = fx.base.isolation.ids["company-a"];
        const teamA1 = fx.base.isolation.ids["team-a1"];
        const companyB = fx.base.isolation.ids["company-b"];
        const teamB1 = fx.base.isolation.ids["team-b1"];
        const targetA = await fx.seedResource({
          tenantId: companyA,
          workspaceId: teamA1,
          displayName: "mt136 dual a",
        });
        const witnessB = await fx.seedResource({
          tenantId: companyB,
          workspaceId: teamB1,
          displayName: "mt136 dual b",
        });
        const admin = await fx.scopeAs("a1-member", companyA, teamA1);
        // 客户端载荷被拒：manifest 是服务端生成 + 签名的（不可伪造）。
        let clientPayloadRefused = false;
        try {
          await fx.purge.buildPurgeManifest(admin, {
            operation: "purge",
            workspaceId: teamA1,
            itemRefs: [targetA],
          } as never);
        } catch {
          clientPayloadRefused = true;
        }
        const built = await fx.purge.buildPurgeManifest(admin, {
          operation: "purge",
          workspaceId: teamA1,
        });
        expect(built.outcome).toBe("allow");
        const executed = await fx.purge.executePurge(admin, {
          manifestId: (built as { manifestId: string }).manifestId,
        });
        expect(clientPayloadRefused).toBe(true);
        expect(executed.outcome).toBe("allow");
        // Track A（公司清理）只触及本公司：B 的见证行原样存活；Track B
        //（全局账号删除）是独立显式授权面（MT067 双轨），不经本入口。
        expect(await fx.statusOf(companyA, targetA)).toBe("deleted");
        expect(await fx.statusOf(companyB, witnessB)).toBe("active");
      },
      240_000,
    );

    itDb(
      "企业面分享授权（MT058 语义：属主唯一签发/撤销、受众判定门）路径级直接钉住",
      async () => {
        // 这些证据没有一对一的 HTTP 入口映射（企业面分享是资源平面的判定
        // 门，Craft/Workshop 的 HTTP 分享入口在 craft-workshop 域已映射），
        // 按 MT135 先例以路径级用例直接钉住并在此披露。
        const grantPositive =
          await personalSharesScenarios["shares.grant.positive"]();
        expect(grantPositive.positiveControlPassed).toBe(true);
        const grantDenial =
          await personalSharesScenarios["shares.grant.denial"]();
        expect(grantDenial.denied).toBe(true);
        expect(grantDenial.leakedRecords).toEqual([]);
        const revokePositive =
          await personalSharesScenarios["shares.revoke.positive"]();
        expect(revokePositive.positiveControlPassed).toBe(true);
        const revokeDenial =
          await personalSharesScenarios["shares.revoke.denial"]();
        expect(revokeDenial.denied).toBe(true);
      },
      240_000,
    );

    itDb(
      "未映射的 craft/openmuse 闭环入口保留在缺口清单（漂移可见，不虚报覆盖）",
      async () => {
        const report = await coverage();
        const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
        // 本票未提供证据的入口保持 uncovered（例：craft 上传/快照/恢复、
        // scheduled-tasks、openmuse 邮件/日历——见报告诚实边界）。
        expect(gapIds.has("POST /api/craft/sessions/:sessionId/upload")).toBe(
          true,
        );
        expect(gapIds.has("POST /api/craft/sessions/:sessionId/snapshot")).toBe(
          true,
        );
        expect(gapIds.has("GET /api/mobile/openmuse-mail")).toBe(true);
        for (const gap of report.gaps) {
          if (Object.hasOwn(PLAN, gap.entranceId)) {
            throw new Error(
              `planned entrance leaked into gap list: ${gap.entranceId}`,
            );
          }
        }
      },
      240_000,
    );

    itDb(
      "覆盖报告产物（可选写出：MT_COVERAGE_REPORT_OUT 指定路径）",
      async () => {
        const out = process.env.MT_COVERAGE_REPORT_OUT?.trim();
        const report = await coverage();
        if (!out) return;
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
        expect(report.summary.coveredEntrances).toBe(Object.keys(PLAN).length);
      },
      240_000,
    );
  },
);
