import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createMemoryClient,
  type JobView,
  type RecallResult,
  type ServerCredentialProvider,
  submitWithIdempotentRetry,
} from "../src/memory-service/client";
import {
  createMemoryContextLoader,
  memoryContextBlock,
  MEMORY_UNAVAILABLE_NOTICE,
} from "../src/memory-service/context";
import { issueSourceScope } from "../src/memory-service/source-check";
import type { PlatformScope } from "../src/enterprise/contracts";

/*
 * #729 Task 2 调用方故障语义。具名 fixture memory-http-fault-fixture 返回
 * 超时/503/partial，客户端与装载器都是 #730 的真实实现（无 mock），只有
 * 旧记忆存储是计数桩——用来证明降级路径绝不读它。
 */

const KEY = "A".repeat(44);
const APP_ID = "openbot-memory";
const SUBJECT = "5f1b1f9a-2d63-4b1e-9c47-9a1a2f3de002";

type Mode =
  | "available"
  | "partial"
  | "unavailable"
  | "fault_503"
  | "fault_403"
  | "ingestion_flaky_503"
  | "socket_drop"
  | "slow";

let server: Server;
let baseUrl: string;
let mode: Mode = "available";
let ingestCalls = 0;
const seen: { path: string; body: unknown }[] = [];

const MEMORY: RecallResult = {
  state: "available",
  memories: [
    {
      id: "mem-1",
      versionId: "version-1",
      content: "用户偏好简洁回复",
      originAppId: "app-a",
      sources: [{ originAppId: "app-a", scopeRef: "s1" }],
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
    },
  ],
  unavailableReasons: [],
};

const JOB: JobView = {
  id: "job-1",
  state: "accepted",
  reason: null,
  expiresAt: "2026-11-02T00:00:00.000Z",
};

function reply(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://local").pathname;
      seen.push({ path, body: raw ? JSON.parse(raw) : null });
      if (mode === "socket_drop") {
        request.socket.destroy();
        return;
      }
      const finish = () => {
        if (mode === "fault_503") {
          reply(response, 503, { error: { code: "DEPENDENCY_UNAVAILABLE" } });
          return;
        }
        if (mode === "fault_403") {
          reply(response, 403, { error: { code: "DELEGATION_REQUIRED" } });
          return;
        }
        if (path === "/v1/ingestions") {
          ingestCalls += 1;
          if (mode === "ingestion_flaky_503" && ingestCalls <= 2) {
            reply(response, 503, { error: { code: "DEPENDENCY_UNAVAILABLE" } });
            return;
          }
          reply(response, 202, JOB);
          return;
        }
        const body: RecallResult =
          mode === "unavailable"
            ? {
                state: "unavailable",
                memories: [],
                unavailableReasons: ["recovery_replaying"],
              }
            : mode === "partial"
              ? {
                  ...MEMORY,
                  state: "partial",
                  unavailableReasons: ["source:app-a:unavailable"],
                }
              : MEMORY;
        reply(response, 200, body);
      };
      if (mode === "slow") setTimeout(finish, 300);
      else finish();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  mode = "available";
  ingestCalls = 0;
  seen.length = 0;
});

function platformScope(overrides: Partial<PlatformScope> = {}): PlatformScope {
  return {
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    principalId: "principal-1",
    actorId: SUBJECT,
    memberEpoch: 1,
    aclEpoch: 1,
    entrypoint: "web",
    ...overrides,
  };
}

const credentials: ServerCredentialProvider = {
  async forRequest(input) {
    return {
      serviceCredential: "svc-fixed",
      userDelegation: `deleg-${input.subjectId}`,
    };
  },
};

const issueScope = (input: {
  subjectId: string;
  botId: string;
  tenantId: string | null;
}) =>
  issueSourceScope(
    {
      originAppId: "app-a",
      subjectId: input.subjectId,
      botId: input.botId,
      tenantId: input.tenantId,
      sourceId: "source-1",
    },
    KEY,
  );

function loader(options: { timeoutMs?: number } = {}) {
  const client = createMemoryClient({
    baseUrl,
    appId: APP_ID,
    credentials,
    ...options,
  });
  return createMemoryContextLoader({ client, issueScope });
}

