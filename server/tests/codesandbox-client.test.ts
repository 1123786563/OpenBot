import { describe, expect, test } from "bun:test";
import {
  CodeSandboxTimeoutError,
  createSandboxClient,
  parseUsage,
} from "../src/codesandbox/client";

/** Records the requests and replays scripted responses, so tests never touch a real sandbox. */
function fakeFetch(scripted: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: () => Response }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url);
    calls.push({ url: urlText, init });
    const entry = scripted.find((s) => s.match(urlText, init));
    if (!entry) throw new Error(`unexpected fetch ${urlText}`);
    return entry.respond();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const base = { baseUrl: "http://127.0.0.1:4300", token: "sandbox-secret" };

describe("createSandboxClient", () => {
  test("createSession sends the token header and returns the id", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        match: (url) => url.endsWith("/session"),
        respond: () => Response.json({ id: "ses_1" }),
      },
    ]);
    const client = createSandboxClient({ ...base, fetchImpl });
    const id = await client.createSession("smoke");
    expect(id).toBe("ses_1");
    const init = calls[0]?.init as RequestInit;
    expect((init.headers as Record<string, string>)["x-sandbox-token"]).toBe("sandbox-secret");
  });

  test("sendMessage joins text parts and parses usage", async () => {
    const { fetchImpl } = fakeFetch([
      {
        match: (url) => url.endsWith("/message"),
        respond: () =>
          Response.json({
            parts: [
              { type: "text", text: "第一段。" },
              { type: "step-start" },
              { type: "text", text: "第二段。" },
            ],
            info: { tokens: { input: 120, output: 45 } },
          }),
      },
    ]);
    const client = createSandboxClient({ ...base, fetchImpl });
    const result = await client.sendMessage("ses_1", "你好", {
      modelId: "GLM-5.3",
    });
    expect(result.text).toBe("第一段。\n第二段。");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  test("parseUsage is tolerant about where the token counts live", () => {
    expect(parseUsage({ info: { tokens: { input: 1, output: 2 } } })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(parseUsage({ tokens: { input: 3, output: 4 } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    expect(parseUsage({ parts: [] })).toBeUndefined();
    expect(parseUsage({ info: { tokens: { input: "x" } } })).toBeUndefined();
  });

  test("a message past its deadline raises CodeSandboxTimeoutError", async () => {
    const { fetchImpl } = fakeFetch([
      {
        match: () => true,
        respond: () => new Promise(() => undefined), // never resolves
      },
    ]);
    const client = createSandboxClient({ ...base, fetchImpl });
    const run = client.sendMessage("ses_1", "慢任务", {
      modelId: "GLM-5.3",
      timeoutMs: 20,
    });
    expect(run).rejects.toBeInstanceOf(CodeSandboxTimeoutError);
  });

  test("listFiles and readFile pass the path through and cap the read", async () => {
    const { calls, fetchImpl } = fakeFetch([
      {
        match: (url) => url.includes("/file?"),
        respond: () => Response.json(["hello.py", "out.csv"]),
      },
      {
        match: (url) => url.includes("/file/content"),
        respond: () => new Response("print('hi')\n"),
      },
    ]);
    const client = createSandboxClient({ ...base, fetchImpl });
    const files = await client.listFiles();
    expect(files).toEqual(["hello.py", "out.csv"]);
    const file = await client.readFile("hello.py", 1024);
    expect(file.content).toBe("print('hi')\n");
    expect(file.truncated).toBe(false);
    expect(calls.some((c) => c.url.includes("path=hello.py"))).toBe(true);
  });
});
