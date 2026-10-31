/*
 * #733 外部应用站（第四站）：一个真实的第三方接收/来源应用，不是桩。
 *
 * 它做三件事——
 *  1. POST /api/memory-service/source-check：作为来源应用裁决自己签发的范围
 *     （登记式 scopeRef 注册表 + 本人可撤销状态；站控端点注入故障）。
 *  2. POST /callback：接收 MEMORY 清理通知并回执（模式可编程：正常回执/
 *     回执失败/收下但不回执，覆盖 #725 的重试与未回执不完成语义）。
 *  3. /test/*：站控面——签发范围、设置撤销、设置回调模式、查看状态、复位。
 *     仅本机验收栈使用，不进生产镜像。
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.EXTERNAL_APP_PORT ?? 4242);
const TOKEN = process.env.EXTERNAL_APP_TOKEN ?? "";
const SIGNING_KEY =
  process.env.EXTERNAL_APP_SCOPE_KEY ?? "external-demo-scope-key";
// #733 A16：撤销状态必须跨重启存活（重启/重连不得复活已撤销来源）。
const STATE_FILE =
  process.env.EXTERNAL_APP_STATE_FILE ?? "/tmp/mem733-external-state.json";

if (!TOKEN) {
  console.error("EXTERNAL_APP_TOKEN is required");
  process.exit(1);
}

type IssuedScope = {
  subjectId: string;
  note: string;
  revokedAt: string | null;
};
type CallbackMode = "receipt" | "fail" | "silent";
type Notification = {
  notificationId: string;
  cleanupId: string;
  consumerAppId: string;
  subjectId: string;
  versionIds: string[];
  receivedAt: string;
};

const scopes = new Map<string, IssuedScope>();
const notifications: Notification[] = [];
const state: {
  callbackMode: CallbackMode;
  memory: { baseUrl: string; appId: string; secret: string } | null;
  sourceCheckFails: boolean;
} = { callbackMode: "receipt", memory: null, sourceCheckFails: false };

// 启动即恢复上次状态（scope 注册表与撤销事实）；每次变更落盘。
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
    scopes?: [string, IssuedScope][];
    notifications?: Notification[];
    sourceCheckFails?: boolean;
  };
  for (const [ref, scope] of saved.scopes ?? []) scopes.set(ref, scope);
  notifications.push(...(saved.notifications ?? []));
  state.sourceCheckFails = Boolean(saved.sourceCheckFails);
} catch {
  // 首次启动无状态文件。
}
const persist = () =>
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      scopes: [...scopes.entries()],
      notifications,
      sourceCheckFails: state.sourceCheckFails,
    }),
  );

const sign = (value: string) =>
  `ext1.${createHmac("sha256", SIGNING_KEY).update(value).digest("base64url")}`;

const issue = (subjectId: string, note: string) => {
  const id = randomUUID();
  const ref = sign(id);
  scopes.set(ref, { subjectId, note, revokedAt: null });
  persist();
  return ref;
};

const authorized = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOKEN);
  return token.length === expected.length && timingSafeEqual(token, expected);
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function submitReceipt(notification: Notification) {
  if (!state.memory) return;
  await fetch(
    `${state.memory.baseUrl.replace(/\/$/, "")}/v1/cleanup-receipts`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memory-app": state.memory.appId,
        authorization: `Bearer ${state.memory.secret}`,
      },
      body: JSON.stringify({
        notificationId: notification.notificationId,
        state: "completed",
        items: [
          {
            scope: `app:${state.memory.appId}`,
            state: "completed",
            evidenceRef: `external-demo://${notification.cleanupId}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    },
  ).catch(() => {});
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);

    if (
      url.pathname === "/api/memory-service/source-check" &&
      request.method === "POST"
    ) {
      if (!authorized(request))
        return json({ error: { code: "UNAUTHORIZED" } }, 401);
      if (state.sourceCheckFails) return new Response("down", { status: 503 });
      const body = (await request.json().catch(() => null)) as {
        subjectId?: string;
        source?: { scopeRef?: string };
      } | null;
      const scope = body?.source?.scopeRef
        ? scopes.get(body.source.scopeRef)
        : undefined;
      if (!scope || scope.subjectId !== body?.subjectId) {
        return json({ state: "denied", reason: "forged_scope" });
      }
      if (scope.revokedAt)
        return json({ state: "denied", reason: "source_revoked" });
      return json({
        state: "allowed",
        revision: `ext-${scope.revokedAt ? "r" : "1"}`,
      });
    }

    if (url.pathname === "/callback" && request.method === "POST") {
      const body = (await request
        .json()
        .catch(() => null)) as Partial<Notification> | null;
      if (!body?.notificationId || !body.cleanupId)
        return json({ error: "invalid" }, 400);
      const notification: Notification = {
        notificationId: String(body.notificationId),
        cleanupId: String(body.cleanupId),
        consumerAppId: String(body.consumerAppId ?? ""),
        subjectId: String(body.subjectId ?? ""),
        versionIds: Array.isArray(body.versionIds)
          ? body.versionIds.map(String)
          : [],
        receivedAt: new Date().toISOString(),
      };
      const seen = notifications.some(
        (it) => it.notificationId === notification.notificationId,
      );
      if (!seen) {
        notifications.push(notification);
        persist();
      }
      if (state.callbackMode === "fail")
        return new Response("injected failure", { status: 500 });
      if (state.callbackMode === "silent") return json({ ok: true });
      // 幂等：重复通知不重复回执副作用（回执本身在 MEMORY 侧幂等）。
      await submitReceipt(notification);
      return json({ ok: true });
    }

    if (url.pathname === "/health")
      return json({ ok: true, station: "external-demo" });

    // ---- 站控面（仅本机验收栈） ----
    if (url.pathname === "/test/issue-scope" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        subjectId?: string;
        note?: string;
      };
      return json({
        scopeRef: issue(String(body.subjectId ?? ""), String(body.note ?? "")),
      });
    }
    if (url.pathname === "/test/revoke-scope" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        scopeRef?: string;
      };
      const scope = body.scopeRef ? scopes.get(body.scopeRef) : undefined;
      if (scope) scope.revokedAt = new Date().toISOString();
      persist();
      return json({ revoked: Boolean(scope) });
    }
    if (url.pathname === "/test/callback-mode" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        mode?: CallbackMode;
      };
      if (
        body.mode === "receipt" ||
        body.mode === "fail" ||
        body.mode === "silent"
      ) {
        state.callbackMode = body.mode;
        return json({ ok: true, mode: state.callbackMode });
      }
      return json({ error: "invalid mode" }, 400);
    }
    if (
      url.pathname === "/test/source-check-fails" &&
      request.method === "POST"
    ) {
      const body = (await request.json().catch(() => ({}))) as {
        fails?: boolean;
      };
      state.sourceCheckFails = Boolean(body.fails);
      persist();
      return json({ ok: true, fails: state.sourceCheckFails });
    }
    if (url.pathname === "/test/memory" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        baseUrl?: string;
        appId?: string;
        secret?: string;
      };
      state.memory = {
        baseUrl: String(body.baseUrl ?? ""),
        appId: String(body.appId ?? ""),
        secret: String(body.secret ?? ""),
      };
      persist();
      return json({ ok: true });
    }
    if (url.pathname === "/test/state" && request.method === "GET") {
      return json({
        callbackMode: state.callbackMode,
        sourceCheckFails: state.sourceCheckFails,
        scopes: [...scopes.entries()].map(([scopeRef, scope]) => ({
          scopeRef,
          ...scope,
        })),
        notifications,
      });
    }
    if (url.pathname === "/test/reset" && request.method === "POST") {
      scopes.clear();
      notifications.length = 0;
      state.callbackMode = "receipt";
      state.sourceCheckFails = false;
      persist();
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`external-demo station listening on ${server.url}`);
