// server/tests/multitenancy/coverage-bots-conversations.test.ts
// MT133（Issue #176）：覆盖证据——Bot、会话与附件。
//
// 用 MT131 系验收产物（MT132 身份矩阵 runner）为 Bot 创建/发布/使用/生命
// 周期与附件上传/签发/清理、企业会话列表与消息的逐入口正向与越权证据：
// 每个入口的两侧都经真实域夹具（MT016/MT017/MT019/MT024/MT021/MT022 的
// 真实服务 + 真实受限角色 + 真实 RLS）执行，覆盖状态在矩阵 runner 输出中
// 标记为 covered。夹具身份到 §11 矩阵类的等价在 ACTOR_CLASSES 表中逐条
// 披露（矩阵身份是 §11 的类载体，域夹具身份是同角色的本域实现）。
//
// 环境契约：只认显式 TEST_DATABASE_URL（或 ENTERPRISE_TEST_SETUP_
// DATABASE_URL）加三个受限角色 URL；缺配置时整套显式 skip（跳过原因写在
// 用例名里，skipped 不计为通过），绝不回退开发库。
//
// 证据可复现（票面 AC3）：本套件即复现命令——
//   set +x; source /tmp/mt24-env.sh && bun --no-env-file test \
//     server/tests/multitenancy/coverage-bots-conversations.test.ts
// （夹具、场景与矩阵 runner 全在同一进程内真实执行。）

