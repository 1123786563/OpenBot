// server/tests/multitenancy/tool-access-public.test.ts
// MOD12（Issue #632，根 #620）：M08 连接工具与秘密使用公开门面
// （src/plugins/public.ts）的委托等价、三态/资格合同、秘密绑定合同与负向源级钉。
//
// 事实源（Issue #632 验收 + MOD12 Brief §1.A/§1.C，逐条对应 describe）：
//   D1 委托等价：callTool 恒等转发（输入逐字段、回答同值）；connectionStateOf /
//      prepareAction 是 store 既有判定（listServers / connections 三读 /
//      listForAgent）的原样折叠，与对同一 store 双亲自算的折叠逐键相等；
//      readSecretForUse 与 decryptCredentialForUse 同 (key, reader, id) 同答。
//   D2 验收①三态分别表达：visible / connected / authorizedExecutable 三个键、
//      三份独立判定——grant 而无连接、连接而无 grant 都各自成立、互不推导。
//   D3 验收②秘密读取绑定用途+来源：purpose/origin 非空必填（空则拒且零读取）；
//      撤销/缺失 → CredentialUnusableError 原样透传；明文以裸字符串回到调用者；
//      源级钉：public.ts 零 console/logger/audit 面。
//   D4 验收③资格分开 + 撤销阻断：toolEligibility（grant 面）与
//      environmentConnection（连接面）分开成块、交叉可表达；store 抛出的
//      CredentialUnusableError 经 callTool 原样上抛（撤销阻断唯一门不变）。
//   D5 验收④供应商差异留 Adapter：public.ts 只 import 组内四文件
//      （credentials/store/tools/selection），零 broker/Adapter/transport/vendor 面。
//   D6 验收⑤迁移完整性：直调面冻结普查表——transport/vendor 深引用只剩
//      {assembly/runtime（组合根 seam 安装）}（#732 删除了 memory/ingestion 这一登记例外）；
//      decryptCredentialForUse 在 plugins 外零导入；.callTool( 只剩冻结四点；
//      copilot 经 public 出口；runtime/http 受管执行经 createToolAccess。
//   D7 存量对照：plugin/credentials 套件两树对照与复跑见 reports/mod12-verification/
//      （不在本文件内）。
//
// 运行层（ADR 0008）：import 自 e2e-compat——根 e2e 入口 Node target 原生收集
// （native 桶），不依赖 Bun 运行时、不触真实数据库/供应商：一切 store 判定经注入
// 的记录型双亲证明，秘密路径用真 AES-GCM 信封（encryptSecret/decryptSecret）。

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import {
  CredentialUnusableError,
  decryptCredentialForUse,
  encryptSecret,
} from "../../src/credentials";
import {
  createToolAccess,
  readSecretForUse,
  type ToolAccessStore,
} from "../../src/plugins/public";

/** A deterministic 32-byte AES key, base64 — the envelope format credentials.ts reads. */
const KEY = Buffer.alloc(32, 7).toString("base64");
const ACTOR = "user-1";
const BOT = "bot-1";
const SERVER = "notion";
const OTHER_SERVER = "linear";
const TOOL_REF = `${SERVER}/search`;

type Servers = Awaited<ReturnType<ToolAccessStore["listServers"]>>;
type HeldRow = Awaited<ReturnType<ToolAccessStore["connectionsFor"]>>[number];
type BrokeredRow = Awaited<
  ReturnType<ToolAccessStore["brokeredConnectionsFor"]>
>[number];
type SharedRow = Awaited<
  ReturnType<ToolAccessStore["sharedConnections"]>
>[number];
type Granted = Awaited<ReturnType<ToolAccessStore["listForAgent"]>>;

/**
 * The recording double: every judgment the facade may ask is answered from the
 * fixture and counted, so a test can prove which reads happened (and that a
 * refused secret read happened zero times). Rows are cast at the fixture edge
 * because the shapes carry display fields nothing here reads.
 */
