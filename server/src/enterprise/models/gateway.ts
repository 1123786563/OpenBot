import { PlanModel } from "../../agents/plan-model";
import { type RuntimeModel, runtimeModelForEnvironment } from "../../copilot";
import { anthropicMessagesUrl, chatCompletionsUrl } from "../../routing/model";
import type { ModelInvocationContext } from "../contracts";
import type { RuntimeModelRoute } from "./runtime-adapter";

export interface ModelGateway {
  handle(request: Request): Promise<Response>;
}

export type AuthorizedModelInvocation = {
  context: ModelInvocationContext;
  confirmUsage(usedTokens: number): Promise<void>;
  markUnknown(): Promise<void>;
};
export type ResolveAuthorizedInvocation = (
  request: Request,
) => Promise<AuthorizedModelInvocation>;
export type ModelGatewayDependencies = {
  resolveInvocation: ResolveAuthorizedInvocation;
  selectModel(routeRef: string): Promise<RuntimeModelRoute | null>;
  resolveApiKey(
    provider: "openai" | "anthropic",
    route: RuntimeModelRoute,
    environment: Record<string, string | undefined>,
  ): Promise<string | null>;
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  streamTimeoutMs?: number;
  timer?: {
    schedule(callback: () => void, milliseconds: number): unknown;
    cancel(handle: unknown): void;
  };
  createPlanModel?(
    config: NonNullable<RuntimeModel["plan"]>,
    botId: string,
    threadId: string,
    signal: AbortSignal,
  ): Pick<PlanModel, "doGenerate"> & Partial<Pick<PlanModel, "doStream">>;
};

type Message = Record<string, unknown> & { role: string; content: unknown };
type Input = {
  messages: Message[];
  maxTokens: number;
  stream: boolean;
  model?: string;
  tools?: unknown[];
  toolChoice?: unknown;
};
const error = (status: number, code: string) =>
  Response.json({ error: { code } }, { status });
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function sanitizeValue(value: unknown, secret: string): unknown {
  if (typeof value === "string")
    return secret ? value.split(secret).join("[redacted]") : value;
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(item, secret));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeValue(item, secret),
      ]),
    );
  return value;
}
function safeToolChoice(value: unknown) {
  if (
    value === undefined ||
    value === "auto" ||
    value === "none" ||
    value === "required"
  )
    return true;
  return (
    object(value) &&
    value.type === "function" &&
    object(value.function) &&
    validName(value.function.name) &&
    Object.keys(value).every((k) => k === "type" || k === "function") &&
    Object.keys(value.function).every((k) => k === "name")
  );
}
function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\s]/.test(value)
  );
}
function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    ![...value].some((character) => character.charCodeAt(0) < 32)
  );
}
function validContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((b) => {
    if (!object(b)) return false;
    if (b.type === "text")
      return (
        typeof b.text === "string" &&
        Object.keys(b).every((k) => ["type", "text"].includes(k))
      );
    if (b.type === "image_url") {
      const image =
        typeof b.image_url === "string"
          ? b.image_url
          : object(b.image_url)
            ? b.image_url.url
            : undefined;
      return (
        typeof image === "string" &&
        /^(https?:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(image) &&
        Object.keys(b).every((k) => ["type", "image_url"].includes(k))
      );
    }
    return false;
  });
}
function validJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return object(parsed);
  } catch {
    return false;
  }
}
function parseInput(value: unknown): Input | null {
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "model",
          "messages",
          "max_tokens",
          "stream",
          "tools",
          "tool_choice",
        ].includes(k),
    )
  )
    return null;
  if (
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 200
  )
    return null;
  const messages: Message[] = [];
  for (const raw of value.messages) {
    if (
      !object(raw) ||
      !["system", "developer", "user", "assistant", "tool"].includes(
        String(raw.role),
      )
    )
      return null;
    const role = String(raw.role);
    if (
      !(
        typeof raw.content === "string" ||
        raw.content === null ||
        Array.isArray(raw.content)
      )
    )
      return null;
    const allowed =
      role === "assistant"
        ? ["role", "content", "tool_calls", "name"]
        : role === "tool"
          ? ["role", "content", "tool_call_id", "name"]
          : ["role", "content", "name"];
    if (Object.keys(raw).some((k) => !allowed.includes(k))) return null;
    if (raw.name !== undefined && !validName(raw.name)) return null;
    if (role === "tool" && !validId(raw.tool_call_id)) return null;
    if (
      role === "assistant" &&
      raw.tool_calls !== undefined &&
      (!Array.isArray(raw.tool_calls) ||
        raw.tool_calls.some(
          (call) =>
            !object(call) ||
            call.type !== "function" ||
            !validId(call.id) ||
            !object(call.function) ||
            !validName(call.function.name) ||
            typeof call.function.arguments !== "string" ||
            !validJsonObject(call.function.arguments) ||
            Object.keys(call).some(
              (k) => !["id", "type", "function"].includes(k),
            ) ||
            Object.keys(call.function).some(
              (k) => !["name", "arguments"].includes(k),
            ),
        ))
    )
      return null;
    if (role !== "assistant" && role !== "tool" && !validContent(raw.content))
      return null;
    if (
      role === "tool" &&
      !(
        typeof raw.content === "string" ||
        (Array.isArray(raw.content) && validContent(raw.content))
      )
    )
      return null;
    if (
      role === "assistant" &&
      raw.content !== null &&
      typeof raw.content !== "string"
    )
      return null;
    if (
      role === "assistant" &&
      Array.isArray(raw.tool_calls) &&
      raw.tool_calls.some(
        (call) =>
          !object(call) ||
          !validId(call.id) ||
          !object(call.function) ||
          !validName(call.function.name) ||
          typeof call.function.arguments !== "string" ||
          !validJsonObject(call.function.arguments),
      )
    )
      return null;
    messages.push(raw as Message);
  }
  if (!Number.isSafeInteger(value.max_tokens) || Number(value.max_tokens) <= 0)
    return null;
  if (value.stream !== undefined && typeof value.stream !== "boolean")
    return null;
  if (
    value.model !== undefined &&
    (typeof value.model !== "string" || value.model.length > 200)
  )
    return null;
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) ||
      value.tools.length > 128 ||
      value.tools.some(
        (t) =>
          !object(t) ||
          t.type !== "function" ||
          !object(t.function) ||
          !validName(t.function.name) ||
          !object(t.function.parameters) ||
          Object.keys(t.function).some(
            (k) => !["name", "description", "parameters"].includes(k),
          ) ||
          (t.function.description !== undefined &&
            typeof t.function.description !== "string"),
      ))
  )
    return null;
  if (!safeToolChoice(value.tool_choice)) return null;
  return {
    messages,
    maxTokens: value.max_tokens as number,
    stream: value.stream === true,
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools } : {}),
    ...(value.tool_choice !== undefined
      ? { toolChoice: value.tool_choice }
      : {}),
  };
}

