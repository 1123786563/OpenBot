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

export function opikFetch(
  config: OpikConfig,
  timeoutMs = OPIK_REQUEST_TIMEOUT_MS,
) {
  const base = new URL(config.apiUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const headers = new Headers({ "content-type": "application/json" });
  if (config.workspace) headers.set("Comet-Workspace", config.workspace);
  if (config.apiKey) headers.set("Authorization", config.apiKey);

  return (path: string, method: "GET" | "POST" | "PUT", body?: unknown) =>
    fetch(new URL(`v1/private/${path}`, base), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
}

export function opikWriter(config: OpikConfig, timeoutMs?: number) {
  const request = opikFetch(config, timeoutMs);
  return async (path: string, method: "POST" | "PUT", body: unknown) => {
    const response = await request(path, method, body);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Opik HTTP ${response.status}`);
  };
}

export function createOpikClient(config: OpikConfig) {
  const send = opikWriter(config);
  return {
    trace: ({ id, startedAt, finishedAt, status, incomplete }: Trace) =>
      send("traces/batch", "POST", {
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
      send("traces/feedback-scores", "PUT", {
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
