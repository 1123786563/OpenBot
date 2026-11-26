/**
 * Live WeKnora shared-knowledge work harness for #110: mounts the billing
 * `/work` entry and serves the two platform WeKnora entry points on top of it,
 * so one run records each path's route, usage, cost and refusal evidence.
 *
 *   bun scripts/weknora-work-live.ts <run-dir>
 *
 * Reads the deployed OPENBOT_WEKNORA_* / TEST_CREDIT_* settings from the
 * environment, plus WEKNORA_WORK_ISSUER, WEKNORA_WORK_SUBJECT,
 * WEKNORA_WORK_RESOURCE_ID, WEKNORA_WORK_SESSION_ID, WEKNORA_WORK_QUESTION,
 * WEKNORA_WORK_QUERY, WEKNORA_WORK_CHAT_AUTHORIZATION_ID and
 * WEKNORA_WORK_SEARCH_AUTHORIZATION_ID. DATABASE_URL selects the billing
 * database. Writes <run-dir>/weknora-work-live.json.
 */
import { randomUUID } from "node:crypto";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { loadWeKnoraBilling } from "../src/billing/weknora-config";
import { createWeKnoraRoutes } from "../src/billing/weknora-routes";
import { createDatabase, type Database } from "../src/db/client";

type WorkPath = "chat" | "search";

export type WorkLiveEvidence = {
  startedAt: string;
  issuer: string;
  subject: string;
  resourceId: string;
  paths: Record<
    WorkPath,
    { endpoint: string; status: number; response: unknown }
  >;
  denials: { path: WorkPath; status: number; response: unknown }[];
};

const text = (value: string | undefined, name: string) => {
  if (!value?.trim()) throw new Error(`Missing ${name}`);
  return value.trim();
};

export async function runWeKnoraWorkLive(
  environment: Record<string, string | undefined>,
  databaseUrl: string,
  injectedDatabase?: Database,
): Promise<WorkLiveEvidence> {
  const issuer = text(environment.WEKNORA_WORK_ISSUER, "WEKNORA_WORK_ISSUER");
  const subject = text(
    environment.WEKNORA_WORK_SUBJECT,
    "WEKNORA_WORK_SUBJECT",
  );
  const resourceId = text(
    environment.WEKNORA_WORK_RESOURCE_ID,
    "WEKNORA_WORK_RESOURCE_ID",
  );
  const sessionId = text(
    environment.WEKNORA_WORK_SESSION_ID,
    "WEKNORA_WORK_SESSION_ID",
  );
  const question = text(
    environment.WEKNORA_WORK_QUESTION,
    "WEKNORA_WORK_QUESTION",
  );
  const query = text(environment.WEKNORA_WORK_QUERY, "WEKNORA_WORK_QUERY");
  const grants = {
    chat: text(
      environment.WEKNORA_WORK_CHAT_AUTHORIZATION_ID,
      "WEKNORA_WORK_CHAT_AUTHORIZATION_ID",
    ),
    search: text(
      environment.WEKNORA_WORK_SEARCH_AUTHORIZATION_ID,
      "WEKNORA_WORK_SEARCH_AUTHORIZATION_ID",
    ),
  };
  const runtime = loadWeKnoraBilling(environment);
  if (!runtime?.work?.chat || !runtime.work.rerank)
    throw new Error("WeKnora chat and rerank paths must both be configured.");
  const database = injectedDatabase ?? createDatabase(databaseUrl);
  const ledger = createTestCreditLedger(database);
  const api = createWeKnoraRoutes({ ...runtime, ledger });
  const startedAt = new Date().toISOString();
  // The WeKnora server translates its own endpoints into `/work` calls, so the
  // harness plays that role: each entry call carries the documented
  // `X-OpenBot-*` headers and becomes one billed dispatch.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/work") return api.fetch(request);
      const path: WorkPath | undefined =
        url.pathname === `/api/v1/knowledge-chat/${sessionId}`
          ? "chat"
          : url.pathname === "/api/v1/knowledge-search"
            ? "search"
            : undefined;
      if (!path) return new Response(null, { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const authorizationId = request.headers.get("x-openbot-authorization-id");
      const operationId = request.headers.get("x-openbot-operation-id");
      const body = (await request.json().catch(() => undefined)) as
        | { messages?: unknown; query?: unknown; documents?: unknown }
        | undefined;
      if (!authorizationId || !operationId || !body)
        return Response.json({ code: "invalid_work_entry" }, { status: 400 });
      return fetch(new URL("/work", request.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          subject,
          resourceId,
          operationId,
          authorizationId,
          input:
            path === "chat"
              ? { kind: "chat", messages: body.messages }
              : {
                  kind: "rerank",
                  query: body.query,
                  documents: body.documents,
                },
        }),
      });
    },
  });
  const drive = async (path: WorkPath, authorizationId: string) => {
    const endpoint =
      path === "chat"
        ? `/api/v1/knowledge-chat/${sessionId}`
        : "/api/v1/knowledge-search";
    const response = await fetch(new URL(endpoint, server.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openbot-authorization-id": authorizationId,
        "x-openbot-operation-id": randomUUID(),
      },
      body: JSON.stringify(
        path === "chat"
          ? { messages: [{ role: "user", content: question }] }
          : { query, documents: ["shared knowledge base document"] },
      ),
    });
    return {
      endpoint,
      status: response.status,
      response: (await response.json()) as unknown,
    };
  };
  try {
    const chat = await drive("chat", grants.chat);
    const search = await drive("search", grants.search);
    // Each grant only authorizes its own path, so the crossed calls must be
    // refused before the gateway sees them.
    const crossed = [
      { path: "chat" as const, attempt: await drive("chat", grants.search) },
      {
        path: "search" as const,
        attempt: await drive("search", grants.chat),
      },
    ];
    return {
      startedAt,
      issuer,
      subject,
      resourceId,
      paths: { chat, search },
      denials: crossed.map(({ path, attempt }) => ({
        path,
        status: attempt.status,
        response: attempt.response,
      })),
    };
  } finally {
    await server.stop(true);
    if (!injectedDatabase) await database.$client.close();
  }
}

if (import.meta.main) {
  const runDir = process.argv[2];
  if (!runDir)
    throw new Error("usage: bun scripts/weknora-work-live.ts <run-dir>");
  const evidence = await runWeKnoraWorkLive(
    process.env,
    process.env.DATABASE_URL ?? "",
  );
  await Bun.write(
    `${runDir}/weknora-work-live.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify({ event: "weknora-work-live", evidence }));
}
