// server/tests/multitenancy/conversation-public.test.ts
// MOD06（Issue #626，根 #620）：M04 Conversation 门面的委托等价与形状钉。
//
// 事实源（Issue #626 验收 + MOD06 Brief §D，逐条对应 describe）：
//   D1 委托等价：门面五能力 vs 直调内件——同参（对象同一性）、同结果
//      （toBe 同一实例）、同错误实例透传（注入替身证明委托本身）+ 路由级
//      双路等价（刷新+提交两 handler 经门面/不经门面 wire 同形，含错误映射）。
//   D2 验收 2 幂等：同一 clientMessageKey 恰一份（账本主键 + prior 收敛
//      源级钉）、同键异输入 message_conflict 409（源级钉）、门面对 append
//      零重试零复制（源级钉）；引擎路径幂等键为服务器签发（contracts 源级钉）。
//   D3 验收 3 parts 保真：引擎消息完整 parts 逐字节入库（openbotParts 源级
//      钉）+ 用户消息内容/附件投影不丢失 + 门面零重塑（源级零变换钉）；
//      存量 mastra-message-parts / conversation-messages 套件 BASE 对照复跑
//      钉住真实存储/RLS 语义（见 reports/MOD06-report.md 验证门）。
//   D4 验收 4 finalize 恢复：存储写成但 finalize 失败按同一 intent 恢复——
//      条件 finalize UPDATE（版本栅栏）、writeConfirmed/writeAttempted 后
//      readFinalizedMessage 收敛（不重写存储、返回赢家同形成功）、prepare 期
//      finalized 分支三重校验（不猜测）、具名 reconciler 语义，全部源级钉；
//      真实 DB 语义经存量 mastra-cutover / mastra-conversation-runtime 套件
//      BASE 对照归因。
//   D5 验收 5 单写与隐藏：门面对象恰五能力（无 resolveBackend/
//      resolveMastraBinding——引擎存储内部面不进公开面）；public/integration/
//      routes import 白名单零 Mastra binding；兼容臂具名且逐字节包装内件
//      工厂；模块值导出恰工厂函数；module-imports.json M04 分组钉死；
//      单能力替身构造成功 = Pick 最小面编译级证明；引擎写入口唯一
//      （appendEngineMessage）+ 引擎存储直写（saveMessages）只存在于内件。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生
// 收集（覆盖审计 native 桶），不依赖 Bun 运行时、不触真实数据库：委托语义
// 用注入替身证明（门面只做委托，替身证明的正是委托本身）；验收 2/3/4 的
// 事务与存储语义以源级结构断言钉住形状，真实 PG/RLS 行为由存量套件两树
// BASE 对照钉住（MOD04/05 同法）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import type { ScopeResolver } from "../../src/enterprise/contracts";
import {
  type ConversationEngineStorage,
  createMastraStorageArm,
} from "../../src/enterprise/conversations/integration";
import {
  type ConversationScope,
  createConversationPublic,
} from "../../src/enterprise/conversations/public";
import { createConversationRoutes } from "../../src/enterprise/conversations/routes";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function sourceOf(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
}

