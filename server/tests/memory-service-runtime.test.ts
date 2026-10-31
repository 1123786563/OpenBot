import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "../../tests/support/e2e-compat";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createMemoryClient,
  type RecallResult,
  type ServerCredentialProvider,
} from "../src/memory-service/client";
import { createMemoryContextLoader } from "../src/memory-service/context";
import { issueSourceScope } from "../src/memory-service/source-check";
import type { PlatformScope } from "../src/enterprise/contracts";

/*
 * #730 运行客户端与上下文装载：真实 HTTP 往返、逐请求的服务凭据与本人委托、
 * 来源引用由 OpenBot 签发，服务不可用/来源不可用时不注入内容。
 */

const KEY = "A".repeat(44);
const APP_ID = "openbot-memory";
const SUBJECT = "5f1b1f9a-2d63-4b1e-9c47-9a1a2f3de001";

let server: Server;
let baseUrl: string;
let seen: { headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];
let behavior: "available" | "partial" | "unavailable" | "error" = "available";

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

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      seen.push({ headers: request.headers, body: raw ? JSON.parse(raw) : null });
      if (behavior === "error") {
        response.writeHead(403, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "DELEGATION_REQUIRED" } }));
        return;
      }
      const body: RecallResult =
        behavior === "unavailable"
          ? { state: "unavailable", memories: [], unavailableReasons: ["recovery_replaying"] }
          : behavior === "partial"
            ? { ...MEMORY, state: "partial", unavailableReasons: ["source_revoked"] }
            : MEMORY;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

function countingProvider(): ServerCredentialProvider & { calls: { subjectId: string; appId: string }[] } {
  const calls: { subjectId: string; appId: string }[] = [];
  return {
    calls,
    async forRequest(input) {
      calls.push({ subjectId: input.subjectId, appId: input.appId });
      return {
        serviceCredential: `svc-${calls.length}`,
        userDelegation: `deleg-${input.subjectId}`,
      };
    },
  };
}

describe("memory_client", () => {
  test("逐请求签发服务凭据与本人委托；本人身份来自调用方上下文，不来自响应体自报", async () => {
    seen = [];
    const credentials = countingProvider();
    const client = createMemoryClient({ baseUrl, appId: APP_ID, credentials });
    const result = await client.recall({ subjectId: SUBJECT, requestId: "req-1", query: "偏好" });
    expect(result.state).toBe("available");
    expect(credentials.calls).toEqual([{ subjectId: SUBJECT, appId: APP_ID }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["x-memory-app"]).toBe(APP_ID);
    expect(seen[0].headers["x-memory-subject"]).toBe(SUBJECT);
    expect(seen[0].headers.authorization).toBe("Bearer svc-1");
    expect(seen[0].headers["x-request-id"]).toBe("req-1");

    seen = [];
    await client.recall({ subjectId: SUBJECT, requestId: "req-2", query: "偏好" });
    expect(seen[0].headers.authorization).toBe("Bearer svc-2");
  });

  test("服务拒绝映射为带状态码的错误，不当作空结果", async () => {
    behavior = "error";
    try {
      const client = createMemoryClient({ baseUrl, appId: APP_ID, credentials: countingProvider() });
      let thrown: unknown = null;
      try {
        await client.recall({ subjectId: SUBJECT, requestId: "req-3" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeTruthy();
      expect((thrown as { status: number }).status).toBe(403);
      expect((thrown as { code: string }).code).toBe("DELEGATION_REQUIRED");
    } finally {
      behavior = "available";
    }
  });
});

describe("memory_context_loader", () => {
  const issueScope = (input: { subjectId: string; botId: string; tenantId: string | null }) =>
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

  test("三个入口都装载已授权内容，来源范围由服务器签发", async () => {
    behavior = "available";
    seen = [];
    const client = createMemoryClient({ baseUrl, appId: APP_ID, credentials: countingProvider() });
    const load = createMemoryContextLoader({ client, issueScope });
    for (const entrypoint of ["web", "schedule", "mobile"] as const) {
      const { content, result } = await load(platformScope({ entrypoint }), "bot-1");
      expect(result.state).toBe("available");
      expect(content).toBe("- 用户偏好简洁回复");
    }
    // 每次装载的来源引用都来自当前本人 + Bot + 公司。
    expect(seen).toHaveLength(3);
    for (const request of seen) {
      const body = request.body as { sourceRefs: { scopeRef: string }[] };
      expect(body.sourceRefs).toHaveLength(1);
      const parts: unknown = body.sourceRefs[0];
      expect(parts).toBeTruthy();
    }
  });

  test("来源失效的部分结果保留其他授权内容；恢复闸门/服务不可用不注入内容", async () => {
    const client = createMemoryClient({ baseUrl, appId: APP_ID, credentials: countingProvider() });
    const load = createMemoryContextLoader({ client, issueScope });

    behavior = "partial";
    const partial = await load(platformScope(), "bot-1");
    expect(partial.result.state).toBe("partial");
    expect(partial.content).toBe("- 用户偏好简洁回复");
    expect(partial.result.unavailableReasons).toEqual(["source_revoked"]);

    behavior = "unavailable";
    const gated = await load(platformScope(), "bot-1");
    expect(gated.content).toBe("");
    expect(gated.result.unavailableReasons).toEqual(["recovery_replaying"]);

    behavior = "error";
    try {
      const failed = await load(platformScope(), "bot-1");
      expect(failed.content).toBe("");
      expect(failed.result.state).toBe("unavailable");
      expect(failed.result.unavailableReasons).toEqual(["memory_service_unavailable"]);
    } finally {
      behavior = "available";
    }
  });
});