import { randomUUID } from "node:crypto";
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
import type { PlatformScope } from "../../src/enterprise/contracts";
import { isResourceNotFoundVerdict } from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type AttachmentFixture,
  createAttachmentFixture,
} from "./support/attachments";
import {
  type BotLifecycleFixture,
  createBotLifecycleFixture,
} from "./support/bot-lifecycle";
import {
  type ConversationActionsFixture,
  createConversationActionsFixture,
} from "./support/conversation-actions";
import {
  adapterFromScenarios,
  requireEntrance,
  type ScenarioMap,
} from "./support/coverage-matrix";
import type { IsolationObservation } from "./support/scenarios";
import { registerIsolationDomain } from "./support/scenarios";

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
      reason: `MT133 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
 * 夹具身份 → §11 矩阵类等价表（披露，非推导）。每个场景的真实 actor 在
 * 场景实现处注明；这里钉住等价关系，供计划声明与实现互相对账。
 */
const ACTOR_CLASSES = {
  "a1-owner": "company-a-team-a1-only",
  "a1-member": "same-team-other-person",
  "a1-other": "same-team-other-person",
  "a2-member": "company-a-team-a2-only",
  "b1-member": "cross-company",
} as const;

let bots: BotLifecycleFixture;
let attachments: AttachmentFixture;
let conversations: ConversationActionsFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamB1 = "";
let botCounter = 0;

const nextBotId = () => {
  botCounter += 1;
  return `mt133-bot-${String(botCounter).padStart(3, "0")}-${randomUUID().slice(0, 8)}`;
};

/** 建一个 A1 归属 Bot（owner = a1-owner，即矩阵「仅属甲」类载体）。 */
async function createA1Bot(publish = false): Promise<string> {
  const agentId = nextBotId();
  const scope = await bots.scopeAs("a1-owner", companyA, teamA1);
  const created = await bots.ownership.createBot(scope, {
    agentId,
    displayName: `MT133 bot ${agentId}`,
    defaultConfig: { model: "gpt-4o" },
  });
  if (created.outcome !== "allow") {
    throw new Error(
      `MT133 arrangement create failed: ${JSON.stringify(created)}`,
    );
  }
  if (publish) {
    const verdict = await bots.publish.publishBot(scope, agentId, {
      type: "team",
      tenantId: companyA,
      workspaceId: teamA1,
    });
    if (verdict.outcome !== "allow") {
      throw new Error(
        `MT133 arrangement publish failed: ${JSON.stringify(verdict)}`,
      );
    }
  }
  return agentId;
}

const scopeRefused = async (run: () => Promise<unknown>): Promise<boolean> => {
  try {
    await run();
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /FORBIDDEN|REVOKED|REQUIRED/.test(message);
  }
};

const denyObservation = (
  denied: boolean,
  leaks: unknown[] = [],
): IsolationObservation => ({
  positiveControlPassed: false,
  denied,
  leakedRecords: leaks,
  forbiddenEffects: [],
});

// ---------------------------------------------------------------------------
// 场景（bots 域）：每条都是真实授权路径上的事实
// ---------------------------------------------------------------------------

const botsScenarios: ScenarioMap = {
  // POST /api/agents —— 创建。actor: a1-owner（仅属甲）。
  "bots.create.positive": async () => {
    const agentId = await createA1Bot();
    // 跨公司探针：B 公司数据角色视角绝看不到新归属行。
    const leaked = (await bots.readOwnershipRowsAsData(companyB)).filter(
      (row) => row.agentId === agentId,
    );
    return {
      positiveControlPassed: true,
      denied: false,
      leakedRecords: leaked,
      forbiddenEffects: [],
    };
  },
  "bots.create.denial": async () => {
    // 跨公司身份对公司 A 的团队签发 scope：资格门拒绝（TENANT_FORBIDDEN）。
    const denied = await scopeRefused(() =>
      bots.scopeAs("b1-member", companyA, teamA1),
    );
    return denyObservation(denied);
  },

  // PUT /api/team-bots/:botId/publication —— 发布（owner 动作）。
  "bots.publish.positive": async () => {
    const agentId = await createA1Bot();
    const verdict = await bots.publish.publishBot(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
      { type: "team", tenantId: companyA, workspaceId: teamA1 },
    );
    return {
      positiveControlPassed: verdict.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.publish.denial": async () => {
    const agentId = await createA1Bot(true);
    // 同团队使用者（非 owner）发布他人的 Bot：deny。
    const verdict = await bots.publish.publishBot(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      { type: "team", tenantId: companyA, workspaceId: teamA1 },
    );
    return denyObservation(verdict.outcome === "deny");
  },

  // DELETE /api/team-bots/:botId/publication —— 取消发布（owner 动作）。
  "bots.unpublish.positive": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.publish.unpublishBot(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
    );
    return {
      positiveControlPassed: verdict.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.unpublish.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.publish.unpublishBot(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
    );
    return denyObservation(verdict.outcome === "deny");
  },

  // GET /api/team-bots —— 使用（read）：已发布团队 Bot 对成员可见。
  "bots.usage-read.positive": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.actions.decideAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "read",
    );
    return {
      positiveControlPassed: verdict.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.usage-read.denial": async () => {
    const agentId = await createA1Bot(true);
    // 跨公司身份在本公司团队上下文里读 A 公司 Bot：canonical not-found。
    const verdict = await bots.actions.decideAction(
      await bots.scopeAs("b1-member", companyB, teamB1),
      agentId,
      "read",
    );
    return denyObservation(isResourceNotFoundVerdict(verdict as object));
  },

  // POST /api/route —— 使用：Bot 路由执行。
  "bots.usage-run.positive": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.actions.decideAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "run",
    );
    return {
      positiveControlPassed: verdict.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.usage-run.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.actions.decideAction(
      await bots.scopeAs("b1-member", companyB, teamB1),
      agentId,
      "run",
    );
    return denyObservation(isResourceNotFoundVerdict(verdict as object));
  },

  // POST /api/agents/:agentId/duplicate —— 复制（真实执行：新归属行归发起者）。
  "bots.duplicate.positive": async () => {
    const agentId = await createA1Bot();
    const execution = await bots.lifecycle.executeLifecycleAction(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
      "duplicate",
      { newAgentId: `${agentId}-copy` },
    );
    return {
      positiveControlPassed: execution.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.duplicate.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.lifecycle.decideLifecycleAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "duplicate",
    );
    return denyObservation(verdict.outcome === "deny");
  },

  // POST /api/agents/:agentId/hide —— 隐藏（owner 放行；使用者拒绝）。
  "bots.hide.positive": async () => {
    const agentId = await createA1Bot();
    const verdict = await bots.lifecycle.decideLifecycleAction(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
      "hide",
    );
    return {
      positiveControlPassed: verdict.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.hide.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.lifecycle.decideLifecycleAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "hide",
    );
    return denyObservation(verdict.outcome === "deny");
  },

  // POST/GET /api/bots/:agentId/reset —— 重置（真实执行：defaultConfig 清空）。
  "bots.reset.positive": async () => {
    const agentId = await createA1Bot();
    const execution = await bots.lifecycle.executeLifecycleAction(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
      "reset",
    );
    return {
      positiveControlPassed: execution.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.reset.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.lifecycle.decideLifecycleAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "reset",
    );
    return denyObservation(verdict.outcome === "deny");
  },

  // DELETE /api/agents/:agentId —— 删除。
  "bots.delete.positive": async () => {
    const agentId = await createA1Bot();
    const execution = await bots.lifecycle.executeLifecycleAction(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
      "delete",
    );
    return {
      positiveControlPassed: execution.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.delete.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.lifecycle.decideLifecycleAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "delete",
    );
    // 使用者删除 = BOT_LIFECYCLE_FORBIDDEN；跨公司视角 = canonical not-found。
    const crossView = await bots.ownership.getBot(
      await bots.scopeAs("b1-member", companyB, teamB1),
      agentId,
    );
    return denyObservation(
      verdict.outcome === "deny" &&
        isResourceNotFoundVerdict(crossView as object),
    );
  },

  // PATCH /api/agents/:agentId —— 模板更新（真实执行：配置替换）。
  "bots.template-update.positive": async () => {
    const agentId = await createA1Bot();
    const execution = await bots.lifecycle.executeLifecycleAction(
      await bots.scopeAs("a1-owner", companyA, teamA1),
      agentId,
      "template-update",
      { defaultConfig: { model: "claude-fable-5-1" } },
    );
    return {
      positiveControlPassed: execution.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "bots.template-update.denial": async () => {
    const agentId = await createA1Bot(true);
    const verdict = await bots.lifecycle.decideLifecycleAction(
      await bots.scopeAs("a1-member", companyA, teamA1),
      agentId,
      "template-update",
    );
    return denyObservation(verdict.outcome === "deny");
  },
};

// ---------------------------------------------------------------------------
// 场景（conversations 域）：附件三动作 + 会话列表与消息
// ---------------------------------------------------------------------------

const conversationsScenarios: ScenarioMap = {
  // POST /api/channels/:channelId/attachments —— 暂存上传。
  "attachments.upload.positive": async () => {
    const staged = await attachments.attachments.stageUpload(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      { filename: "mt133.pdf", sizeBytes: 512 },
    );
    const leaked =
      staged.outcome === "allow"
        ? (
            await attachments.readAttachmentRowsAsData(attachments.companyB)
          ).filter(
            (row) =>
              row.id === (staged as { attachmentId: string }).attachmentId,
          )
        : [];
    return {
      positiveControlPassed: staged.outcome === "allow",
      denied: false,
      leakedRecords: leaked,
      forbiddenEffects: [],
    };
  },
  "attachments.upload.denial": async () => {
    // 跨公司身份对公司 A 团队签发 scope：资格门拒绝。
    const denied = await scopeRefused(() =>
      attachments.scopeAs(
        "b1-member",
        attachments.companyA,
        attachments.teamA1,
      ),
    );
    return denyObservation(denied);
  },

  // GET /api/attachments/:id —— 下载签发。
  "attachments.issue.positive": async () => {
    const staged = await attachments.attachments.stageUpload(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      { filename: "mt133-issue.pdf", sizeBytes: 256 },
    );
    if (staged.outcome !== "allow") {
      return {
        positiveControlPassed: false,
        denied: false,
        leakedRecords: [{ staged }],
        forbiddenEffects: [],
      };
    }
    const issued = await attachments.attachments.issueDownloadUrl(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      staged.attachmentId,
      { ttlSeconds: 300 },
    );
    return {
      positiveControlPassed: issued.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "attachments.issue.denial": async () => {
    const staged = await attachments.attachments.stageUpload(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      { filename: "mt133-deny.pdf", sizeBytes: 256 },
    );
    if (staged.outcome !== "allow") {
      return denyObservation(false, [{ staged }]);
    }
    // 跨公司与跨团队请求下载：canonical not-found（不泄露存在性）。
    const fromB = await attachments.attachments.issueDownloadUrl(
      await attachments.scopeAs(
        "b1-member",
        attachments.companyB,
        attachments.teamB1,
      ),
      staged.attachmentId,
      { ttlSeconds: 60 },
    );
    const fromA2 = await attachments.attachments.issueDownloadUrl(
      await attachments.scopeAs(
        "a2-member",
        attachments.companyA,
        attachments.teamA2,
      ),
      staged.attachmentId,
      { ttlSeconds: 60 },
    );
    return denyObservation(
      isResourceNotFoundVerdict(fromB as object) &&
        isResourceNotFoundVerdict(fromA2 as object),
    );
  },

  // DELETE /api/attachments/:id —— 清理/撤销（只触及本归属范围）。
  "attachments.cleanup.positive": async () => {
    const staged = await attachments.attachments.stageUpload(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      { filename: "mt133-clean.pdf", sizeBytes: 128 },
    );
    if (staged.outcome !== "allow") {
      return {
        positiveControlPassed: false,
        denied: false,
        leakedRecords: [{ staged }],
        forbiddenEffects: [],
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const cleaned = await attachments.attachments.cleanupStaleUploads(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      { olderThanSeconds: 0 },
    );
    const cleanedIds =
      cleaned.outcome === "allow"
        ? (cleaned as { cleaned: string[] }).cleaned
        : [];
    return {
      positiveControlPassed: cleanedIds.includes(staged.attachmentId),
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "attachments.cleanup.denial": async () => {
    const staged = await attachments.attachments.stageUpload(
      await attachments.scopeAs(
        "a1-owner",
        attachments.companyA,
        attachments.teamA1,
      ),
      { filename: "mt133-cross.pdf", sizeBytes: 128 },
    );
    if (staged.outcome !== "allow") {
      return denyObservation(false, [{ staged }]);
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // A2 团队身份的清理绝不触及 A1 的行：行完好即越权未遂的事实。
    const cleaned = await attachments.attachments.cleanupStaleUploads(
      await attachments.scopeAs(
        "a2-member",
        attachments.companyA,
        attachments.teamA2,
      ),
      { olderThanSeconds: 0 },
    );
    const cleanedIds =
      cleaned.outcome === "allow"
        ? (cleaned as { cleaned: string[] }).cleaned
        : [];
    const rows = await attachments.readAttachmentRowsAsData(
      attachments.companyA,
    );
    const survivor = rows.find((row) => row.id === staged.attachmentId);
    const touchedForeign = cleanedIds.includes(staged.attachmentId);
    return {
      positiveControlPassed: false,
      denied: !touchedForeign,
      leakedRecords: touchedForeign
        ? [{ attachmentId: staged.attachmentId }]
        : [],
      forbiddenEffects: touchedForeign
        ? [{ crossTeamCleanup: staged.attachmentId }]
        : survivor
          ? []
          : [{ rowVanished: staged.attachmentId }],
    };
  },

  // GET /api/enterprise/conversations —— 本人会话列表。
  "conversations.list.positive": async () => {
    const threadId = `mt133-thread-${randomUUID().slice(0, 8)}`;
    const conversationId = randomUUID();
    await conversations.seedConversation({
      conversationId,
      tenantId: conversations.ids["company-a"],
      workspaceId: conversations.ids["team-a1"],
      principalId: conversations.ids["principal-a1-member"],
      threadId,
      title: "MT133 list",
      createdAt: new Date(),
    });
    const scope: PlatformScope = await conversations.scopeAs(
      "a1-member",
      conversations.ids["company-a"],
      conversations.ids["team-a1"],
    );
    const page = await conversations.listService.listVisibleConversations(
      scope,
      { limit: 50 },
    );
    const seen = page.items.some((item) => item.threadId === threadId);
    return {
      positiveControlPassed: seen,
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "conversations.list.denial": async () => {
    const threadId = `mt133-thread-${randomUUID().slice(0, 8)}`;
    await conversations.seedConversation({
      conversationId: randomUUID(),
      tenantId: conversations.ids["company-a"],
      workspaceId: conversations.ids["team-a1"],
      principalId: conversations.ids["principal-a1-member"],
      threadId,
      title: "MT133 deny",
      createdAt: new Date(),
    });
    // 跨公司列表看不到该线程（不可见对象不占页位、不进列表）。
    const page = await conversations.listService.listVisibleConversations(
      await conversations.scopeAs(
        "b1-member",
        conversations.ids["company-b"],
        conversations.ids["team-b1"],
      ),
      { limit: 50 },
    );
    const leakedItems = page.items.filter((item) => item.threadId === threadId);
    return {
      positiveControlPassed: false,
      denied: leakedItems.length === 0,
      leakedRecords: leakedItems,
      forbiddenEffects: [],
    };
  },

  // GET /api/enterprise/conversations/:threadId/messages —— 时间线读取。
  "conversations.messages-read.positive": async () => {
    const threadId = `mt133-thread-${randomUUID().slice(0, 8)}`;
    await conversations.seedConversation({
      conversationId: randomUUID(),
      tenantId: conversations.ids["company-a"],
      workspaceId: conversations.ids["team-a1"],
      principalId: conversations.ids["principal-a1-member"],
      threadId,
      title: "MT133 read",
      createdAt: new Date(),
    });
    const read = await conversations.service.readMessages(
      await conversations.scopeAs(
        "a1-member",
        conversations.ids["company-a"],
        conversations.ids["team-a1"],
      ),
      { threadId, limit: 10 },
    );
    return {
      positiveControlPassed: read.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "conversations.messages-read.denial": async () => {
    const threadId = `mt133-thread-${randomUUID().slice(0, 8)}`;
    await conversations.seedConversation({
      conversationId: randomUUID(),
      tenantId: conversations.ids["company-a"],
      workspaceId: conversations.ids["team-a1"],
      principalId: conversations.ids["principal-a1-member"],
      threadId,
      title: "MT133 read deny",
      createdAt: new Date(),
    });
    const fromB = await conversations.service.readMessages(
      await conversations.scopeAs(
        "b1-member",
        conversations.ids["company-b"],
        conversations.ids["team-b1"],
      ),
      { threadId, limit: 10 },
    );
    return denyObservation(isResourceNotFoundVerdict(fromB as object));
  },

  // POST /api/enterprise/conversations/:threadId/messages —— 消息发送。
  "conversations.messages-send.positive": async () => {
    const threadId = `mt133-thread-${randomUUID().slice(0, 8)}`;
    await conversations.seedConversation({
      conversationId: randomUUID(),
      tenantId: conversations.ids["company-a"],
      workspaceId: conversations.ids["team-a1"],
      principalId: conversations.ids["principal-a1-member"],
      threadId,
      title: "MT133 send",
      createdAt: new Date(),
    });
    const sent = await conversations.service.sendMessage(
      await conversations.scopeAs(
        "a1-member",
        conversations.ids["company-a"],
        conversations.ids["team-a1"],
      ),
      {
        threadId,
        clientMessageKey: `mt133-${randomUUID().slice(0, 8)}`,
        content: "mt133 positive",
      },
    );
    return {
      positiveControlPassed: sent.outcome === "allow",
      denied: false,
      leakedRecords: [],
      forbiddenEffects: [],
    };
  },
  "conversations.messages-send.denial": async () => {
    const threadId = `mt133-thread-${randomUUID().slice(0, 8)}`;
    await conversations.seedConversation({
      conversationId: randomUUID(),
      tenantId: conversations.ids["company-a"],
      workspaceId: conversations.ids["team-a1"],
      principalId: conversations.ids["principal-a1-member"],
      threadId,
      title: "MT133 send deny",
      createdAt: new Date(),
    });
    const before = await conversations.listMessageRowsAsData(
      conversations.ids["company-a"],
    );
    const fromB = await conversations.service.sendMessage(
      await conversations.scopeAs(
        "b1-member",
        conversations.ids["company-b"],
        conversations.ids["team-b1"],
      ),
      {
        threadId,
        clientMessageKey: `mt133-${randomUUID().slice(0, 8)}`,
        content: "mt133 unauthorized",
      },
    );
    const after = await conversations.listMessageRowsAsData(
      conversations.ids["company-a"],
    );
    return denyObservation(
      isResourceNotFoundVerdict(fromB as object) &&
        after.length === before.length,
    );
  },
};

/** 入口 → 场景映射（每入口两侧都必须在位；identity 为 §11 矩阵声明）。 */
const PLAN: MatrixPlan = {
  "POST /api/agents": {
    positive: {
      domain: "bots",
      scenarioId: "bots.create.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.create.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "PUT /api/team-bots/:botId/publication": {
    positive: {
      domain: "bots",
      scenarioId: "bots.publish.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.publish.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "DELETE /api/team-bots/:botId/publication": {
    positive: {
      domain: "bots",
      scenarioId: "bots.unpublish.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.unpublish.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "GET /api/team-bots": {
    positive: {
      domain: "bots",
      scenarioId: "bots.usage-read.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.usage-read.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/route": {
    positive: {
      domain: "bots",
      scenarioId: "bots.usage-run.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.usage-run.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/agents/:agentId/duplicate": {
    positive: {
      domain: "bots",
      scenarioId: "bots.duplicate.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.duplicate.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "POST /api/agents/:agentId/hide": {
    positive: {
      domain: "bots",
      scenarioId: "bots.hide.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.hide.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "POST /api/bots/:agentId/reset": {
    positive: {
      domain: "bots",
      scenarioId: "bots.reset.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.reset.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "GET /api/bots/:agentId/reset": {
    positive: {
      domain: "bots",
      scenarioId: "bots.reset.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.reset.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "DELETE /api/agents/:agentId": {
    positive: {
      domain: "bots",
      scenarioId: "bots.delete.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.delete.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "PATCH /api/agents/:agentId": {
    positive: {
      domain: "bots",
      scenarioId: "bots.template-update.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "bots",
      scenarioId: "bots.template-update.denial",
      identity: "a1-other",
      matrixClass: "same-team-other-person",
    },
  },
  "POST /api/channels/:channelId/attachments": {
    positive: {
      domain: "conversations",
      scenarioId: "attachments.upload.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "conversations",
      scenarioId: "attachments.upload.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/attachments/:id": {
    positive: {
      domain: "conversations",
      scenarioId: "attachments.issue.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "conversations",
      scenarioId: "attachments.issue.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "DELETE /api/attachments/:id": {
    positive: {
      domain: "conversations",
      scenarioId: "attachments.cleanup.positive",
      identity: "a1-member",
      matrixClass: ACTOR_CLASSES["a1-owner"],
    },
    denial: {
      domain: "conversations",
      scenarioId: "attachments.cleanup.denial",
      identity: "a2-member",
      matrixClass: "company-a-team-a2-only",
    },
  },
  "GET /api/enterprise/conversations": {
    positive: {
      domain: "conversations",
      scenarioId: "conversations.list.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "conversations",
      scenarioId: "conversations.list.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "GET /api/enterprise/conversations/:threadId/messages": {
    positive: {
      domain: "conversations",
      scenarioId: "conversations.messages-read.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "conversations",
      scenarioId: "conversations.messages-read.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
  "POST /api/enterprise/conversations/:threadId/messages": {
    positive: {
      domain: "conversations",
      scenarioId: "conversations.messages-send.positive",
      identity: "a1-member",
      matrixClass: "company-a-team-a1-only",
    },
    denial: {
      domain: "conversations",
      scenarioId: "conversations.messages-send.denial",
      identity: "b1-member",
      matrixClass: "cross-company",
    },
  },
};

for (const entranceId of Object.keys(PLAN)) {
  requireEntrance(inventory, entranceId);
}

beforeAll(async () => {
  if (!ENV.ok) return;
  bots = await createBotLifecycleFixture();
  companyA = bots.ids["company-a"];
  companyB = bots.ids["company-b"];
  teamA1 = bots.ids["team-a1"];
  teamB1 = bots.ids["team-b1"];
  // 公司 A 翻到 workspace-v1（团队公共使用语义生效；MT017/MT019 同款披露
  // stand-in——判定侧从不使用该通道）。
  await bots.setTenantPolicyRevision(companyA, "workspace-v1");
  attachments = await createAttachmentFixture();
  conversations = await createConversationActionsFixture();
  registerIsolationDomain("bots", adapterFromScenarios(botsScenarios));
  registerIsolationDomain(
    "conversations",
    adapterFromScenarios(conversationsScenarios),
  );
}, 180000);

afterAll(async () => {
  if (conversations) await conversations.dispose();
  if (attachments) await attachments.dispose();
  if (bots) await bots.dispose();
}, 120000);

// ---------------------------------------------------------------------------

/** 一次矩阵运行，全部用例共享（场景与夹具在同一进程内只装配一次）。 */
let coveragePromise: Promise<ReturnType<typeof runMatrixCoverage>> | undefined;
const coverage = () =>
  (coveragePromise ??= runMatrixCoverage({
    environment: process.env,
    inventory,
    plan: PLAN,
    runId: "mt133",
  }));

describeDb("MT133 / Issue #176 — 覆盖证据：Bot、会话与附件", () => {
  itDb(
    "计划内全部入口在矩阵 runner 输出中 covered（正向与越权两侧都过）",
    async () => {
      const report = await coverage();
      const byId = new Map(report.entrances.map((entry) => [entry.id, entry]));
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
      // 覆盖状态机器可读（AC4）：JSON 往返 + 矩阵类随报告走。
      expect(report.schemaVersion).toBe(1);
      expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
      const classes = new Map(
        report.matrix.classes.map((entry) => [entry.id, entry]),
      );
      expect(
        classes.get("company-a-team-a1-only")?.entrancesCovered,
      ).toBeGreaterThan(0);
      expect(
        classes.get("same-team-other-person")?.entrancesCovered,
      ).toBeGreaterThan(0);
      expect(classes.get("cross-company")?.entrancesCovered).toBeGreaterThan(0);
      expect(
        classes.get("company-a-team-a2-only")?.entrancesCovered,
      ).toBeGreaterThan(0);
      // 整库覆盖不因本票完成（未映射入口保持诚实 uncovered）。
      expect(report.overall).toBe("coverage-incomplete");
    },
    240000,
  );

  itDb(
    "证据可复现：全程受限角色在场（决策路径不经过超级用户）",
    async () => {
      const calls = [
        ...bots.restrictedCalls(),
        ...attachments.restrictedCalls(),
        ...conversations.restrictedCalls(),
      ];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.currentUser).toMatch(/^ob_ent_(data|operator|directory)$/);
      }
    },
    60000,
  );

  itDb(
    "未映射的 bot/会话闭环入口保留在缺口清单（漂移可见，不虚报覆盖）",
    async () => {
      const report = await coverage();
      const gapIds = new Set(report.gaps.map((gap) => gap.entranceId));
      // 本票未提供证据的入口保持 uncovered（例：pin/unpin、callback-token、
      // 会话创建——见报告诚实边界）。
      expect(gapIds.has("POST /api/agents/:agentId/pin")).toBe(true);
      expect(gapIds.has("POST /api/agents/:agentId/callback-token")).toBe(true);
      expect(gapIds.has("POST /api/enterprise/conversations")).toBe(true);
      for (const gap of report.gaps) {
        if (Object.hasOwn(PLAN, gap.entranceId)) {
          throw new Error(
            `planned entrance leaked into gap list: ${gap.entranceId}`,
          );
        }
      }
    },
    240000,
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
    240000,
  );
});
