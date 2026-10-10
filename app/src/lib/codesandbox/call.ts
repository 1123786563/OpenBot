import { tryClient } from "@/lib/client";

/** What the server's POST /api/codesandbox/runs answers with. */
export type CodeRunResponse =
  | {
      kind: "completed";
      runId: string;
      text: string;
      artifacts: Array<{
        path: string;
        size: number;
        content: string;
        truncated: boolean;
      }>;
    }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; runId: string; reason: string };

/** What the model is told: the result, or a sentence about why nothing ran. */
export async function callCodeSandbox(
  input: { botId: string; task: string; timeoutSeconds?: number },
  signal?: AbortSignal,
): Promise<string> {
  const response = await tryClient("/api/codesandbox/runs", {
    method: "POST",
    // `send` serialises the body and sets the content type; a pre-stringified
    // body here would be JSON-encoded twice and the server would read a string.
    body: input,
    signal,
  });
  const body = (await response.json()) as CodeRunResponse;
  if (body.kind === "completed") {
    const files = body.artifacts
      .map(
        (artifact) =>
          `- ${artifact.path}（${artifact.size} 字节${artifact.truncated ? "，已截断" : ""}）`,
      )
      .join("\n");
    return [
      body.text,
      files
        ? `\n工作区新增文件：\n${files}`
        : "\n（本次运行没有新增工作区文件。）",
    ].join("\n");
  }
  if (body.kind === "refused") return `代码执行未运行：${body.reason}`;
  return `代码执行失败：${body.reason}`;
}
