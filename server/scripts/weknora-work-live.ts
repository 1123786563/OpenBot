/**
 * Live WeKnora shared-knowledge work harness for #110: mounts the billing
 * `/work` entry and drives the real shared-KB chat and knowledge-search paths,
 * recording receipts and denial codes as evidence.
 *
 *   bun scripts/weknora-work-live.ts <run-dir>
 *
 * Reads the same OPENBOT_WEKNORA_* / TEST_CREDIT_* settings as the deployed
 * app, plus WEKNORA_WORK_ISSUER, WEKNORA_WORK_SUBJECT,
 * WEKNORA_WORK_AUTHORIZATION_ID (per path), WEKNORA_WORK_RESOURCE_ID and
 * WEKNORA_WORK_SESSION_ID. DATABASE_URL selects the billing database.
 */
import { randomUUID } from "node:crypto";
import { createTestCreditLedger } from "../src/billing/test-credit";
import { loadWeKnoraBilling } from "../src/billing/weknora-config";
import { createWeKnoraRoutes } from "../src/billing/weknora-routes";
import { createDatabase, type Database } from "../src/db/client";

export type WorkLiveEvidence = {
  startedAt: string;
  resourceId: string;
  issuer: string;
  subject: string;
  paths: Record<
    string,
    {
      route: string;
      status: number;
      response: unknown;
      receipt?: Record<string, unknown>;
    }
  >;
  denials: { path: string; status: number; response: unknown }[];
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
  const runtime = loadWeKnoraBilling(environment);
  if (!runtime || !runtime.work?.chat || !runtime.work?.rerank)
    throw new Error("WeKnora chat and rerank paths must both be configured.");
  const database = injectedDatabase ?? createDatabase(databaseUrl);
  const ledger = createTestCreditLedger(database);
  const api = createWeKnoraRoutes({ ...runtime, ledger });
  const evidence: WorkLiveEvidence = {
    startedAt: new Date().toISOString(),
    resourceId,
    issuer,
    subject,
    paths: {},
    denials: [],
  };
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await api.request("/work", {
      method: "POST",
      headers: {
        authorization: `Bearer ${runtime.serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject,
        resourceId,
        operationId: randomUUID(),
        ...body,
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  try {
    for (const [path, endpoint, kind, authorizationId] of [
      [
        "chat",
        `/api/v1/knowledge-chat/${sessionId}`,
        "chat",
        text(
          environment.WEKNORA_WORK_CHAT_AUTHORIZATION_ID,
          "chat authorization",
        ),
      ],
      [
        "search",
        `/api/v1/knowledge-search`,
        "rerank",
        text(
          environment.WEKNORA_WORK_SEARCH_AUTHORIZATION_ID,
          "search authorization",
        ),
      ],
    ]) {
      const input =
        kind === "chat"
          ? {
              kind,
              messages: [
                {
                  role: "user",
                  content: text(
                    environment.WEKNORA_WORK_QUESTION,
                    "WEKNORA_WORK_QUESTION",
                  ),
                },
              ],
            }
          : {
              kind,
              query: text(environment.WEKNORA_WORK_QUERY, "WEKNORA_WORK_QUERY"),
              documents: ["shared knowledge base document"],
            };
      const { status, body } = await post(endpoint, { input, authorizationId });
      const receipt = body.receipt as Record<string, unknown> | undefined;
      evidence.paths[path] = {
        route: runtime.work[kind]?.routeId ?? "",
        status,
        response: body,
        ...(receipt ? { receipt } : {}),
      };
      const denied = await post(endpoint, {
        input,
        authorizationId: randomUUID(),
      });
      evidence.denials.push({
        path,
        status: denied.status,
        response: denied.body,
      });
    }
    return evidence;
  } finally {
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