function usage(value: unknown): number | null {
  if (!object(value)) return null;
  const a = value.input_tokens ?? value.prompt_tokens;
  const b = value.output_tokens ?? value.completion_tokens;
  if (
    !Number.isSafeInteger(a) ||
    Number(a) < 0 ||
    !Number.isSafeInteger(b) ||
    Number(b) < 0
  )
    return null;
  const sum = Number(a) + Number(b);
  if (!Number.isSafeInteger(sum)) return null;
  if (value.total_tokens !== undefined) {
    if (
      !Number.isSafeInteger(value.total_tokens) ||
      Number(value.total_tokens) < 0 ||
      Number(value.total_tokens) !== sum
    )
      return null;
  }
  return sum;
}
const safeJson = (status: number, code: string) => error(status, code);
function validAnthropicResponse(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.content) &&
    body.content.every((block) => {
      if (!object(block)) return false;
      if (block.type === "text") return typeof block.text === "string";
      return (
        block.type === "tool_use" &&
        validId(block.id) &&
        validName(block.name) &&
        object(block.input)
      );
    })
  );
}
function anthropicUsage(
  value: unknown,
): { input: number; output: number; total: number } | null {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.input_tokens) ||
    Number(value.input_tokens) < 0 ||
    !Number.isSafeInteger(value.output_tokens) ||
    Number(value.output_tokens) < 0
  )
    return null;
  const input = Number(value.input_tokens);
  const output = Number(value.output_tokens);
  const total = input + output;
  return Number.isSafeInteger(total) ? { input, output, total } : null;
}

function canonicalOpenAiResponse(body: Record<string, unknown>) {
  if (Object.hasOwn(body, "error")) return null;
  const result: Record<string, unknown> = {};
  if (body.id !== undefined) {
    if (typeof body.id !== "string") return null;
    result.id = body.id;
  }
  if (body.object !== undefined) {
    if (body.object !== "chat.completion") return null;
    result.object = body.object;
  }
  if (body.created !== undefined) {
    if (!Number.isSafeInteger(body.created) || Number(body.created) < 0)
      return null;
    result.created = body.created;
  }
  if (body.model !== undefined) {
    if (typeof body.model !== "string") return null;
    result.model = body.model;
  }
  if (!Array.isArray(body.choices) || body.choices.length === 0) return null;
  const choices: Record<string, unknown>[] = [];
  for (const raw of body.choices) {
    if (
      !object(raw) ||
      !Number.isSafeInteger(raw.index) ||
      Number(raw.index) < 0 ||
      !object(raw.message) ||
      raw.message.role !== "assistant" ||
      !(typeof raw.message.content === "string" || raw.message.content === null)
    )
      return null;
    const choice: Record<string, unknown> = {
      index: raw.index,
      message: { role: "assistant", content: raw.message.content },
    };
    if (raw.message.tool_calls !== undefined) {
      if (!Array.isArray(raw.message.tool_calls)) return null;
      const calls = [];
      for (const call of raw.message.tool_calls) {
        if (
          !object(call) ||
          !validId(call.id) ||
          call.type !== "function" ||
          !object(call.function) ||
          !validName(call.function.name) ||
          typeof call.function.arguments !== "string"
        )
          return null;
        calls.push({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        });
      }
      choice.message = {
        role: "assistant",
        content: raw.message.content,
        tool_calls: calls,
      };
    }
    if (raw.finish_reason !== undefined) {
      if (
        ![null, "stop", "length", "tool_calls", "content_filter"].includes(
          raw.finish_reason as never,
        )
      )
        return null;
      choice.finish_reason = raw.finish_reason;
    }
    choices.push(choice);
  }
  result.choices = choices;
  if (body.usage !== undefined) {
    if (!object(body.usage)) return null;
    const counts: Record<string, number> = {};
    for (const field of [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
    ]) {
      const count = body.usage[field];
      if (!Number.isSafeInteger(count) || Number(count) < 0) return null;
      counts[field] = Number(count);
    }
    if (
      counts.total_tokens !== counts.prompt_tokens + counts.completion_tokens ||
      !Number.isSafeInteger(counts.prompt_tokens + counts.completion_tokens)
    )
      return null;
    result.usage = counts;
  }
  return result;
}