function storeDouble(fixture: {
  servers?: { id: string }[];
  held?: { serverId: string }[];
  brokered?: { serverId: string }[];
  shared?: { serverId: string; connected: boolean }[];
  granted?: { ref: string; toolName: string }[];
  callAnswer?: { text: string; isError: boolean };
  callThrows?: Error;
}) {
  const reads = {
    listServers: 0,
    connectionsFor: 0,
    brokeredConnectionsFor: 0,
    sharedConnections: 0,
    listForAgent: 0,
    callTool: 0,
  };
  const calls: unknown[] = [];
  const store: ToolAccessStore = {
    listServers: async () => {
      reads.listServers += 1;
      return (fixture.servers ?? []) as Servers;
    },
    connectionsFor: async () => {
      reads.connectionsFor += 1;
      return (fixture.held ?? []) as HeldRow[];
    },
    brokeredConnectionsFor: async () => {
      reads.brokeredConnectionsFor += 1;
      return (fixture.brokered ?? []) as BrokeredRow[];
    },
    sharedConnections: async () => {
      reads.sharedConnections += 1;
      return (fixture.shared ?? []) as SharedRow[];
    },
    listForAgent: async () => {
      reads.listForAgent += 1;
      return {
        tools: fixture.granted ?? [],
        skills: [],
      } as Granted;
    },
    callTool: async (input: unknown) => {
      reads.callTool += 1;
      calls.push(input);
      if (fixture.callThrows) throw fixture.callThrows;
      return fixture.callAnswer ?? { text: "vendor answered", isError: false };
    },
    // MOD16（#636）：Pick 扩面后的四个写入/查询成员——本套件不驱动它们，
    // 恒等委托由 package-lifecycle-boundary.test.ts D2 钉住，此处只满足合同。
    installSkill: async () => {},
    uninstallSkill: async () => {},
    skillOwner: async () => null,
    grant: async () => {},
  };
  return { store, reads, calls };
}

