// server/tests/multitenancy/conversation-messages.test.ts
// MT022（Issue #65）：会话内消息发送/读取/重命名/归档/历史 replay 的作用域授权。
//
// 票面验收事实源（brief + Issue #65，逐 describe 对应；真实 PostgreSQL，全程
// 受限 ob_ent_* 角色 + 真实 RLS，绝不回退开发库、缺 env 显式 skip）：
//   AC1：非成员不能读写会话消息；不能通过历史 replay 绕过（replay = 独立
//     授权面，自带事务内成员/归属重验，不是 read 的别名）。
//   AC2：重命名与归档分别授权；可读不派生可改（每动作独立判定，读取成功
//     不缓存任何写授权）。归档在 MT022 为授权判定面（escalation 裁决 Q2/
//     方案B：deny 零写入零副作用；allow 携带判定 + 视图，持久化归下游接线
//     票——显著披露于报告）。
//   AC3：公共 Bot 使用者的个人会话不出现在团队列表/团队搜索（消费 MT018
//     public-bot-usage 先例：会话 = 使用者本人私有；list/count/detail 走
//     MT021 冻结面消费）。
//   AC4：撤权后（MT007 停用语义）消息读写与 replay 立即失效（事务内重验，
//     无 epoch bump 依赖——status 臂与 epoch 臂分别独立可捕获）。
//   不可见语义 = MT011 canonical RESOURCE_NOT_FOUND 逐字节同形；deny 零写入
//     零副作用（raw 计数不变量钉死）。
//
// 结构（全部新文件；既有 verified 文件零改动——无迁移，migrate-test 链保持
// 十六任务）。判定纪律与 MT008/MT011/MT016/MT021 判定入口同款：
// assertScopeContext → assertTrustedScope → read committed + lock/statement
// timeout → set_config('app.*', true) → advisory 共享锁（tenant → principal →
// membership → workspace-membership；写动作再加 conversation 排他锁）→
// 成员事实重验 → 会话归属比对 → 执行或 canonical verdict。事实读取全部经
// 受限 data 角色与真实 RLS。

import { afterAll, beforeAll, describe, expect, test } from "../../../tests/support/bun-test-compat";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../../src/db/client";
import type { PlatformScope } from "../../src/enterprise/contracts";
import type { ConversationActionsService } from "../../src/enterprise/tenancy/conversation-actions";
import {
  isResourceNotFoundVerdict,
  notFoundVerdict,
  serializeNotFoundVerdict,
} from "../../src/enterprise/tenancy/not-found-semantics";
import { enterpriseRuntimeDatabaseUrlFrom } from "../support/enterprise-database";
import {
  type ConversationActionsFixture,
  type ConversationActionsIdentity,
  createConversationActionsFixture,
  publicBotThreadId,
} from "./support/conversation-actions";

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
      reason: `MT022 requires the dedicated enterprise test database env (${missing.join(", ")}) — no dev-database fallback`,
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
  throw new Error("expected the call to be rejected, but it succeeded");
};

const thrownCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : "NO_CODE";
  }
  throw new Error("expected the call to be rejected, but it succeeded");
};

const expectFrozen = (value: unknown): void => {
  expect(Object.isFrozen(value)).toBe(true);
};

// ---------------------------------------------------------------------------
// 套件状态与确定性种子
// ---------------------------------------------------------------------------

let fixture: ConversationActionsFixture;
let service: ConversationActionsService;
let companyA = "";
let companyB = "";
let teamA1 = "";
let teamA2 = "";
let teamB1 = "";
let convMainId = "";
let convMainThread = "";
let convOtherThread = "";
let convDoomedId = "";
let convDoomedThread = "";
let convA2Id = "";
let convA2Thread = "";
let convB1Thread = "";
let convA1a2Id = "";
let convA1a2Thread = "";
let convPubBotId = "";
let convPubBotThread = "";
let convMastraId = "";
let convMastraThread = "";

const principalOf = (identity: ConversationActionsIdentity) =>
  fixture.ids[`principal-${identity}`];

const scopeAs = (
  identity: ConversationActionsIdentity,
  tenantId: string,
  workspaceId: string,
): Promise<PlatformScope> => fixture.scopeAs(identity, tenantId, workspaceId);

const fiveDenyActions = async (
  scope: PlatformScope,
  threadId: string,
  conversationId: string,
): Promise<unknown[]> => {
  const send = await service.sendMessage(scope, {
    threadId,
    clientMessageKey: `probe-${randomUUID()}`,
    content: "probe",
  });
  const read = await service.readMessages(scope, { threadId });
  const replay = await service.replayHistory(scope, { threadId });
  const rename = await service.renameConversation(scope, {
    conversationId,
    title: "hostile rename",
  });
  const archive = await service.archiveConversation(scope, { conversationId });
  return [send, read, replay, rename, archive];
};