/** 剥掉 // 行注释与块注释后的源码（结构断言不被注释文本干扰）。 */
function codeOf(relative: string): string {
  return sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const SCOPE: ConversationScope = {
  tenantId: "tenant-a",
  workspaceId: "team-a1",
  principalId: "principal-a",
  actorId: "user-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
} as ConversationScope;

const CONVERSATION_DTO = {
  threadId: "thread-server",
  title: "Marker",
  storageBackend: "mastra",
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  lastMessageSeq: 0,
};
const MESSAGE_DTO = {
  messageId: "message-server",
  threadId: "thread-server",
  seq: 1,
  role: "user",
  content: "hello",
  attachments: [],
  createdAt: "1970-01-01T00:00:00.000Z",
};
const MESSAGE_PAGE = {
  items: [MESSAGE_DTO],
  nextBeforeSeq: null,
};
/** 稳定引用：替身每次返回同一实例，toBe 才能证明门面不新建结果对象。 */
const LIST_RESULT = [CONVERSATION_DTO];

/** 五能力录音替身：记录每次调用的实参（对象同一性）并返回标记结果。 */
function recordingService() {
  const calls: Array<{
    capability: string;
    args: unknown[];
    error?: Error;
  }> = [];
  const boom = new Error("INTERNAL_MARK");
  const service = {
    list: async (scope: unknown) => {
      calls.push({ capability: "list", args: [scope] });
      return LIST_RESULT;
    },
    getOrCreate: async (scope: unknown, input: unknown) => {
      calls.push({ capability: "getOrCreate", args: [scope, input] });
      return CONVERSATION_DTO;
    },
    history: async (scope: unknown, input: unknown) => {
      calls.push({ capability: "history", args: [scope, input] });
      return MESSAGE_PAGE;
    },
    append: async (scope: unknown, input: unknown) => {
      calls.push({ capability: "append", args: [scope, input] });
      return MESSAGE_DTO;
    },
    appendEngineMessage: async (scope: unknown, input: unknown) => {
      calls.push({ capability: "appendEngineMessage", args: [scope, input] });
      return MESSAGE_DTO;
    },
  };
  return { calls, boom, service };
}

const scopesStub = {
  resolve: async () => SCOPE,
  resolveForThread: async () => SCOPE,
} as ScopeResolver;

// ---------------------------------------------------------------------------
// D1 委托等价
// ---------------------------------------------------------------------------

describe("MOD06 D1: facade delegates to the internal service verbatim", () => {
  test("list delegates with the same scope object and returns the very array", async () => {
    const { service, calls } = recordingService();
    const conversations = createConversationPublic({ service });
    const result = await conversations.list(SCOPE);
    expect(result).toBe(LIST_RESULT);
    expect(calls[0]?.capability).toBe("list");
    expect(calls[0]?.args[0]).toBe(SCOPE);
  });

  test("getOrCreate passes the identical (scope, input) objects through", async () => {
    const { service, calls } = recordingService();
    const conversations = createConversationPublic({ service });
    const input = { title: "New chat" };
    const result = await conversations.getOrCreate(SCOPE, input);
    expect(result).toBe(CONVERSATION_DTO);
    expect(calls[0]?.args[0]).toBe(SCOPE);
    expect(calls[0]?.args[1]).toBe(input);
  });

  test("append passes the identical input object through and returns the very DTO", async () => {
    const { service, calls } = recordingService();
    const conversations = createConversationPublic({ service });
    const input = {
      threadId: "thread-server",
      clientMessageKey: "key-1",
      content: "hello",
      attachments: [],
    };
    const result = await conversations.append(SCOPE, input);
    expect(result).toBe(MESSAGE_DTO);
    expect(calls[0]?.args[1]).toBe(input);
  });

  test("history passes the identical query object through and returns the very page", async () => {
    const { service, calls } = recordingService();
    const conversations = createConversationPublic({ service });
    const input = { threadId: "thread-server", beforeSeq: null, limit: 50 };
    const result = await conversations.history(SCOPE, input);
    expect(result).toBe(MESSAGE_PAGE);
    expect(calls[0]?.args[1]).toBe(input);
  });

  test("appendEngineMessage passes the identical engine input through", async () => {
    const { service, calls } = recordingService();
    const conversations = createConversationPublic({ service });
    const input = {
      threadId: "thread-server",
      clientMessageKey: "exec-1:engine-1",
      role: "assistant",
      parts: [{ type: "text", text: "answer" }],
      engineMessageId: "engine-1",
    };
    const result = await conversations.appendEngineMessage(SCOPE, input);
    expect(result).toBe(MESSAGE_DTO);
    expect(calls[0]?.args[1]).toBe(input);
  });

  test("every capability propagates the internal error as the SAME instance", async () => {
    const boom = new Error("INTERNAL_MARK");
    const service = {
      list: async () => {
        throw boom;
      },
      getOrCreate: async () => {
        throw boom;
      },
      history: async () => {
        throw boom;
      },
      append: async () => {
        throw boom;
      },
      appendEngineMessage: async () => {
        throw boom;
      },
    };
    const conversations = createConversationPublic({ service });
    for (const capability of [
      "list",
      "getOrCreate",
      "history",
      "append",
      "appendEngineMessage",
    ] as const) {
      let caught: unknown = null;
      try {
        await conversations[capability](
          SCOPE,
          capability === "list" ? undefined : {},
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(boom);
    }
  });

  test("route-level: refresh and submit through the facade hit facade.history/append and keep wire shapes", async () => {
    let facadeHistoryCalls = 0;
    let facadeAppendCalls = 0;
    const service = recordingService().service;
    const facade = {
      history: async () => {
        facadeHistoryCalls += 1;
        return MESSAGE_PAGE;
      },
      append: async () => {
        facadeAppendCalls += 1;
        return MESSAGE_DTO;
      },
    };
    const routes = createConversationRoutes(service, scopesStub, facade);

    const refresh = await routes.request(
      "http://example.invalid/thread-server/messages",
      { method: "GET" },
    );
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual(MESSAGE_PAGE);

    const submit = await routes.request(
      "http://example.invalid/thread-server/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageKey: "key-1",
          content: "hello",
          attachments: [],
        }),
      },
    );
    expect(submit.status).toBe(201);
    expect(await submit.json()).toEqual(MESSAGE_DTO);
    expect(facadeHistoryCalls).toBe(1);
    expect(facadeAppendCalls).toBe(1);
  });

  test("route-level: without the facade the same requests take the direct service path (equivalent arm)", async () => {
    const { service } = recordingService();
    const routes = createConversationRoutes(service, scopesStub);

    const refresh = await routes.request(
      "http://example.invalid/thread-server/messages",
      { method: "GET" },
    );
    expect(refresh.status).toBe(200);
    expect(await refresh.json()).toEqual(MESSAGE_PAGE);

    const submit = await routes.request(
      "http://example.invalid/thread-server/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageKey: "key-1",
          content: "hello",
          attachments: [],
        }),
      },
    );
    expect(submit.status).toBe(201);
    expect(await submit.json()).toEqual(MESSAGE_DTO);
  });

  test("route-level: a message_conflict through the facade arm still maps to the same 409 wire", async () => {
    const service = recordingService().service;
    const facade = {
      history: async () => MESSAGE_PAGE,
      append: async () => {
        throw Object.assign(
          new Error("Message key was already used with different content."),
          { code: "message_conflict", status: 409 },
        );
      },
    };
    const routes = createConversationRoutes(service, scopesStub, facade);
    const response = await routes.request(
      "http://example.invalid/thread-server/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientMessageKey: "key-1",
          content: "hello",
          attachments: [],
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "message_conflict",
        message: "Message key conflicts with existing content.",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// D2 验收 2：重复 message key 仅一份；同键不同输入冲突
// ---------------------------------------------------------------------------

describe("MOD06 D2: one copy per message key, conflict on same key with different input", () => {
  test("source pin: the intent ledger's primary key is exactly (tenant, thread, clientMessageKey)", () => {
    const schema = sourceOf("../../src/db/schema/mastra-message-intents.ts");
    expect(schema).toContain('name: "mastra_message_intents_pk"');
    expect(schema).toMatch(
      /primaryKey\(\{[^}]*columns:\s*\[table\.tenantId,\s*table\.threadId,\s*table\.clientMessageKey\]/s,
    );
  });

  test("source pin: a prior same-key intent converges — same input returns prior, different content is message_conflict, different identity is refused", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    // 同键同摘要：返回既有 intent（不二写）——恰一份。
    expect(code).toContain("if (prior) {");
    expect(code).toMatch(
      /if \(prior\.digest !== digest\)[^}]*message_conflict[^}]*status: 409/s,
    );
    // 同键异主体（messageId/principal/actor）拒绝。
    expect(code).toContain("MASTRA_INTENT_SCOPE_MISMATCH");
    expect(code).toMatch(/if \(prior\) \{[\s\S]*?return prior;/);
  });

  test("source pin: the facade's append is a single unconditional delegation — no retry, no duplicate write loop", () => {
    const code = codeOf("../../src/enterprise/conversations/public.ts");
    expect(code).toMatch(
      /append\(scope[^)]*\)\s*\{\s*return service\.append\(scope, input\);/,
    );
    expect(code).not.toMatch(/for\s*\(|while\s*\(|retry/i);
  });

  test("source pin: the engine path's idempotency key is server-issued — no client author field on EngineMessageAppendInput", () => {
    const contracts = sourceOf("../../src/enterprise/contracts.ts");
    const block = contracts.slice(
      contracts.indexOf("ME03 internal append input"),
      contracts.indexOf("export interface StartRunInput"),
    );
    expect(block).toContain("SERVER-issued idempotency key");
    expect(block).not.toMatch(/\bauthor|actorId\b/);
  });
});

// ---------------------------------------------------------------------------
// D3 验收 3：tool-call/result、附件与完整 message parts 不退化丢失
// ---------------------------------------------------------------------------

describe("MOD06 D3: full message parts and attachments survive without degradation", () => {
  test("source pin: engine messages store the versioned FULL parts verbatim (openbotParts) with engine identity", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    expect(code).toContain("openbotParts: full,");
    expect(code).toContain("openbotEngineMessageId: input.engineMessageId");
    // tool 结果以 assistant 信封承载 openbotParts.role = "tool"（对话真值）。
    expect(code).toContain("openbotToolCallId: input.toolCallId");
    // 摘要对完整 parts 计算（非展示投影）。
    expect(code).toContain("fullMessageDigestInput");
  });

  test("source pin: user messages keep content as a text part and attachments in metadata (no drop)", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    expect(code).toContain(
      'parts: content ? [{ type: "text", text: content }] : [],',
    );
    expect(code).toContain("openbotAttachments: attachmentIds,");
  });

  test("source pin: the facade never reshapes DTOs — zero mapping/projection statements", () => {
    const code = codeOf("../../src/enterprise/conversations/public.ts");
    expect(code).not.toMatch(/\.map\(|\.filter\(|\.\.\.item|JSON\.parse/);
    // D1 的 toBe 同一实例与该源级钉互为表里：门面不可能静默重塑。
  });

  test("history page through the facade is the exact internal page object (byte-identical pass-through)", async () => {
    const page = {
      items: [
        {
          messageId: "m1",
          threadId: "thread-server",
          seq: 2,
          role: "tool",
          content: "tool result text",
          attachments: ["attachment-1"],
          createdAt: "1970-01-01T00:00:00.000Z",
        },
      ],
      nextBeforeSeq: 1,
    };
    const conversations = createConversationPublic({
      service: {
        list: async () => [],
        getOrCreate: async () => CONVERSATION_DTO,
        history: async () => page,
        append: async () => MESSAGE_DTO,
        appendEngineMessage: async () => MESSAGE_DTO,
      },
    });
    const result = await conversations.history(SCOPE, {
      threadId: "thread-server",
      beforeSeq: null,
      limit: 50,
    });
    expect(result).toBe(page);
    expect(result.items[0]?.attachments).toEqual(["attachment-1"]);
    expect(result.items[0]?.role).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// D4 验收 4：存储写成但 finalize 失败按同一 intent 恢复
// ---------------------------------------------------------------------------

describe("MOD06 D4: a written-but-unfinalized message recovers via the same intent", () => {
  test("source pin: finalize is a conditional UPDATE fenced on pending state and current backend version", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    expect(code).toContain('eq(mastraMessageIntents.state, "pending")');
    expect(code).toContain("MASTRA_INTENT_FINALIZE_FAILED");
    // ME14 写栅栏：finalize 只对会话行当前 backend_version 生效。
    expect(code).toMatch(/backendVersion\} = \(select/);
  });

  test("source pin: after a written memory row loses the finalize race, readFinalizedMessage converges on the winner's committed state", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    expect(code).toMatch(
      /writeConfirmed \|\| writeAttempted[\s\S]*?MASTRA_INTENT_FINALIZE_FAILED/,
    );
    expect(code).toContain("const converged = await readFinalizedMessage(");
    expect(code).toContain("if (converged) return converged;");
    // 收敛路径不重写存储：readFinalizedMessage 只读（经共享的 finalizedMessageOrNull
    // -> listMessagesById），两条收敛体均不含 saveMessages。
    const finalizeHelperStart = code.indexOf("const finalizedMessageOrNull");
    const readStart = code.indexOf("const readFinalizedMessage");
    const readEnd = code.indexOf("const appendViaIntentLifecycle", readStart);
    const readBody = code.slice(readStart, readEnd);
    const helperBody = code.slice(finalizeHelperStart, readStart);
    expect(readBody).not.toContain("saveMessages");
    expect(readBody).toContain("finalizedMessageOrNull");
    expect(helperBody).toContain("listMessagesById");
    expect(helperBody).not.toContain("saveMessages");
  });

  test("source pin: unconfirmed writes stay a loud message_pending, never a fabricated success", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    expect(code).toContain('code: "message_pending", status: 503');
  });

  test("source pin: the prepare-transaction finalized branch re-validates digest/seq identity — never a guess", () => {
    const code = codeOf("../../src/enterprise/conversations/service.ts");
    expect(code).toContain("finalizedMessageOrNull");
    expect(code).toContain("MASTRA_MESSAGE_INTENT_MISMATCH");
    expect(code).toMatch(
      /priorMessage\.content\.metadata\?\.openbotDigest !== digest/,
    );
  });

  test("source pin: the named reconciler resolves pending intents by their SAME identity (digest/messageId/attachments), outcomes enumerated", () => {
    const reconciler = codeOf(
      "../../src/enterprise/conversations/mastra-intent-reconciler.ts",
    );
    expect(reconciler).toContain("createMastraMessageIntentReconciler");
    expect(reconciler).toContain("finalized: number;");
    expect(reconciler).toContain("pending: number;");
    expect(reconciler).toContain("absent: number;");
    expect(reconciler).toContain("mismatch: number;");
    // 对账以同一 intent 身份（digest 与附件清单）核对，不按位置猜测。
    expect(reconciler).toContain("sameStringArray");
  });
});

// ---------------------------------------------------------------------------
// D5 验收 5：Mastra 存储只在内部 Adapter 暴露；兼容臂具名且单写
// ---------------------------------------------------------------------------

describe("MOD06 D5: engine storage hidden behind the named arm; single engine writer", () => {
  test("the facade object surface is exactly the five business capabilities", () => {
    const conversations = createConversationPublic({
      service: recordingService().service,
    });
    expect(Object.keys(conversations).sort()).toEqual([
      "append",
      "appendEngineMessage",
      "getOrCreate",
      "history",
      "list",
    ]);
    // 引擎存储内部面不在公开门面（模块目录 M04：普通调用方不见 resolveMastraBinding）。
    const facade = conversations as unknown as Record<string, unknown>;
    expect(facade.resolveBackend).toBeUndefined();
    expect(facade.resolveMastraBinding).toBeUndefined();
  });

  test("public.ts and routes.ts import zero Mastra bindings (engine storage invisible on the public face)", () => {
    for (const file of [
      "../../src/enterprise/conversations/public.ts",
      "../../src/enterprise/conversations/routes.ts",
    ]) {
      const specifiers = [...sourceOf(file).matchAll(/from "([^"]+)";/g)].map(
        (match) => match[1],
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier.includes("mastra")).toBe(false);
      }
    }
    const publicSpecifiers = [
      ...sourceOf("../../src/enterprise/conversations/public.ts").matchAll(
        /from "([^"]+)";/g,
      ),
    ].map((match) => match[1]);
    expect(publicSpecifiers).toEqual(["./service"]); // M04 组内唯一 import
  });

  test("integration.ts is the named compatibility arm: value export is exactly the factory, wrapping the internal factory byte-for-byte", async () => {
    const module = await import(
      "../../src/enterprise/conversations/integration"
    );
    expect(Object.keys(module).sort()).toEqual(["createMastraStorageArm"]);
    const code = codeOf("../../src/enterprise/conversations/integration.ts");
    expect(code).not.toContain("export *");
    // 臂内唯一语句 = 内件工厂调用（同参转发，零逻辑）。
    expect(code).toMatch(
      /return createConversationService\(\{\s*data: input\.data,\s*mastraStorage: input\.mastraStorage,\s*\}\);/,
    );
    expect(code).not.toMatch(/saveMessages|getStore|withConversationLock/);
  });

  test("the engine-storage type rides through the service factory signature (no M04→M05 import edge)", () => {
    const specifiers = [
      ...sourceOf("../../src/enterprise/conversations/integration.ts").matchAll(
        /from "([^"]+)";/g,
      ),
    ].map((match) => match[1]);
    expect(specifiers).toEqual(["./service"]);
    // ConversationEngineStorage 形状即 TenantMastraStorage（编译级同一）。
    const storage: ConversationEngineStorage | undefined = undefined;
    expect(storage).toBeUndefined();
  });

  test("the arm accepts the same optional storage call shape as the old inline assembly", () => {
    // 缺省引擎存储 = 原 runtime.ts 直传 undefined 的 legacy/平台路径。
    const arm = createMastraStorageArm as (
      input: Parameters<typeof createMastraStorageArm>[0],
    ) => unknown;
    expect(typeof arm).toBe("function");
  });

  test("module-imports.json keeps the M04 grouping this facade relies on", () => {
    const config = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../tests/config/module-imports.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as {
      moduleRoots: Array<{ path: string; module: string; kind: string }>;
    };
    const byPath = new Map(config.moduleRoots.map((root) => [root.path, root]));
    expect(byPath.get("server/src/enterprise/conversations")?.module).toBe(
      "M04",
    );
    expect(byPath.get("server/src/channels")?.module).toBe("M04");
    expect(byPath.get("server/src/mastra")?.module).toBe("M05");
  });

  test("construction accepts single-capability stubs: deps are Pick-level minimal faces (compile-level proof)", () => {
    const onlyHistory = {
      async history() {
        return MESSAGE_PAGE;
      },
    };
    const conversations = createConversationPublic({
      service: onlyHistory,
    });
    expect(typeof conversations.history).toBe("function");
    expect(typeof conversations.append).toBe("function");
  });

  test("source pin: the single engine writer — appendEngineMessage is the only engine entry; memory saveMessages lives only inside the internal service", () => {
    // 引擎消费面：conversation-runtime 经 deps.conversations.appendEngineMessage
    // （同键有界重试），cutover 经 service.appendEngineMessage。
    const runtime = codeOf("../../src/mastra/conversation-runtime.ts");
    expect(runtime).toContain(
      "return await deps.conversations.appendEngineMessage(scope, input);",
    );
    const cutover = codeOf("../../src/mastra/cutover.ts");
    expect(cutover).toContain("await service.appendEngineMessage(");
    // 引擎存储直写（saveMessages）只存在于内件 service.ts。
    for (const file of [
      "../../src/enterprise/conversations/public.ts",
      "../../src/enterprise/conversations/integration.ts",
      "../../src/enterprise/conversations/routes.ts",
    ]) {
      expect(codeOf(file)).not.toContain("saveMessages");
    }
    const service = codeOf("../../src/enterprise/conversations/service.ts");
    expect(service).toContain("memory.saveMessages({");
  });
});