function normalizeAnthropic(body: Record<string, unknown>, id: string) {
  const blocks = Array.isArray(body.content) ? body.content : [];
  const text = blocks
    .filter((b) => object(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as Record<string, unknown>).text)
    .join("");
  const toolCalls = blocks
    .filter((b) => object(b) && b.type === "tool_use")
    .map((b) => {
      const x = b as Record<string, unknown>;
      return {
        id: x.id,
        type: "function",
        function: { name: x.name, arguments: JSON.stringify(x.input ?? {}) },
      };
    });
  const authoritative = anthropicUsage(body.usage);
  return {
    id,
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          body.stop_reason === "tool_use"
            ? "tool_calls"
            : body.stop_reason === "max_tokens"
              ? "length"
              : "stop",
      },
    ],
    ...(authoritative
      ? {
          usage: {
            prompt_tokens: authoritative.input,
            completion_tokens: authoritative.output,
            total_tokens: authoritative.total,
          },
        }
      : {}),
  };
}
function anthropicContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error("unsupported-content");
  return content.map((raw) => {
    if (!object(raw)) throw new Error("unsupported-content");
    if (raw.type === "text" && typeof raw.text === "string")
      return { type: "text", text: raw.text };
    if (raw.type !== "image_url") throw new Error("unsupported-content");
    const rawUrl = raw.image_url;
    const imageUrl =
      typeof rawUrl === "string"
        ? rawUrl
        : object(rawUrl)
          ? rawUrl.url
          : undefined;
    if (typeof imageUrl !== "string") throw new Error("unsupported-image");
    const match =
      /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/i.exec(
        imageUrl,
      );
    if (!match) throw new Error("unsupported-image");
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  });
}
function anthropicMessages(messages: Message[]) {
  const systems = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => m.content);
  const mapped = messages
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m) => {
      if (m.role === "assistant") {
        const content: Record<string, unknown>[] =
          typeof m.content === "string" && m.content
            ? [{ type: "text", text: m.content }]
            : [];
        for (const raw of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
          const c = raw as Record<string, unknown>;
          const f = c.function as Record<string, unknown>;
          let input: unknown = {};
          try {
            input = JSON.parse(String(f.arguments));
          } catch {
            throw new Error("invalid");
          }
          content.push({ type: "tool_use", id: c.id, name: f.name, input });
        }
        return { role: "assistant", content };
      }
      if (m.role === "tool")
        return {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: anthropicContent(m.content),
            },
          ],
        };
      return { role: "user", content: anthropicContent(m.content) };
    });
  return {
    system: systems
      .map((s) => {
        if (typeof s === "string") return s;
        if (
          Array.isArray(s) &&
          s.every(
            (b) => object(b) && b.type === "text" && typeof b.text === "string",
          )
        )
          return s.map((b) => (b as Record<string, unknown>).text).join("\n");
        throw new Error("unsupported-system-content");
      })
      .join("\n"),
    messages: mapped,
  };
}