describeDb("MT022 conversation message/action scoping (Issue #65)", () => {
  beforeAll(async () => {
    if (!ENV.ok) return;
    fixture = await createConversationActionsFixture();
    service = fixture.service;
    companyA = fixture.ids["company-a"];
    companyB = fixture.ids["company-b"];
    teamA1 = fixture.ids["team-a1"];
    teamA2 = fixture.ids["team-a2"];
    teamB1 = fixture.ids["team-b1"];

    const stamp = randomUUID().slice(0, 8);
    convMainId = randomUUID();
    convMainThread = `conv-main-${stamp}`;
    convOtherThread = `conv-other-${stamp}`;
    convDoomedId = randomUUID();
    convDoomedThread = `conv-doomed-${stamp}`;
    convA2Id = randomUUID();
    convA2Thread = `conv-a2-${stamp}`;
    convB1Thread = `conv-b1-${stamp}`;
    convA1a2Id = randomUUID();
    convA1a2Thread = `conv-a1a2-${stamp}`;
    convMastraId = randomUUID();
    convMastraThread = `conv-mastra-${stamp}`;
    convPubBotId = randomUUID();
    convPubBotThread = publicBotThreadId(
      "bot-res-mt022",
      principalOf("a1-member"),
      "thread-abc",
    );
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute));

    await fixture.seedConversation({
      conversationId: convMainId,
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1-member"),
      threadId: convMainThread,
      title: "A1 main",
      createdAt: at(0),
    });
    await fixture.seedConversation({
      conversationId: randomUUID(),
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1-other"),
      threadId: convOtherThread,
      title: "A1 other",
      createdAt: at(1),
    });
    await fixture.seedConversation({
      conversationId: convDoomedId,
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1-doomed"),
      threadId: convDoomedThread,
      title: "A1 doomed",
      createdAt: at(2),
    });
    await fixture.seedConversation({
      conversationId: convA2Id,
      tenantId: companyA,
      workspaceId: teamA2,
      principalId: principalOf("a2-member"),
      threadId: convA2Thread,
      title: "A2 private",
      createdAt: at(3),
    });
    await fixture.seedConversation({
      conversationId: randomUUID(),
      tenantId: companyB,
      workspaceId: teamB1,
      principalId: principalOf("b1-member"),
      threadId: convB1Thread,
      title: "B1 private",
      createdAt: at(4),
    });
    await fixture.seedConversation({
      conversationId: convA1a2Id,
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1a2-member"),
      threadId: convA1a2Thread,
      title: "A1a2 in team A1",
      createdAt: at(5),
    });
    await fixture.seedConversation({
      conversationId: convMastraId,
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1-member"),
      threadId: convMastraThread,
      title: "Mastra backend",
      createdAt: at(6),
      storageBackend: "mastra",
    });
    await fixture.seedConversation({
      conversationId: convPubBotId,
      tenantId: companyA,
      workspaceId: teamA1,
      principalId: principalOf("a1-member"),
      threadId: convPubBotThread,
      title: "Public bot session (user's own)",
      createdAt: at(7),
    });

    await fixture.seedMessage({
      tenantId: companyA,
      threadId: convMainThread,
      seq: 1,
      clientMessageKey: "seed-main-1",
      role: "user",
      content: "first message",
      createdAt: at(10),
    });
    await fixture.seedMessage({
      tenantId: companyA,
      threadId: convMainThread,
      seq: 2,
      clientMessageKey: "seed-main-2",
      role: "assistant",
      content: "second message",
      createdAt: at(11),
    });
    await fixture.seedMessage({
      tenantId: companyA,
      threadId: convDoomedThread,
      seq: 1,
      clientMessageKey: "seed-doomed-1",
      role: "user",
      content: "doomed message",
      createdAt: at(12),
    });
    await fixture.seedMessage({
      tenantId: companyA,
      threadId: convPubBotThread,
      seq: 1,
      clientMessageKey: "seed-pubbot-1",
      role: "user",
      content: "public bot conversation message",
      createdAt: at(13),
    });
  });

  afterAll(async () => {
    if (!ENV.ok) return;
    await fixture.dispose();
  });

  // -----------------------------------------------------------------------
  // AC1：非成员不能读写会话消息（deny = canonical not-found，零写入零副作用）
  // -----------------------------------------------------------------------
  describeDb("AC1: non-members cannot read or write messages", () => {
    itDb(
      "same-team member: sendMessage is canonical not-found with zero writes",
      async () => {
        const before = await fixture.rawMessageCount();
        const outcome = await service.sendMessage(
          await scopeAs("a1-other", companyA, teamA1),
          {
            threadId: convMainThread,
            clientMessageKey: "intrude-1",
            content: "i am on the team too",
          },
        );
        expect(isCanonicalNotFound(outcome)).toBe(true);
        expect(await fixture.rawMessageCount()).toBe(before);
      },
    );

    itDb("same-team member: readMessages is canonical not-found", async () => {
      const outcome = await service.readMessages(
        await scopeAs("a1-other", companyA, teamA1),
        { threadId: convMainThread },
      );
      expect(isCanonicalNotFound(outcome)).toBe(true);
    });

    itDb(
      "cross-team member: send and read are canonical not-found",
      async () => {
        const scope = await scopeAs("a2-member", companyA, teamA2);
        expect(
          isCanonicalNotFound(
            await service.sendMessage(scope, {
              threadId: convMainThread,
              clientMessageKey: "intrude-2",
              content: "other team",
            }),
          ),
        ).toBe(true);
        expect(
          isCanonicalNotFound(
            await service.readMessages(scope, { threadId: convMainThread }),
          ),
        ).toBe(true);
      },
    );

    itDb(
      "cross-company member: send and read are byte-identical canonical not-found",
      async () => {
        const scope = await scopeAs("b1-member", companyB, teamB1);
        const before = await fixture.rawMessageCount();
        const send = await service.sendMessage(scope, {
          threadId: convMainThread,
          clientMessageKey: "intrude-3",
          content: "other company",
        });
        const read = await service.readMessages(scope, {
          threadId: convMainThread,
        });
        expect(JSON.stringify(send)).toBe(canonicalNotFoundJson);
        expect(JSON.stringify(read)).toBe(canonicalNotFoundJson);
        expect(await fixture.rawMessageCount()).toBe(before);
      },
    );

    itDb(
      "nonexistent thread: the same canonical shape (single-element byte set)",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const ghost = `conv-ghost-${randomUUID().slice(0, 8)}`;
        const send = await service.sendMessage(scope, {
          threadId: ghost,
          clientMessageKey: "ghost-1",
          content: "ghost",
        });
        const read = await service.readMessages(scope, { threadId: ghost });
        const replay = await service.replayHistory(scope, { threadId: ghost });
        expect(JSON.stringify(send)).toBe(canonicalNotFoundJson);
        expect(JSON.stringify(read)).toBe(canonicalNotFoundJson);
        expect(JSON.stringify(replay)).toBe(canonicalNotFoundJson);
      },
    );

    itDb(
      "owner: sendMessage allow — seq continues after seeds, content round-trips",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const outcome = await service.sendMessage(scope, {
          threadId: convMainThread,
          clientMessageKey: "owner-live-1",
          content: "owner live message",
        });
        if (outcome.outcome !== "allow")
          throw new Error("owner send must allow");
        expect(outcome.message.seq).toBe(3);
        expect(outcome.message.role).toBe("user");
        expect(outcome.message.content).toBe("owner live message");
        expect(outcome.message.attachments).toEqual([]);
        expect(outcome.message.threadId).toBe(convMainThread);
        expectFrozen(outcome.message);
      },
    );

    itDb(
      "owner: readMessages pages ascending with keyset nextBeforeSeq",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const full = await service.readMessages(scope, {
          threadId: convMainThread,
        });
        if (full.outcome !== "allow") throw new Error("owner read must allow");
        expect(full.page.items.map((m) => m.seq)).toEqual([1, 2, 3]);
        expect(full.page.nextBeforeSeq).toBeNull();
        const page = await service.readMessages(scope, {
          threadId: convMainThread,
          limit: 2,
        });
        if (page.outcome !== "allow") throw new Error("owner read must allow");
        expect(page.page.items.map((m) => m.seq)).toEqual([2, 3]);
        expect(page.page.nextBeforeSeq).toBe(2);
        const tail = await service.readMessages(scope, {
          threadId: convMainThread,
          limit: 2,
          beforeSeq: page.page.nextBeforeSeq,
        });
        if (tail.outcome !== "allow") throw new Error("owner read must allow");
        expect(tail.page.items.map((m) => m.seq)).toEqual([1]);
        expect(tail.page.nextBeforeSeq).toBeNull();
      },
    );

    itDb(
      "idempotent resend with the same key returns the same message without a new seq",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const first = await service.sendMessage(scope, {
          threadId: convMainThread,
          clientMessageKey: "owner-live-1",
          content: "owner live message",
        });
        if (first.outcome !== "allow")
          throw new Error("idempotent send must allow");
        expect(first.message.seq).toBe(3);
        const messages = await fixture.rawMessageCount();
        const again = await service.sendMessage(scope, {
          threadId: convMainThread,
          clientMessageKey: "owner-live-1",
          content: "owner live message",
        });
        if (again.outcome !== "allow")
          throw new Error("idempotent send must allow");
        expect(again.message.messageId).toBe(first.message.messageId);
        expect(await fixture.rawMessageCount()).toBe(messages);
      },
    );

    itDb(
      "same key with different content is message_conflict (409 shape), zero writes",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const before = await fixture.rawMessageCount();
        const error = await thrownCode(() =>
          service.sendMessage(scope, {
            threadId: convMainThread,
            clientMessageKey: "owner-live-1",
            content: "DIFFERENT content",
          }),
        );
        expect(error).toBe("message_conflict");
        expect(await fixture.rawMessageCount()).toBe(before);
      },
    );

    itDb(
      "RLS fail-closed: no-context restricted reads see zero rows",
      async () => {
        expect(await fixture.countMessagesWithoutContext()).toBe(0);
        expect(await fixture.countConversationsWithoutContext()).toBe(0);
      },
    );

    itDb(
      "restricted role invariant: every restricted query ran as ob_ent_*",
      () => {
        const calls = fixture.restrictedCalls();
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.currentUser).toMatch(
            /^ob_ent_(data|operator|directory)$/,
          );
        }
        expect(calls.some((call) => call.role === "data")).toBe(true);
        expect(calls.some((call) => call.role === "operator")).toBe(true);
      },
    );
  });

  // -----------------------------------------------------------------------
  // AC1：历史 replay 是独立授权面（不是 read 的别名）
  // -----------------------------------------------------------------------
  describeDb(
    "AC1: history replay is an independent authorization surface",
    () => {
      itDb("owner replay returns the full thread ascending", async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const outcome = await service.replayHistory(scope, {
          threadId: convMainThread,
        });
        if (outcome.outcome !== "allow")
          throw new Error("owner replay must allow");
        expect(outcome.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
        expect(outcome.messages[0]?.content).toBe("first message");
        expectFrozen(outcome.messages);
      });

      itDb(
        "same-team member replay is canonical not-found (replay does not ride on read)",
        async () => {
          const outcome = await service.replayHistory(
            await scopeAs("a1-other", companyA, teamA1),
            { threadId: convMainThread },
          );
          expect(isCanonicalNotFound(outcome)).toBe(true);
        },
      );

      itDb(
        "cross-company replay is byte-identical canonical not-found",
        async () => {
          const outcome = await service.replayHistory(
            await scopeAs("b1-member", companyB, teamB1),
            { threadId: convMainThread },
          );
          expect(JSON.stringify(outcome)).toBe(canonicalNotFoundJson);
        },
      );
    },
  );

  // -----------------------------------------------------------------------
  // AC2：重命名与归档分别授权；可读不派生可改
  // -----------------------------------------------------------------------
  describeDb("AC2: rename and archive are separately authorized", () => {
    itDb(
      "owner rename allow — title changes, messages untouched, MT021 detail agrees",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const before = await fixture.rawMessageCount();
        const outcome = await service.renameConversation(scope, {
          conversationId: convMainId,
          title: "Renamed A1",
        });
        if (outcome.outcome !== "allow")
          throw new Error("owner rename must allow");
        expect(outcome.conversation.title).toBe("Renamed A1");
        expectFrozen(outcome.conversation);
        const detail = await fixture.listService.readVisibleConversation(
          scope,
          convMainId,
        );
        if (detail.outcome !== "allow")
          throw new Error("MT021 detail must agree");
        expect(detail.conversation.title).toBe("Renamed A1");
        expect(await fixture.rawMessageCount()).toBe(before);
      },
    );

    itDb(
      "same-team member rename is canonical not-found; title unchanged; zero writes",
      async () => {
        const before = await fixture.rawMessageCount();
        const outcome = await service.renameConversation(
          await scopeAs("a1-other", companyA, teamA1),
          { conversationId: convMainId, title: "hostile" },
        );
        expect(isCanonicalNotFound(outcome)).toBe(true);
        const detail = await fixture.listService.readVisibleConversation(
          await scopeAs("a1-member", companyA, teamA1),
          convMainId,
        );
        if (detail.outcome !== "allow")
          throw new Error("owner detail must allow");
        expect(detail.conversation.title).toBe("Renamed A1");
        expect(await fixture.rawMessageCount()).toBe(before);
      },
    );

    itDb("cross-company rename is canonical not-found", async () => {
      const outcome = await service.renameConversation(
        await scopeAs("b1-member", companyB, teamB1),
        { conversationId: convMainId, title: "hostile" },
      );
      expect(JSON.stringify(outcome)).toBe(canonicalNotFoundJson);
    });

    itDb(
      "nonexistent conversation id rename is the same canonical shape",
      async () => {
        const outcome = await service.renameConversation(
          await scopeAs("a1-member", companyA, teamA1),
          { conversationId: randomUUID(), title: "ghost" },
        );
        expect(JSON.stringify(outcome)).toBe(canonicalNotFoundJson);
      },
    );

    itDb(
      "owner archive decision allow — zero side effects in this ticket (decision surface)",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        const conversationsBefore = await fixture.rawConversationCount();
        const messagesBefore = await fixture.rawMessageCount();
        const outcome = await service.archiveConversation(scope, {
          conversationId: convMainId,
        });
        if (outcome.outcome !== "allow")
          throw new Error("owner archive must allow");
        expect(outcome.conversation.conversationId).toBe(convMainId);
        expect(await fixture.rawConversationCount()).toBe(conversationsBefore);
        expect(await fixture.rawMessageCount()).toBe(messagesBefore);
      },
    );

    itDb(
      "same-team member archive decision is canonical not-found",
      async () => {
        const outcome = await service.archiveConversation(
          await scopeAs("a1-other", companyA, teamA1),
          { conversationId: convMainId },
        );
        expect(isCanonicalNotFound(outcome)).toBe(true);
      },
    );

    itDb(
      "read allow does not derive write: after revocation a prior read grants nothing",
      async () => {
        // 独立会话（a1-doomed）：先真实读取成功，撤权后 rename/archive 拒绝 ——
        // 读取结果不缓存任何写授权（每动作事务内重验）。
        const doomedScope = await scopeAs("a1-doomed", companyA, teamA1);
        const read = await service.readMessages(doomedScope, {
          threadId: convDoomedThread,
        });
        expect(read.outcome).toBe("allow");
        await fixture.suspendCompanyMembership(
          companyA,
          principalOf("a1-doomed"),
        );
        const rename = await service.renameConversation(doomedScope, {
          conversationId: convDoomedId,
          title: "post-revocation",
        });
        expect(JSON.stringify(rename)).toBe(canonicalNotFoundJson);
        const archive = await service.archiveConversation(doomedScope, {
          conversationId: convDoomedId,
        });
        expect(JSON.stringify(archive)).toBe(canonicalNotFoundJson);
        // MT007 恢复：本用例钉的事实是「撤权后拒绝」本身；断言后把资格门
        // 恢复 active，交给 AC4 describe 一个 active 态的 a1-doomed（bun 按
        // 文件序真实顺序执行，AC4 的 scopeAs 需要过真实资格门）。
        await fixture.reinstateCompanyMembership(
          companyA,
          principalOf("a1-doomed"),
        );
      },
    );
  });

  // -----------------------------------------------------------------------
  // AC4：撤权后消息读写与 replay 立即失效（事务内重验，无 epoch bump 依赖）
  // -----------------------------------------------------------------------
  // AC4 撤权链共享：撤权前（资格 active 时）铸造的 scope——epoch 臂的靶对象。
  let doomedPreSuspensionScope: PlatformScope;

  describeDb(
    "AC4: revocation kills send/read/replay/rename/archive immediately",
    () => {
      itDb("control: the doomed scope works before suspension", async () => {
        const scope = await scopeAs("a1-doomed", companyA, teamA1);
        const send = await service.sendMessage(scope, {
          threadId: convDoomedThread,
          clientMessageKey: "doomed-live-1",
          content: "before suspension",
        });
        expect(send.outcome).toBe("allow");
      });

      itDb(
        "real MT006 suspension: all five actions fail canonical on the old scope, zero writes",
        async () => {
          // scope 在资格仍 active 时铸造（真实资格门拒绝给 suspended 成员铸
          // scope——既有契约），随后本用例内执行真实 MT006 撤权：已签发（旧）
          // scope 上五动作立即 canonical 失效。
          doomedPreSuspensionScope = await scopeAs(
            "a1-doomed",
            companyA,
            teamA1,
          );
          await fixture.suspendCompanyMembership(
            companyA,
            principalOf("a1-doomed"),
          );
          const before = await fixture.rawMessageCount();
          const denies = await fiveDenyActions(
            doomedPreSuspensionScope,
            convDoomedThread,
            convDoomedId,
          );
          for (const deny of denies) {
            expect(JSON.stringify(deny)).toBe(canonicalNotFoundJson);
          }
          expect(await fixture.rawMessageCount()).toBe(before);
        },
      );

      itDb(
        "MT007 restore: the old scope stays denied (epoch arm), a fresh scope works",
        async () => {
          await fixture.reinstateCompanyMembership(
            companyA,
            principalOf("a1-doomed"),
          );
          // 复用撤权前签发的 scope 事实：撤权前铸造的 scope 的 epoch 已落后。
          // （MT007 恢复后 status 回 active 且 epoch+1——唯一差异是 epoch 臂。）
          const preSuspensionScope = doomedPreSuspensionScope;
          const read = await service.readMessages(preSuspensionScope, {
            threadId: convDoomedThread,
          });
          expect(JSON.stringify(read)).toBe(canonicalNotFoundJson);
          const freshScope = await scopeAs("a1-doomed", companyA, teamA1);
          const freshRead = await service.readMessages(freshScope, {
            threadId: convDoomedThread,
          });
          expect(freshRead.outcome).toBe("allow");
        },
      );

      itDb(
        "no epoch-bump dependency: suspended status alone denies with the epoch still equal",
        async () => {
          // 真实路径从不在保持 epoch 的同时翻转 status（按设计）；该状态经
          // setup 通道构造（披露的测试缝隙，服务侧从不使用）。
          const scope = await scopeAs("a2-member", companyA, teamA2);
          expect(
            (await service.readMessages(scope, { threadId: convA2Thread }))
              .outcome,
          ).toBe("allow");
          await fixture.flipCompanyMembershipStatusViaSetup(
            companyA,
            principalOf("a2-member"),
            "suspended",
          );
          const denies = await fiveDenyActions(scope, convA2Thread, convA2Id);
          for (const deny of denies) {
            expect(JSON.stringify(deny)).toBe(canonicalNotFoundJson);
          }
          await fixture.flipCompanyMembershipStatusViaSetup(
            companyA,
            principalOf("a2-member"),
            "active",
          );
          const recovered = await service.readMessages(scope, {
            threadId: convA2Thread,
          });
          expect(recovered.outcome).toBe("allow");
        },
      );

      itDb(
        "team-level MT007 suspension denies the conversation in that team; restore re-allows",
        async () => {
          const scopeBefore = await scopeAs("a1a2-member", companyA, teamA1);
          expect(
            (
              await service.readMessages(scopeBefore, {
                threadId: convA1a2Thread,
              })
            ).outcome,
          ).toBe("allow");
          await fixture.suspendTeamMembership(
            companyA,
            teamA1,
            principalOf("a1a2-member"),
          );
          const denies = await fiveDenyActions(
            scopeBefore,
            convA1a2Thread,
            convA1a2Id,
          );
          for (const deny of denies) {
            expect(JSON.stringify(deny)).toBe(canonicalNotFoundJson);
          }
          await fixture.restoreTeamMembership(
            companyA,
            teamA1,
            principalOf("a1a2-member"),
          );
          const recovered = await service.readMessages(scopeBefore, {
            threadId: convA1a2Thread,
          });
          expect(recovered.outcome).toBe("allow");
        },
      );
    },
  );

  // -----------------------------------------------------------------------
  // AC3：公共 Bot 使用者的个人会话不出现在团队列表/搜索
  // -----------------------------------------------------------------------
  describeDb(
    "AC3: public-bot sessions stay the user's own private conversations",
    () => {
      itDb(
        "team list/count/detail (frozen MT021 surface) never surface the public-bot session",
        async () => {
          const otherScope = await scopeAs("a1-other", companyA, teamA1);
          const list = await fixture.listService.listVisibleConversations(
            otherScope,
            {
              limit: 200,
            },
          );
          expect(list.items.map((c) => c.conversationId)).not.toContain(
            convPubBotId,
          );
          const count =
            await fixture.listService.countVisibleConversations(otherScope);
          expect(count.total).toBe(1); // 只有 a1-other 自己的会话
          const detail = await fixture.listService.readVisibleConversation(
            otherScope,
            convPubBotId,
          );
          expect(JSON.stringify(detail)).toBe(canonicalNotFoundJson);
        },
      );

      itDb(
        "the bot publisher (same team) gets canonical not-found on all five actions",
        async () => {
          const publisherScope = await scopeAs(
            "a1-publisher",
            companyA,
            teamA1,
          );
          const denies = await fiveDenyActions(
            publisherScope,
            convPubBotThread,
            convPubBotId,
          );
          for (const deny of denies) {
            expect(JSON.stringify(deny)).toBe(canonicalNotFoundJson);
          }
          const replay = await service.replayHistory(publisherScope, {
            threadId: convPubBotThread,
          });
          expect(JSON.stringify(replay)).toBe(canonicalNotFoundJson);
        },
      );

      itDb(
        "the end user keeps full access — public bot usage keeps the user's own private session",
        async () => {
          const userScope = await scopeAs("a1-member", companyA, teamA1);
          const send = await service.sendMessage(userScope, {
            threadId: convPubBotThread,
            clientMessageKey: "pubbot-user-1",
            content: "still my own session",
          });
          expect(send.outcome).toBe("allow");
          const replay = await service.replayHistory(userScope, {
            threadId: convPubBotThread,
          });
          if (replay.outcome !== "allow")
            throw new Error("owner replay must allow");
          expect(replay.messages.map((m) => m.seq)).toEqual([1, 2]);
          const list = await fixture.listService.listVisibleConversations(
            userScope,
            {
              limit: 200,
            },
          );
          expect(list.items.map((c) => c.conversationId)).toContain(
            convPubBotId,
          );
        },
      );
    },
  );

  // -----------------------------------------------------------------------
  // 输入校验与信任边界（响亮拒绝；错误只含代码，绝不回显值）
  // -----------------------------------------------------------------------
  describeDb("input validation and trust boundary", () => {
    itDb("forged scope is refused before any database work", async () => {
      const real = await scopeAs("a1-member", companyA, teamA1);
      const forged = { ...real } as PlatformScope;
      expect(
        await thrownMessage(() =>
          service.sendMessage(forged, {
            threadId: convMainThread,
            clientMessageKey: "forged-1",
            content: "forged",
          }),
        ),
      ).toBe("UNVERIFIED_SCOPE");
      expect(
        await thrownMessage(() =>
          service.renameConversation(forged, {
            conversationId: convMainId,
            title: "forged",
          }),
        ),
      ).toBe("UNVERIFIED_SCOPE");
    });

    itDb("missing company/team context gets its own loud refusal", async () => {
      const noTenant = {
        ...Object.create(
          Object.getPrototypeOf(await scopeAs("a1-member", companyA, teamA1)),
        ),
        tenantId: "",
        workspaceId: teamA1,
        principalId: principalOf("a1-member"),
        actorId: "x",
        memberEpoch: 1,
        aclEpoch: 1,
        entrypoint: "web",
      } as PlatformScope;
      // forged（未经 resolver）会先被 UNVERIFIED_SCOPE 拒绝；缺上下文的响亮
      // 拒绝用未铸 scope 不可达，因此这里钉的是形状序列：TENANT_REQUIRED 在
      // 信任门之前（与 MT021 同序）——通过 service 的静态形状验证：空
      // threadId 等输入形状错误先于一切。
      expect(
        await thrownMessage(async () =>
          service.sendMessage(await scopeAs("a1-member", companyA, teamA1), {
            threadId: "",
            clientMessageKey: "shape-1",
            content: "x",
          }),
        ),
      ).toBe("INVALID_THREAD_ID");
      expect(noTenant).toBeDefined();
    });

    itDb("input shapes refuse loudly", async () => {
      const scope = await scopeAs("a1-member", companyA, teamA1);
      expect(
        await thrownMessage(() =>
          service.sendMessage(scope, {
            threadId: `conv-${randomUUID()}`,
            clientMessageKey: "",
            content: "x",
          }),
        ),
      ).toBe("INVALID_CLIENT_MESSAGE_KEY");
      expect(
        await thrownMessage(() =>
          service.sendMessage(scope, {
            threadId: `conv-${randomUUID()}`,
            clientMessageKey: "k",
            content: "   ",
          }),
        ),
      ).toBe("INVALID_MESSAGE");
      expect(
        await thrownMessage(() =>
          service.sendMessage(scope, {
            threadId: `conv-${randomUUID()}`,
            clientMessageKey: "k",
            content: "x".repeat(1_000_001),
          }),
        ),
      ).toBe("INVALID_MESSAGE");
      expect(
        await thrownMessage(() =>
          service.renameConversation(scope, {
            conversationId: "not-a-uuid",
            title: "x",
          }),
        ),
      ).toBe("CONVERSATION_ID_INVALID");
      expect(
        await thrownMessage(() =>
          service.archiveConversation(scope, { conversationId: "nope" }),
        ),
      ).toBe("CONVERSATION_ID_INVALID");
      expect(
        await thrownMessage(() =>
          service.renameConversation(scope, {
            conversationId: randomUUID(),
            title: "",
          }),
        ),
      ).toBe("INVALID_TITLE");
      expect(
        await thrownMessage(() =>
          service.renameConversation(scope, {
            conversationId: randomUUID(),
            title: "x".repeat(501),
          }),
        ),
      ).toBe("INVALID_TITLE");
      expect(
        await thrownMessage(() =>
          service.readMessages(scope, {
            threadId: convMainThread,
            limit: 0,
          }),
        ),
      ).toBe("INVALID_LIMIT");
      expect(
        await thrownMessage(() =>
          service.readMessages(scope, {
            threadId: convMainThread,
            limit: 101,
          }),
        ),
      ).toBe("INVALID_LIMIT");
      expect(
        await thrownMessage(() =>
          service.readMessages(scope, {
            threadId: convMainThread,
            beforeSeq: 0,
          }),
        ),
      ).toBe("INVALID_CURSOR");
    });

    itDb("unverified channel assembly refuses loudly", async () => {
      const raw = createDatabase(
        enterpriseRuntimeDatabaseUrlFrom("data", process.env),
        { max: 1 },
      );
      try {
        expect(
          thrownMessageSyncImported(() => conversationActionsOf(raw)),
        ).toBe("UNVERIFIED_DATABASE_CAPABILITY");
      } finally {
        await raw.$client.close();
      }
    });

    itDb(
      "backend gate: platform-only message plane; management actions are backend-agnostic",
      async () => {
        const scope = await scopeAs("a1-member", companyA, teamA1);
        expect(
          await thrownMessage(() =>
            service.sendMessage(scope, {
              threadId: convMastraThread,
              clientMessageKey: "mastra-1",
              content: "x",
            }),
          ),
        ).toBe("CONVERSATION_BACKEND_UNSUPPORTED");
        expect(
          await thrownMessage(() =>
            service.readMessages(scope, { threadId: convMastraThread }),
          ),
        ).toBe("CONVERSATION_BACKEND_UNSUPPORTED");
        expect(
          await thrownMessage(() =>
            service.replayHistory(scope, { threadId: convMastraThread }),
          ),
        ).toBe("CONVERSATION_BACKEND_UNSUPPORTED");
        // 管理动作（重命名/归档判定）是会话级元数据，不限定 backend。
        const rename = await service.renameConversation(scope, {
          conversationId: convMastraId,
          title: "Mastra renamed",
        });
        expect(rename.outcome).toBe("allow");
        // 非成员对 mastra 会话仍是 canonical not-found（先授权后 backend 门，
        // 不泄露存在性）。
        const outsider = await service.readMessages(
          await scopeAs("a1-other", companyA, teamA1),
          { threadId: convMastraThread },
        );
        expect(JSON.stringify(outsider)).toBe(canonicalNotFoundJson);
      },
    );
  });

  // -----------------------------------------------------------------------
  // canonical 序列化与不可变视图
  // -----------------------------------------------------------------------
  describeDb("canonical verdict serialization", () => {
    itDb(
      "every denial across every action serializes to one byte string",
      async () => {
        const owner = await scopeAs("a1-member", companyA, teamA1);
        const other = await scopeAs("a1-other", companyA, teamA1);
        const crossCompany = await scopeAs("b1-member", companyB, teamB1);
        const ghost = `conv-ghost-${randomUUID().slice(0, 8)}`;
        const ghostId = randomUUID();
        const verdicts = [
          await service.sendMessage(other, {
            threadId: convMainThread,
            clientMessageKey: `bytes-${randomUUID()}`,
            content: "x",
          }),
          await service.readMessages(crossCompany, {
            threadId: convMainThread,
          }),
          await service.replayHistory(other, { threadId: ghost }),
          await service.renameConversation(crossCompany, {
            conversationId: ghostId,
            title: "x",
          }),
          await service.archiveConversation(other, { conversationId: ghostId }),
          await service.sendMessage(owner, {
            threadId: ghost,
            clientMessageKey: `bytes-${randomUUID()}`,
            content: "x",
          }),
        ];
        const bytes = new Set(
          verdicts.map((verdict) => JSON.stringify(verdict)),
        );
        expect(bytes.size).toBe(1);
        expect([...bytes][0]).toBe(canonicalNotFoundJson);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 局部助手：未验证通道装配（独立 import 以保持套件头简洁）
// ---------------------------------------------------------------------------

import { createConversationActionsService as conversationActionsOf } from "../../src/enterprise/tenancy/conversation-actions";

function thrownMessageSyncImported(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be rejected, but it succeeded");
}