/** Resolves to the thrown error, or null when nothing threw. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe("MOD12 D1: 薄委托等价——门面是既有判定的原样转交", () => {
  test("callTool forwards the input verbatim and answers the store's answer", async () => {
    const answer = { text: "rows: 2", isError: false };
    const { store, calls } = storeDouble({ callAnswer: answer });
    const access = createToolAccess({ store });
    const input = {
      ref: TOOL_REF,
      args: { q: "openbot" },
      botId: BOT,
      actorId: ACTOR,
    };
    const got = await access.callTool(input);
    expect(calls.length).toBe(1);
    expect(got).toEqual(answer);
  });

  test("connectionStateOf equals the hand-folded judgment over the same double", async () => {
    const { store } = storeDouble({
      servers: [{ id: SERVER }, { id: OTHER_SERVER }],
      held: [{ serverId: SERVER }],
      granted: [{ ref: TOOL_REF, toolName: "mcp__notion__search" }],
    });
    const access = createToolAccess({ store });
    const got = await access.connectionStateOf({
      actorId: ACTOR,
      botId: BOT,
      serverId: SERVER,
    });
    // The same fold a reader of the store would write: three separate judgments.
    expect(got).toEqual({
      visible: true,
      connected: true,
      authorizedExecutable: true,
    });
    const other = await access.connectionStateOf({
      actorId: ACTOR,
      botId: BOT,
      serverId: OTHER_SERVER,
    });
    expect(other).toEqual({
      visible: true,
      connected: false,
      authorizedExecutable: false,
    });
  });

  test("prepareAction answers grant and connection from their own reads", async () => {
    const { store, reads } = storeDouble({
      granted: [{ ref: TOOL_REF, toolName: "mcp__notion__search" }],
      brokered: [{ serverId: SERVER }],
    });
    const access = createToolAccess({ store });
    const got = await access.prepareAction({
      toolRef: TOOL_REF,
      botId: BOT,
      actorId: ACTOR,
    });
    expect(got.toolEligibility).toEqual({
      granted: true,
      toolName: "mcp__notion__search",
    });
    expect(got.environmentConnection).toEqual({ connected: true });
    // One grant read and the connection trio — the two questions stay two reads.
    expect(reads.listForAgent).toBe(1);
    expect(reads.connectionsFor).toBe(1);
    expect(reads.brokeredConnectionsFor).toBe(1);
    expect(reads.sharedConnections).toBe(1);
  });

  test("readSecretForUse answers what decryptCredentialForUse answers for the same pair", async () => {
    const envelope = await encryptSecret(KEY, "plain-secret");
    const reader = {
      readSecret: async () => ({ encryptedValue: envelope, revokedAt: null }),
    };
    const viaFacade = await readSecretForUse(
      { encryptionKey: KEY, reader },
      {
        credentialId: "cred-1",
        purpose: "tool-call",
        origin: "tool-access-public.test.ts",
      },
    );
    const direct = await decryptCredentialForUse(KEY, reader, "cred-1");
    expect(viaFacade).toBe("plain-secret");
    expect(direct).toBe("plain-secret");
  });
});

describe("MOD12 D2 (验收①): 连接表达三态——三个独立判定分别表达", () => {
  test("the answer has exactly the three keys, no ladder field", async () => {
    const { store } = storeDouble({ servers: [{ id: SERVER }] });
    const access = createToolAccess({ store });
    const got = await access.connectionStateOf({
      actorId: ACTOR,
      botId: BOT,
      serverId: SERVER,
    });
    expect(Object.keys(got).sort()).toEqual([
      "authorizedExecutable",
      "connected",
      "visible",
    ]);
  });

  test("visible alone: listed server, no connection, no grant", async () => {
    const { store } = storeDouble({ servers: [{ id: SERVER }] });
    const access = createToolAccess({ store });
    expect(
      await access.connectionStateOf({
        actorId: ACTOR,
        botId: BOT,
        serverId: SERVER,
      }),
    ).toEqual({ visible: true, connected: false, authorizedExecutable: false });
  });

  test("a grant without a connection is expressible — and stays so", async () => {
    const { store } = storeDouble({
      servers: [{ id: SERVER }],
      granted: [{ ref: TOOL_REF, toolName: "mcp__notion__search" }],
    });
    const access = createToolAccess({ store });
    expect(
      await access.connectionStateOf({
        actorId: ACTOR,
        botId: BOT,
        serverId: SERVER,
      }),
    ).toEqual({ visible: true, connected: false, authorizedExecutable: true });
  });

  test("a connection without a grant is expressible — and stays so", async () => {
    const { store } = storeDouble({
      servers: [{ id: SERVER }],
      held: [{ serverId: SERVER }],
    });
    const access = createToolAccess({ store });
    expect(
      await access.connectionStateOf({
        actorId: ACTOR,
        botId: BOT,
        serverId: SERVER,
      }),
    ).toEqual({ visible: true, connected: true, authorizedExecutable: false });
  });

  test("an unlisted server answers invisible with every judgment still its own", async () => {
    const { store } = storeDouble({
      servers: [{ id: OTHER_SERVER }],
      held: [{ serverId: SERVER }],
    });
    const access = createToolAccess({ store });
    expect(
      await access.connectionStateOf({
        actorId: ACTOR,
        botId: BOT,
        serverId: SERVER,
      }),
    ).toEqual({ visible: false, connected: true, authorizedExecutable: false });
  });

  test("a shared connection counts by the row's own connected flag, not by presence", async () => {
    const { store } = storeDouble({
      servers: [{ id: SERVER }],
      shared: [{ serverId: SERVER, connected: false }],
    });
    const access = createToolAccess({ store });
    expect(
      await access.connectionStateOf({
        actorId: ACTOR,
        botId: BOT,
        serverId: SERVER,
      }),
    ).toEqual({ visible: true, connected: false, authorizedExecutable: false });
  });
});

describe("MOD12 D3 (验收②): 秘密读取绑定用途+来源，明文不出调用者之手", () => {
  const envelopeFor = async (plaintext: string, revokedAt: Date | null) => {
    const value = await encryptSecret(KEY, plaintext);
    let reads = 0;
    const reader = {
      readSecret: async () => {
        reads += 1;
        return { encryptedValue: value, revokedAt };
      },
    };
    return { reader, readCount: () => reads };
  };

  test("an empty purpose refuses before anything is read", async () => {
    const { reader, readCount } = await envelopeFor("plain", null);
    const error = await thrown(
      readSecretForUse(
        { encryptionKey: KEY, reader },
        { credentialId: "c", purpose: "  ", origin: "x" },
      ),
    );
    expect(error instanceof Error).toBe(true);
    expect(readCount()).toBe(0);
  });

  test("an empty origin refuses before anything is read", async () => {
    const { reader, readCount } = await envelopeFor("plain", null);
    const error = await thrown(
      readSecretForUse(
        { encryptionKey: KEY, reader },
        { credentialId: "c", purpose: "tool-call", origin: "" },
      ),
    );
    expect(error instanceof Error).toBe(true);
    expect(readCount()).toBe(0);
  });

  test("a revoked credential raises CredentialUnusableError unchanged", async () => {
    const { reader } = await envelopeFor("plain", new Date());
    const error = await thrown(
      readSecretForUse(
        { encryptionKey: KEY, reader },
        { credentialId: "c", purpose: "tool-call", origin: "x" },
      ),
    );
    expect(error instanceof CredentialUnusableError).toBe(true);
    expect((error as CredentialUnusableError).message).toBe(
      "Credential is revoked",
    );
  });

  test("a missing credential raises CredentialUnusableError unchanged", async () => {
    const reader = {
      readSecret: async () => null,
    };
    const error = await thrown(
      readSecretForUse(
        { encryptionKey: KEY, reader },
        { credentialId: "c", purpose: "tool-call", origin: "x" },
      ),
    );
    expect(error instanceof CredentialUnusableError).toBe(true);
    expect((error as CredentialUnusableError).message).toBe(
      "Credential was not found",
    );
  });

  test("the plaintext comes back as a bare string — no envelope object rides along", async () => {
    const { reader } = await envelopeFor("plain", null);
    const got = await readSecretForUse(
      { encryptionKey: KEY, reader },
      { credentialId: "c", purpose: "tool-call", origin: "x" },
    );
    expect(typeof got).toBe("string");
    expect(got).toBe("plain");
  });
});

describe("MOD12 D4 (验收③): 工具使用资格与环境连接资格分开；撤销阻断在执行门", () => {
  test("grant yes / connection no — both answers present, neither derived from the other", async () => {
    const { store } = storeDouble({
      granted: [{ ref: TOOL_REF, toolName: "mcp__notion__search" }],
    });
    const access = createToolAccess({ store });
    const got = await access.prepareAction({
      toolRef: TOOL_REF,
      botId: BOT,
      actorId: ACTOR,
    });
    expect(got.toolEligibility.granted).toBe(true);
    expect(got.environmentConnection.connected).toBe(false);
  });

  test("grant no / connection yes — the crossed state is equally expressible", async () => {
    const { store } = storeDouble({ held: [{ serverId: SERVER }] });
    const access = createToolAccess({ store });
    const got = await access.prepareAction({
      toolRef: TOOL_REF,
      botId: BOT,
      actorId: ACTOR,
    });
    expect(got.toolEligibility.granted).toBe(false);
    expect(got.toolEligibility.toolName).toBe(null);
    expect(got.environmentConnection.connected).toBe(true);
  });

  test("a ref with no server side answers neither, without inventing an error", async () => {
    const { store } = storeDouble({ servers: [{ id: SERVER }] });
    const access = createToolAccess({ store });
    const got = await access.prepareAction({
      toolRef: "serverless-tool",
      botId: BOT,
      actorId: ACTOR,
    });
    expect(got.toolEligibility.granted).toBe(false);
    expect(got.environmentConnection.connected).toBe(false);
  });

  test("revocation blocks at the execution gate: the store's CredentialUnusableError propagates verbatim", async () => {
    const refusal = new CredentialUnusableError("Credential is revoked");
    const { store } = storeDouble({ callThrows: refusal });
    const access = createToolAccess({ store });
    const error = await thrown(
      access.callTool({
        ref: TOOL_REF,
        args: {},
        botId: BOT,
        actorId: ACTOR,
      }),
    );
    expect(error instanceof CredentialUnusableError).toBe(true);
    expect((error as CredentialUnusableError).message).toBe(
      "Credential is revoked",
    );
  });
});

/** Strips comments so pins read code, not prose. */
function codeOf(relative: string): string {
  const raw = readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8",
  );
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("MOD12 D5 (验收④): 供应商差异留在 Adapter——门面零 broker/vendor 面", () => {
  test("public.ts imports only the four in-group files", () => {
    const source = codeOf("../../src/plugins/public.ts");
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(specifiers.length > 0).toBe(true);
    for (const specifier of specifiers) {
      expect(
        ["../credentials", "./selection", "./store", "./tools"].includes(
          specifier,
        ),
        `unexpected import ${specifier}`,
      ).toBe(true);
    }
  });

  test("public.ts names no broker, adapter, transport or vendor face", () => {
    const source = codeOf("../../src/plugins/public.ts");
    for (const banned of [
      "ConnectedAppBroker",
      "ComposioBroker",
      "BrokerRefusalError",
      "transportFor",
      "createComposioClient",
      "createOpenConnectorClient",
      "askVendor",
      "BrokerApp",
      "BrokerField",
    ]) {
      expect(
        source.includes(banned),
        `public.ts must not contain ${banned}`,
      ).toBe(false);
    }
  });

  test("public.ts adds no provider or action literal — the catalogue decides what exists", () => {
    const source = codeOf("../../src/plugins/public.ts").toLowerCase();
    for (const banned of [
      "composio",
      "open-connector",
      "openconnector",
      "google-drive",
    ]) {
      expect(source.includes(banned), `public.ts must not name ${banned}`).toBe(
        false,
      );
    }
  });
});