function redactStream(
  source: ReadableStream<Uint8Array>,
  secret: string,
  settle: (total: number | null) => Promise<void>,
  anthropic: boolean,
  signal?: AbortSignal,
) {
  const reader = source.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const bytes = new Uint8Array(1_048_580);
  let byteLength = 0;
  let incoming: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let incomingOffset = 0;
  let ended = false;
  let settled = false;
  let pendingTerminal: "openai" | "anthropic" | null = null;
  let terminalOutput = "";
  let streamId = "chatcmpl-runtime";
  let inputUsage: number | null = null;
  let outputUsage: number | null = null;
  let sawOpenAiFinish = false;
  let sawStart = false;
  let sawStop = false;
  let sawAnthropicMessageDelta = false;
  const finishedChoices = new Set<number>();
  const openAnthropicBlocks = new Set<number>();
  const tails = new Map<string, string>();
  const abortReader = () => {
    void reader.cancel().catch(() => {});
  };
  const removeAbortListener = () =>
    signal?.removeEventListener("abort", abortReader);
  signal?.addEventListener("abort", abortReader, { once: true });
  const openAiPending = new Map<
    string,
    {
      choiceIndex: number;
      toolIndex?: number;
      field: "content" | "id" | "name" | "arguments";
    }
  >();
  const safeString = (value: string, path: string, flush = false) => {
    const pending = (tails.get(path) ?? "") + value;
    if (!secret) {
      tails.delete(path);
      return pending;
    }
    let out = "";
    let rest = pending;
    while (rest) {
      const at = rest.indexOf(secret);
      if (at >= 0) {
        out += `${rest.slice(0, at)}[redacted]`;
        rest = rest.slice(at + secret.length);
        continue;
      }
      if (flush) {
        out += rest;
        rest = "";
        break;
      }
      let overlap = Math.min(secret.length - 1, rest.length);
      while (overlap && !secret.startsWith(rest.slice(-overlap))) overlap--;
      out += rest.slice(0, rest.length - overlap);
      rest = rest.slice(rest.length - overlap);
      break;
    }
    if (rest) tails.set(path, rest);
    else tails.delete(path);
    return out;
  };

  const eventData = (raw: string) => {
    const lines = raw.split(/\r?\n/);
    const data = lines
      .filter((x) => x.startsWith("data:"))
      .map((x) => x.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) throw new Error("malformed-sse");
    return data;
  };
  const emit = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const encode = async (raw: string): Promise<string> => {
    if (pendingTerminal !== null)
      throw new Error("data-after-provider-terminal");
    const data = eventData(raw);
    if (data === "[DONE]") {
      if (anthropic) throw new Error("unexpected-anthropic-done");
      const tailFrames: string[] = [];
      for (const [path, descriptor] of [...openAiPending]) {
        const rest = safeString("", path, true);
        openAiPending.delete(path);
        if (!rest) continue;
        const delta: Record<string, unknown> = {};
        if (descriptor.field === "content") delta.content = rest;
        else {
          const call: Record<string, unknown> = { index: descriptor.toolIndex };
          if (descriptor.field === "id") call.id = rest;
          if (descriptor.field === "name") call.function = { name: rest };
          if (descriptor.field === "arguments")
            call.function = { arguments: rest };
          delta.tool_calls = [call];
        }
        tailFrames.push(
          emit({
            choices: [
              { index: descriptor.choiceIndex, delta, finish_reason: null },
            ],
          }),
        );
      }
      pendingTerminal = "openai";
      terminalOutput = `${tailFrames.join("")}${emit({ choices: [{ delta: {} }] })}data: [DONE]\n\n`;
      return "";
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error("malformed-sse-json");
    }
    if (!object(value)) throw new Error("malformed-sse-object");
    if (
      Object.hasOwn(value, "type") &&
      (typeof value.type !== "string" ||
        (secret.length > 0 && value.type.includes(secret)))
    )
      throw new Error("invalid-runtime-discriminator");
    if (!anthropic) {
      if (
        Object.hasOwn(value, "error") ||
        !Array.isArray(value.choices) ||
        !value.choices.every(object)
      )
        throw new Error("malformed-openai-event");
      const total = usage(value.usage);
      if (value.usage !== undefined && total === null)
        throw new Error("malformed-openai-usage");
      if (total !== null) outputUsage = total;
      const result: Record<string, unknown> = {};
      if (value.id !== undefined) {
        if (typeof value.id !== "string")
          throw new Error("malformed-openai-id");
        result.id = safeString(value.id, "openai.id", true);
      }
      if (value.object !== undefined) {
        if (value.object !== "chat.completion.chunk")
          throw new Error("malformed-openai-object");
        result.object = value.object;
      }
      if (value.created !== undefined) {
        if (!Number.isSafeInteger(value.created) || Number(value.created) < 0)
          throw new Error("malformed-openai-created");
        result.created = value.created;
      }
      if (value.model !== undefined) {
        if (typeof value.model !== "string")
          throw new Error("malformed-openai-model");
        result.model = safeString(value.model, "openai.model", true);
      }
      const finalChoices: Record<string, unknown>[] = [];
      const tailFrames: string[] = [];
      const deferredFinishFrames: string[] = [];
      for (const choice of value.choices) {
        if (
          (choice.index !== undefined &&
            (!Number.isSafeInteger(choice.index) ||
              Number(choice.index) < 0)) ||
          !object(choice.delta)
        )
          throw new Error("malformed-openai-choice");
        const choiceIndex =
          choice.index === undefined ? 0 : Number(choice.index);
        if (finishedChoices.has(choiceIndex))
          throw new Error("openai-data-after-finish");
        const delta: Record<string, unknown> = {};
        if (choice.delta.role !== undefined) {
          if (choice.delta.role !== "assistant")
            throw new Error("malformed-openai-role");
          delta.role = choice.delta.role;
        }
        if (choice.delta.content !== undefined) {
          if (
            typeof choice.delta.content !== "string" &&
            choice.delta.content !== null
          )
            throw new Error("malformed-openai-content");
          if (typeof choice.delta.content === "string") {
            const path = `openai.choice.${choiceIndex}.content`;
            delta.content = safeString(choice.delta.content, path);
            openAiPending.set(path, { choiceIndex, field: "content" });
          } else delta.content = null;
        }
        if (choice.delta.tool_calls !== undefined) {
          if (!Array.isArray(choice.delta.tool_calls))
            throw new Error("malformed-openai-tools");
          delta.tool_calls = choice.delta.tool_calls.map((rawCall) => {
            if (
              !object(rawCall) ||
              !Number.isSafeInteger(rawCall.index) ||
              Number(rawCall.index) < 0
            )
              throw new Error("malformed-openai-tool");
            const toolIndex = Number(rawCall.index);
            const call: Record<string, unknown> = { index: toolIndex };
            const functionDelta: Record<string, unknown> = {};
            for (const field of ["id", "type"] as const) {
              const part = rawCall[field];
              if (part === undefined) continue;
              if (
                typeof part !== "string" ||
                (field === "type" && part !== "function")
              )
                throw new Error("malformed-openai-tool-field");
              if (field === "type") call.type = part;
              else {
                const path = `openai.choice.${choiceIndex}.tool.${toolIndex}.id`;
                call.id = safeString(part, path);
                openAiPending.set(path, {
                  choiceIndex,
                  toolIndex,
                  field: "id",
                });
              }
            }
            if (rawCall.function !== undefined) {
              if (!object(rawCall.function))
                throw new Error("malformed-openai-function");
              for (const field of ["name", "arguments"] as const) {
                const part = rawCall.function[field];
                if (part === undefined) continue;
                if (typeof part !== "string")
                  throw new Error("malformed-openai-function-field");
                const path = `openai.choice.${choiceIndex}.tool.${toolIndex}.${field}`;
                functionDelta[field] = safeString(part, path);
                openAiPending.set(path, { choiceIndex, toolIndex, field });
              }
            }
            if (Object.keys(functionDelta).length)
              call.function = functionDelta;
            return call;
          });
        }
        const reason = choice.finish_reason ?? null;
        if (
          reason !== null &&
          !["stop", "length", "tool_calls", "content_filter"].includes(
            String(reason),
          )
        )
          throw new Error("malformed-openai-finish");
        if (
          choice.finish_reason !== undefined &&
          ![null, "stop", "length", "tool_calls", "content_filter"].includes(
            choice.finish_reason as never,
          )
        )
          throw new Error("malformed-openai-finish");
        const finalChoice: Record<string, unknown> = {
          index: choiceIndex,
          delta,
          finish_reason: reason,
        };
        finalChoices.push(finalChoice);
        if (reason !== null) {
          let choiceHadTail = false;
          sawOpenAiFinish = true;
          finishedChoices.add(choiceIndex);
          for (const [path, descriptor] of [...openAiPending]) {
            if (descriptor.choiceIndex !== choiceIndex) continue;
            const rest = safeString("", path, true);
            openAiPending.delete(path);
            if (!rest) continue;
            const tailDelta: Record<string, unknown> = {};
            if (descriptor.field === "content") tailDelta.content = rest;
            else {
              const fc: Record<string, unknown> = {};
              if (descriptor.field === "id") fc.id = rest;
              if (descriptor.field === "name") fc.function = { name: rest };
              if (descriptor.field === "arguments")
                fc.function = { arguments: rest };
              tailDelta.tool_calls = [{ index: descriptor.toolIndex, ...fc }];
            }
            tailFrames.push(
              emit({
                ...result,
                choices: [
                  { index: choiceIndex, delta: tailDelta, finish_reason: null },
                ],
              }),
            );
            choiceHadTail = true;
          }
          if (choiceHadTail) {
            finalChoice.finish_reason = null;
            deferredFinishFrames.push(
              emit({
                ...result,
                choices: [
                  { index: choiceIndex, delta: {}, finish_reason: reason },
                ],
              }),
            );
          }
        }
      }
      result.choices = finalChoices;
      if (value.usage !== undefined) {
        const providerUsage = value.usage;
        if (
          !object(providerUsage) ||
          !["prompt_tokens", "completion_tokens", "total_tokens"].every(
            (field) =>
              Number.isSafeInteger(providerUsage[field]) &&
              Number(providerUsage[field]) >= 0,
          )
        )
          throw new Error("malformed-openai-usage");
        if (
          usage(providerUsage) === null ||
          providerUsage.total_tokens !==
            Number(providerUsage.prompt_tokens) +
              Number(providerUsage.completion_tokens)
        )
          throw new Error("malformed-openai-usage");
        result.usage = {
          prompt_tokens: providerUsage.prompt_tokens,
          completion_tokens: providerUsage.completion_tokens,
          total_tokens: providerUsage.total_tokens,
        };
      }
      return `${emit(result)}${tailFrames.join("")}${deferredFinishFrames.join("")}`;
    }
    const type = value.type;
    const chunk = (
      delta: Record<string, unknown>,
      finish: string | null = null,
    ) =>
      emit({
        id: streamId,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
    if (type === "message_start") {
      if (sawStart || !object(value.message) || !object(value.message.usage))
        throw new Error("malformed-anthropic-start");
      sawStart = true;
      if (typeof value.message.id === "string")
        streamId = safeString(value.message.id, "anthropic.id", true);
      const n = value.message.usage.input_tokens;
      inputUsage = Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
      return chunk({ role: "assistant" });
    }
    if (!sawStart) throw new Error("anthropic-before-start");
    if (sawAnthropicMessageDelta && type !== "message_stop")
      throw new Error("anthropic-data-after-message-finish");
    if (type === "content_block_start") {
      const block = value.content_block;
      const index = value.index;
      if (
        !object(block) ||
        !Number.isSafeInteger(index) ||
        Number(index) < 0 ||
        openAnthropicBlocks.has(Number(index))
      )
        throw new Error("malformed-anthropic-block");
      openAnthropicBlocks.add(Number(index));
      if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      )
        return chunk({
          tool_calls: [
            {
              index: Number.isSafeInteger(value.index) ? value.index : 0,
              id: safeString(
                block.id,
                `anthropic.tool.${String(value.index ?? 0)}.id`,
                true,
              ),
              type: "function",
              function: {
                name: safeString(
                  block.name,
                  `anthropic.tool.${String(value.index ?? 0)}.name`,
                  true,
                ),
                arguments: "",
              },
            },
          ],
        });
      if (block.type === "text") return "";
      throw new Error("unsupported-anthropic-block");
    }
    if (type === "content_block_delta") {
      const d = value.delta;
      const index = value.index;
      if (
        !object(d) ||
        !Number.isSafeInteger(index) ||
        !openAnthropicBlocks.has(Number(index))
      )
        throw new Error("malformed-anthropic-delta");
      if (d.type === "text_delta" && typeof d.text === "string") {
        const text = safeString(
          d.text,
          `anthropic.text.${String(value.index ?? 0)}`,
        );
        return text ? chunk({ content: text }) : "";
      }
      if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        const args = safeString(
          d.partial_json,
          `anthropic.args.${String(value.index ?? 0)}`,
        );
        return args
          ? chunk({
              tool_calls: [
                {
                  index: Number.isSafeInteger(value.index) ? value.index : 0,
                  function: { arguments: args },
                },
              ],
            })
          : "";
      }
      throw new Error("unsupported-anthropic-delta");
    }
    if (type === "content_block_stop") {
      if (
        !Number.isSafeInteger(value.index) ||
        !openAnthropicBlocks.has(Number(value.index))
      )
        throw new Error("malformed-anthropic-block-stop");
      const index = Number(value.index);
      openAnthropicBlocks.delete(index);
      const textTail = safeString("", `anthropic.text.${index}`, true);
      const argsTail = safeString("", `anthropic.args.${index}`, true);
      const output = [];
      if (textTail) output.push(chunk({ content: textTail }));
      if (argsTail)
        output.push(
          chunk({ tool_calls: [{ index, function: { arguments: argsTail } }] }),
        );
      return output.join("");
    }
    if (type === "message_delta") {
      if (sawAnthropicMessageDelta || openAnthropicBlocks.size > 0)
        throw new Error("anthropic-message-delta-before-blocks-stopped");
      if (!object(value.usage) || !object(value.delta))
        throw new Error("malformed-anthropic-message-delta");
      sawAnthropicMessageDelta = true;
      const n = value.usage.output_tokens;
      outputUsage =
        Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
      const stop = value.delta.stop_reason;
      return chunk(
        {},
        stop === "tool_use"
          ? "tool_calls"
          : stop === "max_tokens"
            ? "length"
            : "stop",
      );
    }
    if (type === "message_stop") {
      if (sawStop) throw new Error("duplicate-message-stop");
      if (!sawAnthropicMessageDelta)
        throw new Error("anthropic-message-stop-before-message-delta");
      if (openAnthropicBlocks.size > 0)
        throw new Error("anthropic-message-stop-with-open-block");
      sawStop = true;
      const prompt = inputUsage;
      const completion = outputUsage;
      const total =
        prompt !== null && completion !== null ? prompt + completion : null;
      const authoritative = total !== null && Number.isSafeInteger(total);
      pendingTerminal = "anthropic";
      terminalOutput = `${emit({ id: streamId, object: "chat.completion.chunk", choices: [], ...(authoritative ? { usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } } : {}) })}data: [DONE]\n\n`;
      return "";
    }
    if (type === "error") throw new Error("provider-stream-error");
    throw new Error("unsupported-anthropic-event");
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!ended) {
          const boundary =
            byteLength >= 2 &&
            bytes[byteLength - 2] === 10 &&
            bytes[byteLength - 1] === 10
              ? byteLength - 2
              : byteLength >= 4 &&
                  bytes[byteLength - 4] === 13 &&
                  bytes[byteLength - 3] === 10 &&
                  bytes[byteLength - 2] === 13 &&
                  bytes[byteLength - 1] === 10
                ? byteLength - 4
                : -1;
          if (boundary > 1_048_576) throw new Error("event-too-large");
          if (boundary >= 0) {
            const frame = bytes.slice(0, boundary);
            byteLength = 0;
            const safe = await encode(decoder.decode(frame));
            if (safe) {
              controller.enqueue(encoder.encode(safe));
              return;
            }
            continue;
          }
          if (byteLength > 1_048_576) throw new Error("event-too-large");
          if (incomingOffset < incoming.byteLength) {
            if (byteLength === bytes.byteLength)
              throw new Error("event-too-large");
            const byte = incoming[incomingOffset++];
            if (byte === undefined) throw new Error("invalid-sse-byte");
            bytes[byteLength++] = byte;
            continue;
          }
          const next = await reader.read();
          if (signal?.aborted) throw new Error("MODEL_STREAM_ABORTED");
          if (next.done) {
            ended = true;
            if (byteLength > 0) throw new Error("truncated-sse-event");
            if (pendingTerminal === null)
              throw new Error("missing-provider-terminal");
            const total =
              pendingTerminal === "openai"
                ? sawOpenAiFinish && outputUsage !== null
                  ? outputUsage
                  : null
                : inputUsage !== null &&
                    outputUsage !== null &&
                    Number.isSafeInteger(inputUsage + outputUsage)
                  ? inputUsage + outputUsage
                  : null;
            if (signal?.aborted) throw new Error("MODEL_STREAM_ABORTED");
            if (!settled) {
              settled = true;
              await settle(total);
            }
            if (terminalOutput) {
              controller.enqueue(encoder.encode(terminalOutput));
              terminalOutput = "";
              removeAbortListener();
              controller.close();
              return;
            }
            break;
          }
          incoming = next.value;
          incomingOffset = 0;
        }
        if (!settled) {
          settled = true;
          await settle(null);
        }
        removeAbortListener();
        controller.close();
      } catch {
        if (!settled) {
          settled = true;
          await settle(null).catch(() => {});
        }
        await reader.cancel().catch(() => {});
        removeAbortListener();
        controller.error(new Error("MODEL_STREAM_FAILED"));
      }
    },
    async cancel(reason) {
      if (!settled) {
        settled = true;
        await settle(null).catch(() => {});
      }
      await reader.cancel(reason);
      removeAbortListener();
    },
  });
}

