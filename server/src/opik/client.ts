export const OPIK_REQUEST_TIMEOUT_MS = 30_000;

export type OpikConfig = {
  apiUrl: URL;
  project: string;
  workspace?: string;
  apiKey?: string;
};

type Trace = {
  id: string;
  startedAt: Date;
  finishedAt: Date;
  status: "completed" | "failed";
  incomplete: boolean;
};

export function createOpikClient(config: OpikConfig) {
  const base = new URL(config.apiUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const headers = new Headers({ "content-type": "application/json" });
  if (config.workspace) headers.set("Comet-Workspace", config.workspace);
  if (config.apiKey) headers.set("Authorization", config.apiKey);

  async function send(path: string, method: "POST" | "PUT", body: unknown) {
    const response = await fetch(new URL(`v1/private/traces/${path}`, base), {
      method,
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(OPIK_REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Opik HTTP ${response.status}`);
  }

  return {
    trace: ({ id, startedAt, finishedAt, status, incomplete }: Trace) =>
      send("batch", "POST", {
        traces: [
          {
            id,
            name: incomplete ? "OpenBot Run (incomplete)" : "OpenBot Run",
            project_name: config.project,
            start_time: startedAt.toISOString(),
            end_time: finishedAt.toISOString(),
            metadata: {
              status,
              duration_ms: Math.max(
                0,
                finishedAt.getTime() - startedAt.getTime(),
              ),
              incomplete,
            },
          },
        ],
      }),
    score: ({ traceId, score }: { traceId: string; score: number }) =>
      send("feedback-scores", "PUT", {
        scores: [
          {
            id: traceId,
            project_name: config.project,
            name: "user_feedback",
            source: "sdk",
            value: score,
          },
        ],
      }),
  };
}