describe("plain_chat_and_required_task", () => {
  test("服务 503 时普通对话继续并明确提示未使用记忆；依赖记忆的任务暂停", async () => {
    mode = "fault_503";
    const loaded = await loader()(platformScope(), "bot-1");
    expect(loaded.content).toBe("");
    expect(loaded.result.state).toBe("unavailable");
    expect(loaded.result.unavailableReasons).toEqual([
      "memory_service_unavailable",
    ]);

    // 普通对话：不失败，注入诚实提示，模型不得冒充记得本人。
    const plain = memoryContextBlock(loaded, { required: false });
    expect(plain.blocked).toBe(false);
    if (!plain.blocked) expect(plain.block).toBe(MEMORY_UNAVAILABLE_NOTICE);

    // 依赖记忆的任务（持有记忆工具）：暂停而不是在没有记忆时继续。
    const required = memoryContextBlock(loaded, { required: true });
    expect(required.blocked).toBe(true);
    if (required.blocked) expect(required.reason).toBe("memory_unavailable");

    // 超时同样视为没有可靠答复：普通对话继续，任务暂停。
    mode = "slow";
    const timedOut = await loader({ timeoutMs: 50 })(platformScope(), "bot-1");
    expect(timedOut.result.state).toBe("unavailable");
    expect(timedOut.result.unavailableReasons).toEqual([
      "memory_service_unavailable",
    ]);
    expect(memoryContextBlock(timedOut, { required: true }).blocked).toBe(true);
    expect(memoryContextBlock(timedOut, { required: false }).blocked).toBe(
      false,
    );

    // 连接被丢弃（无答复）与超时同一结论。
    mode = "socket_drop";
    const dropped = await loader()(platformScope(), "bot-1");
    expect(dropped.result.state).toBe("unavailable");
    expect(memoryContextBlock(dropped, { required: true }).blocked).toBe(true);
  });

  test("服务正常或部分可用时不暂停：已授权内容照常注入，部分不可用如实随附", async () => {
    const available = await loader()(platformScope(), "bot-1");
    const ok = memoryContextBlock(available, { required: true });
    expect(ok.blocked).toBe(false);
    if (!ok.blocked) expect(ok.block).toBe("- 用户偏好简洁回复");

    mode = "partial";
    const partial = await loader()(platformScope(), "bot-1");
    const partialBlock = memoryContextBlock(partial, { required: true });
    expect(partialBlock.blocked).toBe(false);
    if (!partialBlock.blocked)
      expect(partialBlock.block).toBe("- 用户偏好简洁回复");
    expect(partial.result.unavailableReasons).toEqual([
      "source:app-a:unavailable",
    ]);

    // 未装配记忆服务（#730 seam 未接）：与旧行为一致，不注入也不暂停。
    const unwired = memoryContextBlock(undefined, { required: true });
    expect(unwired.blocked).toBe(false);
    if (!unwired.blocked) expect(unwired.block).toBeUndefined();

    // 服务明确不可用（恢复重放闸门）：同样降级。
    mode = "unavailable";
    const gated = await loader()(platformScope(), "bot-1");
    expect(memoryContextBlock(gated, { required: false }).blocked).toBe(false);
    expect(memoryContextBlock(gated, { required: true }).blocked).toBe(true);
  });
});

describe("submit_retry", () => {
  const input = () => ({
    subjectId: SUBJECT,
    requestId: "req-1",
    idempotencyKey: "idem-729",
    fragment: "要记住的片段",
    sources: [{ originAppId: "app-a", scopeRef: "s1" }],
  });

  test("无可靠 202 回执不宣称已接收；重试沿用同一个幂等 key", async () => {
    mode = "ingestion_flaky_503";
    const client = createMemoryClient({ baseUrl, appId: APP_ID, credentials });
    const accepted: JobView[] = [];
    const job = await submitWithIdempotentRetry(client, input(), {
      sleep: async () => {},
    });
    accepted.push(job);
    expect(accepted).toHaveLength(1);
    expect(job.state).toBe("accepted");
    // 三次请求都用同一个幂等 key：重试不得换 key。
    const ingestions = seen.filter(
      (request) => request.path === "/v1/ingestions",
    );
    expect(ingestions).toHaveLength(3);
    expect(
      ingestions.map(
        (request) =>
          (request.body as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual(["idem-729", "idem-729", "idem-729"]);

    // 明确答复（4xx）不重试：不是"无回执"，重试只会重复拒绝。
    seen.length = 0;
    mode = "fault_403";
    let refusal: unknown = null;
    try {
      await submitWithIdempotentRetry(
        createMemoryClient({ baseUrl, appId: APP_ID, credentials }),
        {
          ...input(),
          idempotencyKey: "idem-729-c",
        },
        { sleep: async () => {} },
      );
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { status: number }).status).toBe(403);
    expect(
      seen.filter((request) => request.path === "/v1/ingestions"),
    ).toHaveLength(1);

    // 持续无回执：抛错，调用方拿不到"已接收"。
    seen.length = 0;
    ingestCalls = 0;
    mode = "fault_503";
    let thrown: unknown = null;
    const outcomes: JobView[] = [];
    try {
      const failed = await submitWithIdempotentRetry(
        createMemoryClient({ baseUrl, appId: APP_ID, credentials }),
        {
          ...input(),
          idempotencyKey: "idem-729-b",
        },
        { sleep: async () => {} },
      );
      outcomes.push(failed);
    } catch (error) {
      thrown = error;
    }
    expect(outcomes).toEqual([]);
    expect(thrown).toBeTruthy();
    expect((thrown as { status: number }).status).toBe(503);
    const retried = seen.filter((request) => request.path === "/v1/ingestions");
    expect(retried).toHaveLength(3);
    expect(
      retried.map(
        (request) =>
          (request.body as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual(["idem-729-b", "idem-729-b", "idem-729-b"]);
  });
});

describe("no_legacy", () => {
  test("故障与正常路径都只经记忆服务：装载器没有第二条本地读取", async () => {
    // 旧实现仍在盘上、旧装载器可能已被装配。本票的"零读取"证据在真实装配层：
    // server/tests/mastra-memory-service-degradation.test.ts 同时装上旧装载器与
    // 新装载器，断言旧装载器调用计数为 0。这里只证明装载器自身没有本地来源。
    mode = "fault_503";
    const failed = await loader()(platformScope(), "bot-1");
    expect(failed.content).toBe("");
    expect(failed.result.unavailableReasons).toEqual([
      "memory_service_unavailable",
    ]);
    // 故障时只问一次服务，没有任何回填。
    expect(
      seen.filter((request) => request.path === "/v1/recall"),
    ).toHaveLength(1);

    mode = "available";
    const available = await loader()(platformScope(), "bot-1");
    expect(available.content).toBe("- 用户偏好简洁回复");
    // 内容逐字来自服务响应：装载器没有第二条读取路径可回填。
    expect(available.result.memories.map((memory) => memory.versionId)).toEqual(
      ["version-1"],
    );
    expect(
      seen.filter((request) => request.path === "/v1/recall"),
    ).toHaveLength(2);
  });
});