function planArguments(value: unknown): string {
  if (typeof value === "string") {
    if (!validJsonObject(value)) throw new Error("invalid-plan-tool-arguments");
    return value;
  }
  if (!object(value)) throw new Error("invalid-plan-tool-arguments");
  return JSON.stringify(value);
}

export function createModelGateway(
  deps: ModelGatewayDependencies,
): ModelGateway {
  const requestTimeoutMs = deps.requestTimeoutMs ?? deps.timeoutMs ?? 120_000;
  const streamTimeoutMs = deps.streamTimeoutMs ?? 300_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0)
    throw new Error("Invalid model request timeout configuration");
  if (
    !Number.isSafeInteger(streamTimeoutMs) ||
    streamTimeoutMs <= 0 ||
    streamTimeoutMs > 900_000
  )
    throw new Error("Invalid model stream timeout configuration");
  const environment = deps.environment ?? process.env;
  const fetcher = deps.fetch ?? fetch;
  const schedule =
    deps.timer?.schedule ??
    ((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds));
  const cancelTimer =
    deps.timer?.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  return {
    async handle(request) {
      if (request.method !== "POST") return error(405, "METHOD_NOT_ALLOWED");
      let invocation: AuthorizedModelInvocation;
      try {
        invocation = await deps.resolveInvocation(request);
      } catch (e) {
        const code =
          object(e) &&
          typeof e.code === "string" &&
          /^[A-Z0-9_]{1,64}$/.test(e.code)
            ? e.code
            : "UNAUTHORIZED";
        return error(code === "UNAUTHORIZED" ? 401 : 403, code);
      }
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > 1_048_576) return error(413, "REQUEST_TOO_LARGE");
      let raw: string;
      try {
        if (!request.body) return error(400, "INVALID_REQUEST");
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_048_576) {
            await reader.cancel();
            return error(413, "REQUEST_TOO_LARGE");
          }
          chunks.push(value);
        }
        const all = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          all.set(chunk, offset);
          offset += chunk.byteLength;
        }
        raw = new TextDecoder("utf-8", { fatal: true }).decode(all);
      } catch {
        return error(400, "INVALID_REQUEST");
      }
      let input: Input | null;
      try {
        input = parseInput(JSON.parse(raw));
      } catch {
        input = null;
      }
      if (!input) return error(400, "UNSUPPORTED_MODEL_REQUEST");
      const context = invocation.context;
      let streamTimer: unknown;
      let requestTimer: unknown;
      let settlementAttempted = false;
      const settle = async (total: number | null) => {
        if (settlementAttempted) return;
        settlementAttempted = true;
        if (streamTimer !== undefined) cancelTimer(streamTimer);
        if (total !== null) {
          try {
            await invocation.confirmUsage(total);
            return;
          } catch {
            // A failed authoritative confirmation leaves dispatched usage ambiguous.
          }
        }
        await invocation.markUnknown();
        if (total !== null) throw new Error("MODEL_SETTLEMENT_FAILED");
      };
      if (input.maxTokens > context.maximumTokens)
        return error(400, "TOKEN_LIMIT_EXCEEDED");
      let route: RuntimeModelRoute | null;
      try {
        route = await deps.selectModel(context.modelRouteRef);
      } catch {
        route = null;
      }
      if (!route) return error(400, "MODEL_ROUTE_UNAVAILABLE");
      let model: RuntimeModel;
      try {
        model = runtimeModelForEnvironment(route.model, environment);
      } catch {
        return error(400, "MODEL_ROUTE_UNAVAILABLE");
      }
      if (input.model && input.model !== model.defaultModel)
        return error(400, "MODEL_HINT_MISMATCH");
      const maxTokens = input.maxTokens;
      const abortController = new AbortController();
      const signal = AbortSignal.any([request.signal, abortController.signal]);
      if (model.plan) {
        requestTimer = schedule(
          () => abortController.abort(new Error("request-timeout")),
          requestTimeoutMs,
        );
        const planConfig = model.plan;
        if (!route.planBotId) {
          if (requestTimer !== undefined) cancelTimer(requestTimer);
          return error(503, "MODEL_ROUTE_UNAVAILABLE");
        }
        try {
          const adapter =
            deps.createPlanModel?.(
              model.plan,
              route.planBotId,
              context.runId,
              signal,
            ) ??
            new PlanModel(
              model.plan,
              route.planBotId,
              { threadId: context.runId },
              new Set(),
              signal,
            );
          const prompt = input.messages.map((m) => {
            if (m.role === "system" || m.role === "developer")
              return { role: "system", content: m.content };
            if (m.role === "assistant") {
              const parts: Record<string, unknown>[] =
                typeof m.content === "string" && m.content
                  ? [{ type: "text", text: m.content }]
                  : [];
              for (const rawCall of Array.isArray(m.tool_calls)
                ? m.tool_calls
                : []) {
                const call = rawCall as Record<string, unknown>;
                const fn = call.function as Record<string, unknown>;
                let args: unknown;
                try {
                  args = JSON.parse(String(fn.arguments));
                } catch {
                  throw new Error("invalid");
                }
                parts.push({
                  type: "tool-call",
                  toolCallId: call.id,
                  toolName: fn.name,
                  input: args,
                });
              }
              return { role: "assistant", content: parts };
            }
            if (m.role === "tool")
              return {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: m.tool_call_id,
                    output: { type: "text", value: m.content },
                  },
                ],
              };
            return {
              role: "user",
              content:
                typeof m.content === "string"
                  ? [{ type: "text", text: m.content }]
                  : m.content,
            };
          });
          const tools = (input.tools ?? []).map((rawTool) => {
            const fn = (rawTool as Record<string, unknown>).function as Record<
              string,
              unknown
            >;
            return {
              type: "function",
              name: fn.name,
              description: fn.description,
              inputSchema: fn.parameters,
            };
          });
          if (input.stream) {
            const doStream = adapter.doStream;
            if (!doStream) throw new Error("stream-adapter-unavailable");
            streamTimer = schedule(
              () => abortController.abort(new Error("stream-timeout")),
              streamTimeoutMs,
            );
            const adapterPromise = Promise.resolve().then(() =>
              doStream.call(adapter, {
                prompt,
                tools,
                maxOutputTokens: maxTokens,
                abortSignal: signal,
              } as never),
            );
            let onAbort: (() => void) | undefined;
            const aborted = new Promise<never>((_resolve, reject) => {
              onAbort = () =>
                reject(signal.reason ?? new Error("request-aborted"));
              if (signal.aborted) onAbort();
              else signal.addEventListener("abort", onAbort, { once: true });
            });
            let generated: Awaited<typeof adapterPromise>;
            try {
              generated = await Promise.race([adapterPromise, aborted]);
            } catch (cause) {
              if (signal.aborted) {
                void adapterPromise
                  .then((late) => late?.stream.cancel())
                  .catch(() => {});
              }
              throw cause;
            } finally {
              if (onAbort) signal.removeEventListener("abort", onAbort);
            }
            if (requestTimer !== undefined) cancelTimer(requestTimer);
            let cancelPlanStream: (() => Promise<void>) | undefined;
            let streamAbort: (() => void) | undefined;
            const source = new ReadableStream<Uint8Array>({
              start(controller) {
                void (async () => {
                  const emit = (value: unknown) =>
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify(value)}\n\n`,
                      ),
                    );
                  emit({
                    id: context.modelRequestId,
                    object: "chat.completion.chunk",
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant" },
                        finish_reason: null,
                      },
                    ],
                  });
                  let toolIndex = 0;
                  let finish: string | null = null;
                  try {
                    const reader = generated.stream.getReader();
                    cancelPlanStream = async () => {
                      await reader.cancel();
                    };
                    streamAbort = () => {
                      void reader.cancel().catch(() => {});
                    };
                    signal.addEventListener("abort", streamAbort, {
                      once: true,
                    });
                    while (true) {
                      const { done, value: part } = await reader.read();
                      if (done) break;
                      if (
                        typeof part.type !== "string" ||
                        part.type.includes(planConfig.token)
                      )
                        throw new Error("invalid-plan-stream-type");
                      if (part.type === "text-delta")
                        emit({
                          id: context.modelRequestId,
                          object: "chat.completion.chunk",
                          choices: [
                            {
                              index: 0,
                              delta: { content: part.delta },
                              finish_reason: null,
                            },
                          ],
                        });
                      if (part.type === "tool-call") {
                        emit({
                          id: context.modelRequestId,
                          object: "chat.completion.chunk",
                          choices: [
                            {
                              index: 0,
                              delta: {
                                tool_calls: [
                                  {
                                    index: toolIndex++,
                                    id: part.toolCallId,
                                    type: "function",
                                    function: {
                                      name: part.toolName,
                                      arguments: planArguments(part.input),
                                    },
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        });
                        finish = "tool_calls";
                      }
                      if (part.type === "finish")
                        finish =
                          part.finishReason.unified === "tool-calls"
                            ? "tool_calls"
                            : part.finishReason.unified === "length"
                              ? "length"
                              : "stop";
                      if (part.type === "error") throw part.error;
                    }
                    emit({
                      id: context.modelRequestId,
                      object: "chat.completion.chunk",
                      choices: [
                        {
                          index: 0,
                          delta: {},
                          finish_reason: finish ?? "stop",
                        },
                      ],
                    });
                    controller.enqueue(
                      new TextEncoder().encode("data: [DONE]\n\n"),
                    );
                    controller.close();
                  } catch {
                    await cancelPlanStream?.().catch(() => {});
                    controller.error(new Error("MODEL_STREAM_FAILED"));
                  } finally {
                    if (streamAbort)
                      signal.removeEventListener("abort", streamAbort);
                  }
                })();
              },
              async cancel() {
                if (streamAbort)
                  signal.removeEventListener("abort", streamAbort);
                await cancelPlanStream?.();
              },
            });
            const body = redactStream(
              source,
              model.plan.token,
              async () => settle(null),
              false,
              signal,
            );
            return new Response(body, {
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
              },
            });
          }
          const result = await adapter.doGenerate({
            prompt,
            tools,
            maxOutputTokens: maxTokens,
            abortSignal: signal,
          } as never);
          if (requestTimer !== undefined) cancelTimer(requestTimer);
          await settle(null);
          const text = result.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("");
          const toolCalls = result.content
            .filter((p) => p.type === "tool-call")
            .map((p) => ({
              id: p.toolCallId,
              type: "function",
              function: {
                name: p.toolName,
                arguments: planArguments(p.input),
              },
            }));
          return Response.json(
            sanitizeValue(
              {
                id: context.modelRequestId,
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: text || null,
                      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
                    },
                    finish_reason: toolCalls.length ? "tool_calls" : "stop",
                  },
                ],
              },
              model.plan.token,
            ),
          );
        } catch {
          if (requestTimer !== undefined) cancelTimer(requestTimer);
          await settle(null).catch(() => {});
          return error(502, "MODEL_UPSTREAM_UNAVAILABLE");
        }
      }
      const key = await deps
        .resolveApiKey(model.provider, route, environment)
        .catch(() => null);
      if (!key) return error(503, "MODEL_CREDENTIAL_UNAVAILABLE");
      const anthropic = model.provider === "anthropic";
      let payload: Record<string, unknown>;
      if (anthropic) {
        let mapped: ReturnType<typeof anthropicMessages>;
        try {
          mapped = anthropicMessages(input.messages);
        } catch {
          return error(400, "UNSUPPORTED_MODEL_REQUEST");
        }
        const choice =
          input.toolChoice === "required"
            ? { type: "any" }
            : input.toolChoice === "none"
              ? { type: "none" }
              : object(input.toolChoice)
                ? {
                    type: "tool",
                    name: (input.toolChoice.function as Record<string, unknown>)
                      .name,
                  }
                : input.toolChoice === "auto"
                  ? { type: "auto" }
                  : undefined;
        payload = {
          model: model.defaultModel,
          max_tokens: maxTokens,
          messages: mapped.messages,
          ...(mapped.system ? { system: mapped.system } : {}),
          ...(input.stream ? { stream: true } : {}),
          ...(input.tools
            ? {
                tools: input.tools.map((t) => {
                  const f = (t as Record<string, unknown>).function as Record<
                    string,
                    unknown
                  >;
                  return {
                    name: f.name,
                    description: f.description,
                    input_schema: f.parameters,
                  };
                }),
              }
            : {}),
          ...(choice ? { tool_choice: choice } : {}),
        };
      } else
        payload = {
          model: model.defaultModel,
          messages: input.messages,
          max_tokens: maxTokens,
          ...(input.stream ? { stream: true } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          ...(input.toolChoice !== undefined
            ? { tool_choice: input.toolChoice }
            : {}),
        };
      const url = anthropic
        ? anthropicMessagesUrl(environment)
        : chatCompletionsUrl(environment);
      let headers: Headers;
      try {
        headers = new Headers({ "content-type": "application/json" });
        if (anthropic) {
          headers.set("x-api-key", key);
          headers.set("anthropic-version", "2023-06-01");
        } else headers.set("authorization", `Bearer ${key}`);
      } catch {
        return error(503, "MODEL_CREDENTIAL_UNAVAILABLE");
      }
      requestTimer = schedule(
        () => abortController.abort(new Error("request-timeout")),
        requestTimeoutMs,
      );
      const controller = signal;
      let dispatched = false;
      try {
        streamTimer = input.stream
          ? schedule(
              () => abortController.abort(new Error("stream-timeout")),
              streamTimeoutMs,
            )
          : undefined;
        dispatched = true;
        const upstream = await fetcher(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: controller,
        });
        if (input.stream && requestTimer !== undefined)
          cancelTimer(requestTimer);
        if (!upstream.ok) {
          await settle(null);
          return error(502, "MODEL_UPSTREAM_UNAVAILABLE");
        }
        if (input.stream) {
          if (!upstream.body) {
            await settle(null);
            return error(502, "MODEL_UPSTREAM_UNAVAILABLE");
          }
          let settled = false;
          const body = redactStream(
            upstream.body,
            key,
            async (total) => {
              if (settled) return;
              settled = true;
              if (total === null) await settle(null);
              else await settle(total);
            },
            anthropic,
            signal,
          );
          return new Response(body, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          });
        }
        const body = (await upstream.json()) as Record<string, unknown>;
        const total = anthropic
          ? (anthropicUsage(body.usage)?.total ?? null)
          : usage(body.usage);
        const canonical = anthropic ? null : canonicalOpenAiResponse(body);
        const validResponse = anthropic
          ? validAnthropicResponse(body)
          : canonical !== null;
        if (!validResponse) {
          await settle(null);
          return error(502, "MODEL_UPSTREAM_UNAVAILABLE");
        }
        if (total === null) await settle(null);
        else await settle(total);
        const normalized = anthropic
          ? normalizeAnthropic(body, context.modelRequestId)
          : (canonical as Record<string, unknown>);
        if (total === null && object(normalized)) delete normalized.usage;
        return Response.json(sanitizeValue(normalized, key));
      } catch {
        if (dispatched) await settle(null).catch(() => {});
        return safeJson(502, "MODEL_UPSTREAM_UNAVAILABLE");
      } finally {
        if (requestTimer !== undefined) cancelTimer(requestTimer);
        if (!input.stream && streamTimer !== undefined)
          cancelTimer(streamTimer);
      }
    },
  };
}
