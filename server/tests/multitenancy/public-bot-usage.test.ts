// server/tests/multitenancy/public-bot-usage.test.ts
// MT018（Issue #61）：使用团队公共 Bot 时保持使用者自己的会话与凭据。
//
// 验收事实源（Issue #61 四条，逐条对应 describe；真实 PostgreSQL，全程受限
// ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   验收 1：使用者运行公共 Bot 产生的会话归其个人所有，创建者看不到该
//     会话内容（MT021 个人会话可见性原样成立——会话主体 = 使用者）。
//   验收 2：运行过程中使用的是使用者自己的连接与凭据；缺少个人凭据时
//     按既有规则请求授权（authorization-required 指明缺失 ref），而不是
//     借用创建者的（创建者同名 target 凭据绝不被选中）。
//   验收 3：创建者的个人凭据、个人会话不因发布公共 Bot 而对使用者可见
//     （运行入口输出形状零创建者材料 + MT027/MT021 个人面原样）。
//   验收 4：多团队成员并发使用同一公共 Bot 时状态不串用（threadId 内嵌
//     使用者主体；同一成员重入幂等复用自己的会话；浏览器/沙箱状态引用
//     属 MT052，不在本票）。
//
// 结构决策（见 checkpoints/MT018/PLAN.md）：运行入口 = 准入判定服务；
// MT009 run 门（版本门/发布事实/依赖有效性/唯一拒绝形状）组合原样承载、
// deny 变体逐字透传（不复刻判定）；会话绑定落库进 enterprise_conversations
// （主体 = 使用者，data 角色 RLS INSERT）；凭据选择只认使用者本人个人凭据
// （target=ref 精确匹配）；本票零新 schema 对象，既有文件零改动。

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  createPublicBotUsageFixture,
  type PublicBotUsageFixture,
  type PublicBotUsageIdentity,
} from "./support/public-bot-usage";

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
      reason: `MT018 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
    };
  }
  try {
    enterpriseRuntimeDatabaseUrlFrom("directory", process.env);
    enterpriseRuntimeDatabaseUrlFrom("data", process.env);
    enterpriseRuntimeDatabaseUrlFrom("operator", process.env);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

const ENV = probeEnvironment();
const itDb = ((name, fn) =>
  ENV.ok
    ? test(name, fn)
    : test.skip(`${name} [skipped: ${ENV.reason}]`, fn)) as typeof test;
const describeDb = ENV.ok ? describe : describe.skip;

// ---------------------------------------------------------------------------
// 断言形状助手
// ---------------------------------------------------------------------------

const canonicalNotFoundJson = serializeNotFoundVerdict(notFoundVerdict());

const isCanonicalNotFound = (value: unknown): boolean =>
  isResourceNotFoundVerdict(value) &&
  JSON.stringify(value) === canonicalNotFoundJson;

const thrownMessage = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
};

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

let fixture: PublicBotUsageFixture;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
const principalOf = (identity: PublicBotUsageIdentity) =>
  fixture.ids[`principal-${identity}`];

async function createAndPublishBot(botKey: string): Promise<string> {
  const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
  const agentId = `${fixture.idPrefix}-${botKey}`;
  const created = await fixture.ownership.createBot(ownerScope, {
    agentId,
    displayName: `MT018 public bot ${botKey}`,
    defaultConfig: { botKey },
  });
  expect(created.outcome).toBe("allow");
  const published = await fixture.publish.publishBot(
    ownerScope,
    agentId,
    fixture.teamAudience(companyA, teamA1),
  );
  expect(published.outcome).toBe("allow");
  return agentId;
}

/** Registers one personal credential owned by the given identity. */
async function registerPersonalCredential(
  identity: PublicBotUsageIdentity,
  target: string,
  label: string,
): Promise<string> {
  const registered = await fixture.credentialsAdmin.register({
    tenantId: companyA,
    kind: "connection",
    classification: "personal",
    ownerPrincipalId: principalOf(identity),
    target,
    label,
    plaintext: `secret-for-${label}`,
  });
  return registered.credentialId;
}

beforeAll(async () => {
  if (!ENV.ok) return;
  fixture = await createPublicBotUsageFixture();
  companyA = fixture.ids["company-a"];
  companyB = fixture.ids["company-b"];
  teamA1 = fixture.ids["team-a1"];
  teamA2 = fixture.ids["team-a2"];
  teamB1 = fixture.ids["team-b1"];
  // 披露的 superuser stand-in（MT017 D5 同款）：公司 A → workspace-v1，
  // 团队公共使用路径生效；公司 B 保持 tenancy-v1（跨公司不可见性对照，
  // 与策略版本无关）。判定侧从不使用该通道。
  await fixture.setTenantPolicyRevision(companyA, "workspace-v1");
});

afterAll(async () => {
  if (!ENV.ok) return;
  await fixture.dispose();
});

// ---------------------------------------------------------------------------
// 验收 1：会话归使用者个人所有，创建者看不到
// ---------------------------------------------------------------------------

describeDb("MT018 验收 1：公共 Bot 运行入口产生的会话归使用者本人", () => {
  itDb(
    "成员运行已发布公共 Bot → admitted；会话行主体 = 使用者（data 角色探针）",
    async () => {
      const agentId = await createAndPublishBot(
        `run-own-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "daily-standup",
      });
      expect(admission.outcome).toBe("admitted");
      if (admission.outcome !== "admitted") throw new Error("unreachable");
      expect(admission.conversation.ownedByPrincipalId).toBe(
        principalOf("a1-member"),
      );
      expect(admission.conversation.threadId).toBe(
        `pubbot/${agentId}/${principalOf("a1-member")}/daily-standup`,
      );
      const rows = await fixture.readConversationRowsAsData(companyA);
      const bound = rows.filter(
        (row) => row.threadId === admission.conversation.threadId,
      );
      expect(bound.length).toBe(1);
      expect(bound[0]?.principalId).toBe(principalOf("a1-member"));
      expect(bound[0]?.workspaceId).toBe(teamA1);
      expect(bound[0]?.storageBackend).toBe("platform");
    },
  );

  itDb(
    "创建者对使用者产生的会话：列表为空、计数为 0、详情 canonical not-found",
    async () => {
      const agentId = await createAndPublishBot(
        `creator-blind-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "private-thread",
      });
      expect(admission.outcome).toBe("admitted");
      if (admission.outcome !== "admitted") throw new Error("unreachable");
      const creatorScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const creatorList =
        await fixture.conversations.listVisibleConversations(creatorScope);
      expect(creatorList.items.map((item) => item.threadId)).not.toContain(
        admission.conversation.threadId,
      );
      expect(creatorList.nextCursor).toBeNull();
      expect(
        (await fixture.conversations.countVisibleConversations(creatorScope))
          .total,
      ).toBe(0);
      const rows = await fixture.readConversationRowsAsData(companyA);
      const conversationId = rows.find(
        (row) => row.threadId === admission.conversation.threadId,
      )?.id;
      expect(typeof conversationId).toBe("string");
      const creatorRead = await fixture.conversations.readVisibleConversation(
        creatorScope,
        conversationId as string,
      );
      expect(isCanonicalNotFound(creatorRead)).toBe(true);
      expect(JSON.stringify(creatorRead)).toBe(canonicalNotFoundJson);
    },
  );

  itDb("使用者本人能看到自己的运行会话；其他成员看不到", async () => {
    const agentId = await createAndPublishBot(
      `self-visible-${randomUUID().slice(0, 8)}`,
    );
    const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
    const admission = await fixture.usage.resolveRunEntry(runnerScope, {
      resourceId: agentId,
      threadKey: "mine-only",
    });
    expect(admission.outcome).toBe("admitted");
    const admittedThread =
      admission.outcome === "admitted" ? admission.conversation.threadId : "";
    const ownList =
      await fixture.conversations.listVisibleConversations(runnerScope);
    expect(ownList.items.map((item) => item.threadId)).toContain(
      admittedThread,
    );
    const otherScope = await fixture.scopeAs("a1-member2", companyA, teamA1);
    const otherList =
      await fixture.conversations.listVisibleConversations(otherScope);
    expect(otherList.items.map((item) => item.threadId)).not.toContain(
      admittedThread,
    );
  });

  itDb(
    "创建者运行自己的公共 Bot → 会话同样绑定创建者本人身份（无特殊化）",
    async () => {
      const agentId = await createAndPublishBot(
        `creator-runs-${randomUUID().slice(0, 8)}`,
      );
      const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(ownerScope, {
        resourceId: agentId,
        threadKey: "author-thread",
      });
      expect(admission.outcome).toBe("admitted");
      if (admission.outcome !== "admitted") throw new Error("unreachable");
      expect(admission.conversation.ownedByPrincipalId).toBe(
        principalOf("a1-owner"),
      );
      const rows = await fixture.readConversationRowsAsData(companyA);
      expect(
        rows.find((row) => row.threadId === admission.conversation.threadId)
          ?.principalId,
      ).toBe(principalOf("a1-owner"));
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 2：凭据选择——使用者自己的；缺失按既有规则请求授权，绝不借创建者的
// ---------------------------------------------------------------------------

describeDb("MT018 验收 2：凭据选择用使用者本人的个人凭据", () => {
  itDb(
    "使用者有自己的同名 target 个人凭据 → 选中本人的（即使创建者也有同名 target）",
    async () => {
      const agentId = await createAndPublishBot(
        `cred-own-${randomUUID().slice(0, 8)}`,
      );
      const target = `vendor://${fixture.idPrefix}/deploy-api`;
      const creatorCredentialId = await registerPersonalCredential(
        "a1-owner",
        target,
        "owner deploy credential",
      );
      const runnerCredentialId = await registerPersonalCredential(
        "a1-member",
        target,
        "runner deploy credential",
      );
      await fixture.addDependency({
        tenantId: companyA,
        resourceId: agentId,
        kind: "credential",
        ref: target,
      });
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "cred-own",
      });
      expect(admission.outcome).toBe("admitted");
      if (admission.outcome !== "admitted") throw new Error("unreachable");
      expect(admission.credentials.length).toBe(1);
      expect(admission.credentials[0]?.ref).toBe(target);
      expect(admission.credentials[0]?.credentialId).toBe(runnerCredentialId);
      expect(admission.credentials[0]?.classification).toBe("personal");
      expect(JSON.stringify(admission)).not.toContain(creatorCredentialId);
    },
  );

  itDb(
    "使用者缺个人凭据而创建者有同名 target → authorization-required 指明 ref；零写入；创建者凭据 id 绝不出现",
    async () => {
      const agentId = await createAndPublishBot(
        `cred-missing-${randomUUID().slice(0, 8)}`,
      );
      const target = `vendor://${fixture.idPrefix}/search-api`;
      const creatorCredentialId = await registerPersonalCredential(
        "a1-owner",
        target,
        "owner search credential",
      );
      await fixture.addDependency({
        tenantId: companyA,
        resourceId: agentId,
        kind: "credential",
        ref: target,
      });
      const before = await fixture.readConversationRowsAsData(companyA);
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "cred-missing",
      });
      expect(admission.outcome).toBe("authorization-required");
      if (admission.outcome !== "authorization-required")
        throw new Error("unreachable");
      expect(admission.missing.length).toBe(1);
      expect(admission.missing[0]?.ref).toBe(target);
      expect(JSON.stringify(admission)).not.toContain(creatorCredentialId);
      expect(JSON.stringify(admission)).not.toContain("sealed:");
      const after = await fixture.readConversationRowsAsData(companyA);
      expect(after.length).toBe(before.length);
    },
  );

  itDb(
    "创建者对使用者授予 use 动作行也不改选择：运行入口只认使用者本人个人凭据（披露的窄规则）",
    async () => {
      const agentId = await createAndPublishBot(
        `cred-grant-${randomUUID().slice(0, 8)}`,
      );
      const target = `vendor://${fixture.idPrefix}/granted-api`;
      const creatorCredentialId = await registerPersonalCredential(
        "a1-owner",
        target,
        "owner granted credential",
      );
      await fixture.credentialsAdmin.grantAction({
        tenantId: companyA,
        credentialId: creatorCredentialId,
        principalId: principalOf("a1-member"),
        action: "use",
        grantedBy: principalOf("a1-owner"),
      });
      await fixture.addDependency({
        tenantId: companyA,
        resourceId: agentId,
        kind: "credential",
        ref: target,
      });
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "cred-grant",
      });
      // 显式 use 授权让使用者「可用」（MT027 语义），但运行入口的凭据选择
      // 只认使用者本人的个人凭据——不因授权行改借他人凭据。
      expect(admission.outcome).toBe("authorization-required");
      if (admission.outcome !== "authorization-required")
        throw new Error("unreachable");
      expect(JSON.stringify(admission)).not.toContain(creatorCredentialId);
    },
  );

  itDb(
    "已撤销或 target 不匹配的本人凭据不被选中 → authorization-required",
    async () => {
      const agentId = await createAndPublishBot(
        `cred-dead-${randomUUID().slice(0, 8)}`,
      );
      const target = `vendor://${fixture.idPrefix}/mail-api`;
      const otherTarget = `vendor://${fixture.idPrefix}/other-api`;
      const revokedId = await registerPersonalCredential(
        "a1-member",
        target,
        "runner revoked credential",
      );
      await fixture.credentialsAdmin.revoke({
        tenantId: companyA,
        credentialId: revokedId,
      });
      await registerPersonalCredential(
        "a1-member",
        otherTarget,
        "runner other-target credential",
      );
      await fixture.addDependency({
        tenantId: companyA,
        resourceId: agentId,
        kind: "credential",
        ref: target,
      });
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "cred-dead",
      });
      expect(admission.outcome).toBe("authorization-required");
    },
  );

  itDb("无凭据依赖的公共 Bot → admitted 且 credentials 为空", async () => {
    const agentId = await createAndPublishBot(
      `cred-free-${randomUUID().slice(0, 8)}`,
    );
    const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
    const admission = await fixture.usage.resolveRunEntry(runnerScope, {
      resourceId: agentId,
      threadKey: "cred-free",
    });
    expect(admission.outcome).toBe("admitted");
    if (admission.outcome !== "admitted") throw new Error("unreachable");
    expect(admission.credentials.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 验收 3：创建者个人面零暴露
// ---------------------------------------------------------------------------

describeDb("MT018 验收 3：发布不暴露创建者的个人凭据与个人会话", () => {
  itDb(
    "运行入口输出形状零创建者材料（键集钉死 + 序列化不含创建者主体）",
    async () => {
      const agentId = await createAndPublishBot(
        `shape-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "shape",
      });
      expect(admission.outcome).toBe("admitted");
      if (admission.outcome !== "admitted") throw new Error("unreachable");
      expect(Object.keys(admission).sort()).toEqual(
        ["conversation", "credentials", "outcome"].sort(),
      );
      expect(Object.keys(admission.conversation).sort()).toEqual(
        ["ownedByPrincipalId", "threadId"].sort(),
      );
      for (const credential of admission.credentials) {
        expect(Object.keys(credential).sort()).toEqual(
          ["classification", "credentialId", "ref"].sort(),
        );
      }
      expect(JSON.stringify(admission)).not.toContain(principalOf("a1-owner"));
    },
  );

  itDb("MT027 个人凭据面原样：使用者的可见凭据列表不含创建者凭据", async () => {
    const target = `vendor://${fixture.idPrefix}/visible-api`;
    const creatorCredentialId = await registerPersonalCredential(
      "a1-owner",
      target,
      "owner visible credential",
    );
    const runnerCredentialId = await registerPersonalCredential(
      "a1-member",
      target,
      "runner visible credential",
    );
    const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
    const visible = await fixture.credentialViews.listVisible(runnerScope);
    const visibleIds = visible.map((view) => view.credentialId);
    expect(visibleIds).toContain(runnerCredentialId);
    expect(visibleIds).not.toContain(creatorCredentialId);
  });

  itDb(
    "MT021 个人会话面原样：使用者的会话列表只含本人运行产生的会话",
    async () => {
      const agentId = await createAndPublishBot(
        `faces-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const runnerAdmission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "runner-face",
      });
      const ownerAdmission = await fixture.usage.resolveRunEntry(ownerScope, {
        resourceId: agentId,
        threadKey: "owner-face",
      });
      expect(runnerAdmission.outcome).toBe("admitted");
      expect(ownerAdmission.outcome).toBe("admitted");
      const runnerThread =
        runnerAdmission.outcome === "admitted"
          ? runnerAdmission.conversation.threadId
          : "";
      const ownerThread =
        ownerAdmission.outcome === "admitted"
          ? ownerAdmission.conversation.threadId
          : "";
      const runnerList =
        await fixture.conversations.listVisibleConversations(runnerScope);
      expect(runnerList.items.map((item) => item.threadId)).toContain(
        runnerThread,
      );
      expect(runnerList.items.map((item) => item.threadId)).not.toContain(
        ownerThread,
      );
      const ownerList =
        await fixture.conversations.listVisibleConversations(ownerScope);
      expect(ownerList.items.map((item) => item.threadId)).toContain(
        ownerThread,
      );
      expect(ownerList.items.map((item) => item.threadId)).not.toContain(
        runnerThread,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 验收 4：多成员并发使用同一公共 Bot 状态不串用
// ---------------------------------------------------------------------------

describeDb("MT018 验收 4：并发使用同一公共 Bot 状态不串用", () => {
  itDb(
    "两个成员同 (bot, threadKey) → 两个互不相交的会话行，各归本人",
    async () => {
      const agentId = await createAndPublishBot(
        `conc-${randomUUID().slice(0, 8)}`,
      );
      const scopeA = await fixture.scopeAs("a1-member", companyA, teamA1);
      const scopeB = await fixture.scopeAs("a1-member2", companyA, teamA1);
      const first = await fixture.usage.resolveRunEntry(scopeA, {
        resourceId: agentId,
        threadKey: "shared-key",
      });
      const second = await fixture.usage.resolveRunEntry(scopeB, {
        resourceId: agentId,
        threadKey: "shared-key",
      });
      expect(first.outcome).toBe("admitted");
      expect(second.outcome).toBe("admitted");
      if (first.outcome !== "admitted" || second.outcome !== "admitted") {
        throw new Error("unreachable");
      }
      expect(first.conversation.threadId).not.toBe(
        second.conversation.threadId,
      );
      const rows = await fixture.readConversationRowsAsData(companyA);
      const rowA = rows.find(
        (row) => row.threadId === first.conversation.threadId,
      );
      const rowB = rows.find(
        (row) => row.threadId === second.conversation.threadId,
      );
      expect(rowA?.principalId).toBe(principalOf("a1-member"));
      expect(rowB?.principalId).toBe(principalOf("a1-member2"));
      // 双向不可见（MT021 原样）。
      const listA =
        await fixture.conversations.listVisibleConversations(scopeA);
      expect(listA.items.map((item) => item.threadId)).toContain(
        first.conversation.threadId,
      );
      expect(listA.items.map((item) => item.threadId)).not.toContain(
        second.conversation.threadId,
      );
      const listB =
        await fixture.conversations.listVisibleConversations(scopeB);
      expect(listB.items.map((item) => item.threadId)).toContain(
        second.conversation.threadId,
      );
      expect(listB.items.map((item) => item.threadId)).not.toContain(
        first.conversation.threadId,
      );
    },
  );

  itDb(
    "同一成员重入同 threadKey → 幂等复用自己的会话行（不产生第二行）",
    async () => {
      const agentId = await createAndPublishBot(
        `reentry-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const first = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "stable-key",
      });
      const second = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "stable-key",
      });
      expect(first.outcome).toBe("admitted");
      expect(second.outcome).toBe("admitted");
      if (first.outcome !== "admitted" || second.outcome !== "admitted") {
        throw new Error("unreachable");
      }
      expect(first.conversation.threadId).toBe(second.conversation.threadId);
      const rows = await fixture.readConversationRowsAsData(companyA);
      expect(
        rows.filter((row) => row.threadId === first.conversation.threadId)
          .length,
      ).toBe(1);
    },
  );

  itDb(
    "同一成员不同 threadKey → 不同会话行（同主体并行会话互不串用）",
    async () => {
      const agentId = await createAndPublishBot(
        `parallel-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const alpha = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "alpha",
      });
      const beta = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "beta",
      });
      if (alpha.outcome !== "admitted" || beta.outcome !== "admitted") {
        throw new Error("unreachable");
      }
      expect(alpha.conversation.threadId).not.toBe(beta.conversation.threadId);
      const rows = await fixture.readConversationRowsAsData(companyA);
      expect(
        rows.filter(
          (row) =>
            row.principalId === principalOf("a1-member") &&
            row.threadId.startsWith(`pubbot/${agentId}/`),
        ).length,
      ).toBe(2);
    },
  );

  itDb(
    "双团队成员 scope 钉死：a2 scope 不可见（canonical not-found）、a1 scope 绑定 a1 工作空间",
    async () => {
      const agentId = await createAndPublishBot(
        `dual-${randomUUID().slice(0, 8)}`,
      );
      const a2Scope = await fixture.scopeAs("a1a2-member", companyA, teamA2);
      const denied = await fixture.usage.resolveRunEntry(a2Scope, {
        resourceId: agentId,
        threadKey: "dual",
      });
      expect(isCanonicalNotFound(denied)).toBe(true);
      const a1Scope = await fixture.scopeAs("a1a2-member", companyA, teamA1);
      const admitted = await fixture.usage.resolveRunEntry(a1Scope, {
        resourceId: agentId,
        threadKey: "dual",
      });
      expect(admitted.outcome).toBe("admitted");
      if (admitted.outcome !== "admitted") throw new Error("unreachable");
      const rows = await fixture.readConversationRowsAsData(companyA);
      expect(
        rows.find((row) => row.threadId === admitted.conversation.threadId)
          ?.workspaceId,
      ).toBe(teamA1);
    },
  );
});

// ---------------------------------------------------------------------------
// 门语义透传：MT009 形状逐字、全部拒绝零写入
// ---------------------------------------------------------------------------

describeDb("MT018 门语义透传：MT009 run 判定原样承载（deny 变体逐字）", () => {
  itDb(
    "非成员（同公司他团队）→ RESOURCE_NOT_FOUND，与 MT009 判定逐字节同形",
    async () => {
      const agentId = await createAndPublishBot(
        `gate-a2-${randomUUID().slice(0, 8)}`,
      );
      const scope = await fixture.scopeAs("a2-member", companyA, teamA2);
      const admission = await fixture.usage.resolveRunEntry(scope, {
        resourceId: agentId,
        threadKey: "gate",
      });
      const direct = await fixture.actions.decideAction(scope, agentId, "run");
      expect(JSON.stringify(admission)).toBe(JSON.stringify(direct));
      expect(isCanonicalNotFound(admission)).toBe(true);
    },
  );

  itDb(
    "跨公司成员与不存在 id → 与 MT009 判定逐字节同形（互相不可区分）",
    async () => {
      const agentId = await createAndPublishBot(
        `gate-b1-${randomUUID().slice(0, 8)}`,
      );
      const b1Scope = await fixture.scopeAs("b1-member", companyB, teamB1);
      const crossCompany = await fixture.usage.resolveRunEntry(b1Scope, {
        resourceId: agentId,
        threadKey: "gate",
      });
      const missing = `${fixture.idPrefix}-never-${randomUUID().slice(0, 8)}`;
      const nonexistent = await fixture.usage.resolveRunEntry(b1Scope, {
        resourceId: missing,
        threadKey: "gate",
      });
      const directCross = await fixture.actions.decideAction(
        b1Scope,
        agentId,
        "run",
      );
      const directMissing = await fixture.actions.decideAction(
        b1Scope,
        missing,
        "run",
      );
      expect(JSON.stringify(crossCompany)).toBe(JSON.stringify(directCross));
      expect(JSON.stringify(nonexistent)).toBe(JSON.stringify(directMissing));
      expect(JSON.stringify(crossCompany)).toBe(JSON.stringify(nonexistent));
      expect(isCanonicalNotFound(crossCompany)).toBe(true);
    },
  );

  itDb(
    "未发布 Bot（无注册行）→ RESOURCE_NOT_FOUND；多公司成员的公司 B scope 同样不可见",
    async () => {
      const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const agentId = `${fixture.idPrefix}-unpublished-${randomUUID().slice(0, 8)}`;
      const created = await fixture.ownership.createBot(ownerScope, {
        agentId,
        displayName: "MT018 unpublished bot",
        defaultConfig: {},
      });
      expect(created.outcome).toBe("allow");
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "gate",
      });
      expect(isCanonicalNotFound(admission)).toBe(true);
      const multiScopeB = await fixture.scopeAs(
        "multi-company",
        companyB,
        teamB1,
      );
      const fromB = await fixture.usage.resolveRunEntry(multiScopeB, {
        resourceId: agentId,
        threadKey: "gate",
      });
      expect(JSON.stringify(fromB)).toBe(JSON.stringify(admission));
    },
  );

  itDb(
    "已发布但非 bot 类资源（knowledge_base）→ TEAM_PUBLIC_ACTION_FORBIDDEN（MT009 run 仅 bot 类）",
    async () => {
      const knowledgeId = `${fixture.idPrefix}-kb-${randomUUID().slice(0, 8)}`;
      await fixture.seedResourceRow({
        tenantId: companyA,
        workspaceId: teamA1,
        id: knowledgeId,
        kind: "knowledge_base",
        displayName: "MT018 published knowledge base",
        visibility: "workspace",
      });
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: knowledgeId,
        threadKey: "gate",
      });
      const direct = await fixture.actions.decideAction(
        runnerScope,
        knowledgeId,
        "run",
      );
      expect(JSON.stringify(admission)).toBe(JSON.stringify(direct));
      expect(
        admission.outcome === "deny" &&
          admission.code === "TEAM_PUBLIC_ACTION_FORBIDDEN",
      ).toBe(true);
    },
  );

  itDb(
    "依赖失效 → DEPENDENCY_INVALID 指明 kind/ref（MT009 判定透传）",
    async () => {
      const agentId = await createAndPublishBot(
        `gate-dep-${randomUUID().slice(0, 8)}`,
      );
      await fixture.addDependency({
        tenantId: companyA,
        resourceId: agentId,
        kind: "model",
        ref: "models/dead-route",
        status: "invalid",
      });
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admission = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "gate",
      });
      const direct = await fixture.actions.decideAction(
        runnerScope,
        agentId,
        "run",
      );
      expect(JSON.stringify(admission)).toBe(JSON.stringify(direct));
      expect(
        admission.outcome === "deny" && admission.code === "DEPENDENCY_INVALID",
      ).toBe(true);
      if (
        admission.outcome === "deny" &&
        admission.code === "DEPENDENCY_INVALID"
      ) {
        expect(admission.dependencyKind).toBe("model");
        expect(admission.dependencyRef).toBe("models/dead-route");
      }
    },
  );

  itDb("一切拒绝零写入：会话行数与依赖行数不变", async () => {
    const agentId = await createAndPublishBot(
      `gate-zerowrite-${randomUUID().slice(0, 8)}`,
    );
    await fixture.addDependency({
      tenantId: companyA,
      resourceId: agentId,
      kind: "credential",
      ref: `vendor://${fixture.idPrefix}/never`,
    });
    const beforeRows = await fixture.readConversationRowsAsData(companyA);
    const beforeDeps = await fixture.countDependenciesAsData(companyA, agentId);
    const a2Scope = await fixture.scopeAs("a2-member", companyA, teamA2);
    const denied = await fixture.usage.resolveRunEntry(a2Scope, {
      resourceId: agentId,
      threadKey: "zerowrite",
    });
    expect(isCanonicalNotFound(denied)).toBe(true);
    const b1Scope = await fixture.scopeAs("b1-member", companyB, teamB1);
    const cross = await fixture.usage.resolveRunEntry(b1Scope, {
      resourceId: agentId,
      threadKey: "zerowrite",
    });
    expect(isCanonicalNotFound(cross)).toBe(true);
    const afterRows = await fixture.readConversationRowsAsData(companyA);
    const afterDeps = await fixture.countDependenciesAsData(companyA, agentId);
    expect(afterRows.length).toBe(beforeRows.length);
    expect(afterDeps.total).toBe(beforeDeps.total);
  });

  itDb(
    "发布撤销后运行入口立即 canonical not-found；已产生的会话保持本人私有",
    async () => {
      const agentId = await createAndPublishBot(
        `unpub-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const admitted = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "before-unpublish",
      });
      expect(admitted.outcome).toBe("admitted");
      const ownerScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const unpublished = await fixture.publish.unpublishBot(
        ownerScope,
        agentId,
      );
      expect(unpublished.outcome).toBe("allow");
      const after = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "before-unpublish",
      });
      expect(isCanonicalNotFound(after)).toBe(true);
      const rows = await fixture.readConversationRowsAsData(companyA);
      const bound = rows.find(
        (row) =>
          admitted.outcome === "admitted" &&
          row.threadId === admitted.conversation.threadId,
      );
      expect(bound?.principalId).toBe(principalOf("a1-member"));
      const creatorScope = await fixture.scopeAs("a1-owner", companyA, teamA1);
      const creatorList =
        await fixture.conversations.listVisibleConversations(creatorScope);
      expect(creatorList.items.map((item) => item.threadId)).not.toContain(
        admitted.outcome === "admitted" ? admitted.conversation.threadId : "",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// 信任边界与存储契约
// ---------------------------------------------------------------------------

describeDb("MT018 信任边界、输入形状与存储契约", () => {
  itDb(
    "输入形状响亮拒绝：RESOURCE_ID_INVALID / THREAD_KEY_INVALID（错误只含代码，零写入）",
    async () => {
      const agentId = await createAndPublishBot(
        `shape-bad-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const before = await fixture.readConversationRowsAsData(companyA);
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(runnerScope, {
            resourceId: "   ",
            threadKey: "ok",
          }),
        ),
      ).toBe("RESOURCE_ID_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(runnerScope, {
            resourceId: agentId,
            threadKey: "",
          }),
        ),
      ).toBe("THREAD_KEY_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(runnerScope, {
            resourceId: agentId,
            threadKey: " ".repeat(4),
          }),
        ),
      ).toBe("THREAD_KEY_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(runnerScope, {
            resourceId: agentId,
            threadKey: "x".repeat(65),
          }),
        ),
      ).toBe("THREAD_KEY_INVALID");
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(runnerScope, {
            resourceId: agentId,
            threadKey: "bad\u0000key",
          }),
        ),
      ).toBe("THREAD_KEY_INVALID");
      const after = await fixture.readConversationRowsAsData(companyA);
      expect(after.length).toBe(before.length);
    },
  );

  itDb(
    "伪造 scope UNVERIFIED_SCOPE；缺公司/团队上下文 TENANT_REQUIRED / WORKSPACE_REQUIRED",
    async () => {
      const agentId = await createAndPublishBot(
        `trust-${randomUUID().slice(0, 8)}`,
      );
      const forged = {
        tenantId: companyA,
        workspaceId: teamA1,
        principalId: principalOf("a1-member"),
        memberEpoch: 1,
        // 故意不带受信签发标记（assertTrustedScope 拒绝非 seam 产物）。
      } as unknown as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(forged, {
            resourceId: agentId,
            threadKey: "trust",
          }),
        ),
      ).toBe("UNVERIFIED_SCOPE");
      const realScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const noTenant = { ...realScope, tenantId: "" } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(noTenant, {
            resourceId: agentId,
            threadKey: "trust",
          }),
        ),
      ).toBe("TENANT_REQUIRED");
      const noTeam = { ...realScope, workspaceId: "" } as PlatformScope;
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(noTeam, {
            resourceId: agentId,
            threadKey: "trust",
          }),
        ),
      ).toBe("WORKSPACE_REQUIRED");
    },
  );

  itDb(
    "公司成员资格暂停后，已签发 scope 的运行入口立即 canonical not-found（事务内重验）",
    async () => {
      const agentId = await createAndPublishBot(
        `suspend-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member2", companyA, teamA1);
      const before = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "suspend",
      });
      expect(before.outcome).toBe("admitted");
      // 披露的 superuser stand-in（MT011/MT017 先例）：挂起团队成员关系。
      // 判定侧从不使用该通道。
      const { createDatabase } = await import("../../src/db/client");
      const setup = createDatabase(process.env.TEST_DATABASE_URL as string, {
        max: 1,
      });
      try {
        await setup.execute(
          `update enterprise_workspace_memberships set status = 'suspended' where tenant_id = '${companyA}' and workspace_id = '${teamA1}' and principal_id = '${principalOf("a1-member2")}'`,
        );
      } finally {
        await setup.$client.close();
      }
      const after = await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "suspend-again",
      });
      expect(isCanonicalNotFound(after)).toBe(true);
      const rows = await fixture.readConversationRowsAsData(companyA);
      expect(
        rows.some(
          (row) =>
            row.principalId === principalOf("a1-member2") &&
            row.threadId.endsWith("/suspend-again"),
        ),
      ).toBe(false);
    },
  );

  itDb(
    "受限角色契约：判定全程 current_user = ob_ent_data（逐调用记录断言）",
    async () => {
      const agentId = await createAndPublishBot(
        `roles-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      await fixture.usage.resolveRunEntry(runnerScope, {
        resourceId: agentId,
        threadKey: "roles",
      });
      const calls = fixture.restrictedCalls();
      expect(calls.length).toBeGreaterThan(0);
      const dataCalls = calls.filter((call) => call.role === "data");
      expect(dataCalls.length).toBeGreaterThan(0);
      for (const call of dataCalls) {
        expect(call.currentUser).toBe("ob_ent_data");
      }
    },
  );

  itDb("未验证通道装配拒绝（UNVERIFIED_DATABASE_CAPABILITY）", async () => {
    const { createPublicBotUsageService } = await import(
      "../../src/enterprise/tenancy/public-bot-usage"
    );
    expect(
      await thrownMessage(() => createPublicBotUsageService({} as never)),
    ).toBe("UNVERIFIED_DATABASE_CAPABILITY");
  });

  itDb(
    "不变量守卫：thread 行主体漂移 → PUBLIC_BOT_STATE_CONFLICT（绝不静默改写）",
    async () => {
      const agentId = await createAndPublishBot(
        `guard-${randomUUID().slice(0, 8)}`,
      );
      const runnerScope = await fixture.scopeAs("a1-member", companyA, teamA1);
      const threadKey = "guarded-thread";
      const expectedThread = `pubbot/${agentId}/${principalOf("a1-member")}/${threadKey}`;
      // 披露的 superuser stand-in：预置一行同 thread、异主体的会话（漂移态）。
      // 判定侧从不使用该通道。
      const { createDatabase } = await import("../../src/db/client");
      const setup = createDatabase(process.env.TEST_DATABASE_URL as string, {
        max: 1,
      });
      try {
        await setup.execute(
          `insert into enterprise_conversations (tenant_id, workspace_id, principal_id, thread_id, title) values ('${companyA}', '${teamA1}', '${principalOf("a1-owner")}', '${expectedThread}', 'drifted')`,
        );
      } finally {
        await setup.$client.close();
      }
      expect(
        await thrownMessage(() =>
          fixture.usage.resolveRunEntry(runnerScope, {
            resourceId: agentId,
            threadKey,
          }),
        ),
      ).toBe("PUBLIC_BOT_STATE_CONFLICT");
      const rows = await fixture.readConversationRowsAsData(companyA);
      expect(rows.filter((row) => row.threadId === expectedThread).length).toBe(
        1,
      );
      expect(
        rows.find((row) => row.threadId === expectedThread)?.principalId,
      ).toBe(principalOf("a1-owner"));
    },
  );
});