describe("MOD12 D3/D6 源级钉: 秘密零泄漏面 + 迁移完整性冻结普查表", () => {
  test("public.ts has no log, audit or DTO face on any path", () => {
    const source = codeOf("../../src/plugins/public.ts");
    for (const banned of [
      "console.",
      "getLogger",
      "recordAuditEvent",
      "auditStore",
      "logger",
    ]) {
      expect(
        source.includes(banned),
        `public.ts must not contain ${banned}`,
      ).toBe(false);
    }
  });

  /**
   * server/src 的组外源码（去注释），相对 server/src 的路径为键。M08 组 =
   * plugins/ + credentials.ts + passwords/，全部排除——普查的对象是组外面。
   */
  function serverSources(): { path: string; code: string }[] {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    return readdirSync(root, { recursive: true })
      .map((entry) => String(entry))
      .filter(
        (rel) =>
          rel.endsWith(".ts") &&
          !rel.startsWith("plugins/") &&
          !rel.startsWith("passwords/") &&
          rel !== "credentials.ts",
      )
      .map((rel) => ({
        path: `server/src/${rel}`,
        code: codeOf(`../../src/${rel}`),
      }));
  }

  test("transport/vendor deep imports outside the group are exactly the frozen census", () => {
    const expected: Record<string, string[]> = {
      "server/src/assembly/runtime.ts": [
        "builtin-routines",
        "composio",
        "composio-adapter",
        "openconnector",
        "openconnector-adapter",
      ],
      // PKG10/T13 包派发：DEFAULT_VENDOR 经 transportFor("mcp") 拨号，授权门
      // (toolInvocation/catalogDecisions/vault) 在构造参数上。
      "server/src/enterprise/plugin-packages/dispatch.ts": ["transport"],
    };
    const pattern =
      /from "[^"]*plugins\/(composio-adapter|composio-vendor|composio-client|composio|openconnector-adapter|openconnector|mcp|builtin-routines|google-drive-rest|transport)(\/[^"]*)?"/g;
    const found: Record<string, string[]> = {};
    for (const file of serverSources()) {
      const modules = [...file.code.matchAll(pattern)].map((match) => match[1]);
      if (modules.length > 0) found[file.path] = [...new Set(modules)].sort();
    }
    expect(found).toEqual(expected);
  });

  test("decryptCredentialForUse is imported nowhere outside the group", () => {
    const found = serverSources().filter((file) =>
      file.code.includes("decryptCredentialForUse"),
    );
    expect(found.map((file) => file.path)).toEqual([]);
  });

  test(".callTool( outside the group is exactly the frozen door census", () => {
    const expected: Record<string, number> = {
      // 受管门经门面（本票迁移）。
      "server/src/assembly/http.ts": 1,
      "server/src/assembly/runtime.ts": 1,
      // 依赖注入：provider（runtime.ts）已改经门面；第二处是 PKG09 `pkg:` 包工具分支的
      // 注入式 deps.callTool。
      "server/src/approvals/execute.ts": 2,
      // PKG10 包派发：DEFAULT_VENDOR 的 mcp 拨号（受 toolInvocation/vault 门）。
      "server/src/enterprise/plugin-packages/dispatch.ts": 1,
      // 评测夹具上下文（注入的 context.callTool，非 vendor 客户端）：
      "server/src/ai-observability/execution-runner.ts": 2,
    };
    const found: Record<string, number> = {};
    for (const file of serverSources()) {
      const count = [...file.code.matchAll(/\.\s*callTool\s*\(/g)].length;
      if (count > 0) found[file.path] = count;
    }
    expect(found).toEqual(expected);
  });

  test("the store faces outside the group carry no broker-style execution bypass", () => {
    // 没有任何 plugins 外文件以 broker/transport 客户端执行动作：
    // 直调唯一可形态（transport 族的 callTool/listTools 导入）已在上面钉死；
    // 这里再钉组合根只构造、立即交给 store/routes，不自己发起 vendor 调用。
    const runtime = codeOf("../../src/assembly/runtime.ts");
    expect(runtime.includes("useComposioClient(composio.actions)")).toBe(true);
    expect(runtime.includes("createToolAccess")).toBe(true);
    expect(runtime.includes("pluginStore.callTool")).toBe(false);
    const http = codeOf("../../src/assembly/http.ts");
    expect(http.includes("createToolAccess")).toBe(true);
    expect(http.includes("pluginStore.callTool")).toBe(false);
  });

  test("copilot reaches the offer faces through the public exit", () => {
    const copilot = codeOf("../../src/copilot.ts");
    expect(copilot.includes('from "./plugins/public"')).toBe(true);
    expect(copilot.includes('from "./plugins/tools"')).toBe(false);
    expect(copilot.includes('from "./plugins/selection"')).toBe(false);
  });
});
