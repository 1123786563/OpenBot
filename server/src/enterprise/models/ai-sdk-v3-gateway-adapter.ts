import type { LanguageModel } from "ai";

type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Gateway = { handle(request: Request): Promise<Response> };
type Dependencies = {
  gateway: Gateway;
  issueCapability(maximumTokens: number): Promise<string>;
  routeRef: string;
  runTokenCeiling: number;
};
type CallOptions = Parameters<LanguageModelV3["doGenerate"]>[0];

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const fail = (): never => {
  throw new Error("UNSUPPORTED_OR_INVALID_MODEL_GATEWAY_RESPONSE");
};
const validGatewayName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  !/\s/.test(value);
const validGatewayId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  ![...value].some((character) => character.charCodeAt(0) < 32);
const validJsonObject = (value: string) => {
  try {
    return object(JSON.parse(value));
  } catch {
    return false;
  }
};

function requestMessages(prompt: CallOptions["prompt"]) {
  if (!Array.isArray(prompt) || prompt.length < 1 || prompt.length > 200)
    fail();
  return prompt.flatMap((message) => {
    if (message.providerOptions) fail();
    if (message.role === "system") {
      if (typeof message.content !== "string") fail();
      return { role: "system", content: message.content };
    }
    if (message.role === "user") {
      const content = message.content.map((part) => {
        if (part.providerOptions) fail();
        if (part.type === "text") {
          if (typeof part.text !== "string") fail();
          return { type: "text", text: part.text };
        }
        if (
          part.type === "file" &&
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            part.mediaType,
          )
        ) {
          if (part.filename !== undefined) fail();
          const data =
            typeof part.data === "string"
              ? part.data
              : part.data instanceof Uint8Array
                ? `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`
                : fail();
          const imageUrl =
            data.startsWith("data:") || /^https?:/.test(data)
              ? data
              : `data:${part.mediaType};base64,${data}`;
          if (
            !/^(https?:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(
              imageUrl,
            )
          )
            fail();
          return { type: "image_url", image_url: imageUrl };
        }
        return fail();
      });
      return { role: "user", content };
    }
    if (message.role === "assistant") {
      const text: string[] = [];
      const tool_calls: unknown[] = [];
      for (const part of message.content as any[]) {
        if (part.providerOptions) fail();
        if (part.type === "text") text.push(part.text);
        else if (
          part.type === "tool-call" &&
          !part.providerExecuted &&
          !(part as any).dynamic
        ) {
          if (
            !validGatewayId(part.toolCallId) ||
            !validGatewayName(part.toolName) ||
            !object(part.input)
          )
            fail();
          const argumentsValue = JSON.stringify(part.input);
          if (!validJsonObject(argumentsValue)) fail();
          tool_calls.push({
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.toolName,
              arguments: argumentsValue,
            },
          });
        } else return fail();
      }
      return {
        role: "assistant",
        content: text.join("") || null,
        ...(tool_calls.length ? { tool_calls } : {}),
      };
    }
    if (message.role === "tool") {
      // AI SDK merges a step's tool results into one message whose parts
      // each carry their own toolCallId; the OpenAI chat wire format wants
      // one tool message per tool_call_id (R5-H1).
      const entries: unknown[] = [];
      for (const part of message.content as any[]) {
        if (
          part.type !== "tool-result" ||
          part.providerOptions ||
          part.output.type !== "text" ||
          part.output.providerOptions ||
          typeof part.output.value !== "string" ||
          !validGatewayId(part.toolCallId)
        )
          fail();
        entries.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          content: part.output.value,
        });
      }
      if (entries.length === 0) fail();
      return entries;
    }
    return fail();
  });
}

function callPayload(
  options: CallOptions,
  dependencies: Dependencies,
  stream: boolean,
  remaining: number,
) {
  const ceiling = options.maxOutputTokens;
  if (!Number.isSafeInteger(ceiling) || Number(ceiling) <= 0) fail();
  const requestedOutputTokens = Number(ceiling);
  if (
    options.temperature !== undefined ||
    options.stopSequences ||
    options.topP !== undefined ||
    options.topK !== undefined ||
    options.presencePenalty !== undefined ||
    options.frequencyPenalty !== undefined ||
    options.responseFormat ||
    options.seed !== undefined ||
    options.providerOptions ||
    options.headers ||
    options.includeRawChunks
  )
    fail();
  const tools = options.tools?.map((tool) => {
    if (
      tool.type !== "function" ||
      tool.providerOptions ||
      tool.strict !== undefined ||
      !validGatewayName(tool.name)
    )
      fail();
    const description = (tool as any).description;
    const parameters = (tool as any).inputSchema;
    if (
      (description !== undefined && typeof description !== "string") ||
      !object(parameters)
    )
      fail();
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(description ? { description } : {}),
        parameters,
      },
    };
  });
  let tool_choice: unknown;
  if (options.toolChoice) {
    if (
      options.toolChoice.type === "auto" ||
      options.toolChoice.type === "none" ||
      options.toolChoice.type === "required"
    )
      tool_choice = options.toolChoice.type;
    else if (options.toolChoice.type === "tool") {
      if (!validGatewayName(options.toolChoice.toolName)) fail();
      tool_choice = {
        type: "function",
        function: { name: options.toolChoice.toolName },
      };
    } else fail();
  }
  if (typeof dependencies.routeRef !== "string" || !dependencies.routeRef)
    fail();
  return {
    messages: requestMessages(options.prompt),
    max_tokens: Math.min(requestedOutputTokens, remaining),
    ...(stream ? { stream: true } : {}),
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
  };
}

async function invoke(
  options: CallOptions,
  dependencies: Dependencies,
  stream: boolean,
  ledger: { settledTokens: number },
) {
  if (options.abortSignal?.aborted)
    throw options.abortSignal.reason ?? new Error("MODEL_GATEWAY_ABORTED");
  const remaining = dependencies.runTokenCeiling - ledger.settledTokens;
  if (!Number.isSafeInteger(remaining) || remaining <= 0)
    throw new Error("MODEL_GATEWAY_RUN_BUDGET_EXHAUSTED");
  const payload = callPayload(options, dependencies, stream, remaining);
  const body = JSON.stringify(payload);
  const capability = await dependencies.issueCapability(remaining);
  if (
    typeof capability !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
    Buffer.from(capability, "base64url").byteLength !== 32 ||
    Buffer.from(capability, "base64url").toString("base64url") !== capability
  )
    fail();
  return dependencies.gateway.handle(
    new Request("https://model-gateway.invalid/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "content-type": "application/json",
        ...(stream ? { accept: "text/event-stream" } : {}),
      },
      body,
      signal: options.abortSignal,
    }),
  );
}

function usage(value: unknown) {
  if (
    !object(value) ||
    !Number.isSafeInteger(value.prompt_tokens) ||
    value.prompt_tokens < 0 ||
    !Number.isSafeInteger(value.completion_tokens) ||
    value.completion_tokens < 0 ||
    value.total_tokens !== value.prompt_tokens + value.completion_tokens
  )
    fail();
  const usageValue = value as Record<string, any>;
  return {
    inputTokens: {
      total: usageValue.prompt_tokens,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usageValue.completion_tokens,
      text: usageValue.completion_tokens,
      reasoning: undefined,
    },
    raw: usageValue,
  };
}

// `Record<string, any>` / `as any[]` at these boundaries: @ai-sdk/provider
// does not export the concrete prompt part unions for LanguageModelV3, so
// every field is narrowed and fail()-closed manually instead.
function mappedContent(message: Record<string, any>) {
  if (
    message.role !== "assistant" ||
    !(typeof message.content === "string" || message.content === null)
  )
    fail();
  const content: any[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) fail();
    for (const call of message.tool_calls) {
      if (
        !object(call) ||
        call.type !== "function" ||
        !object(call.function) ||
        !validGatewayId(call.id) ||
        !validGatewayName(call.function.name) ||
        typeof call.function.arguments !== "string"
      )
        fail();
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        return fail();
      }
      if (!object(input)) fail();
      content.push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.function.name,
        input: call.function.arguments,
        providerExecuted: false,
      });
    }
  }
  return content;
}

/**
 * Read a structured non-2xx gateway body best-effort and surface status plus
 * code in the thrown message: downstream failure classification keys on these
 * markers, and fail-closed semantics are unchanged (nothing streams on).
 */
async function gatewayHttpError(response: Response): Promise<Error> {
  let code = "";
  try {
    const body: unknown = await response.json();
    const nested = object(body)
      ? (body as { error?: unknown }).error
      : undefined;
    if (object(nested) && typeof nested.code === "string") code = nested.code;
  } catch {
    // Unreadable or non-JSON error bodies still fail closed with the status.
  }
  return new Error(
    `MODEL_GATEWAY_HTTP_${response.status}${code ? ` ${code}` : ""}`,
  );
}

const UNIFIED_FINISH_REASONS: Record<string, string> = {
  length: "length",
  tool_calls: "tool-calls",
  content_filter: "content-filter",
  stop: "stop",
};

function finishReason(reason: unknown) {
  if (typeof reason !== "string" || !(reason in UNIFIED_FINISH_REASONS)) fail();
  return {
    unified: UNIFIED_FINISH_REASONS[reason as string],
    raw: reason,
  } as const;
}

export function createAiSdkV3GatewayAdapter(
  dependencies: Dependencies,
): LanguageModelV3 {
  const ledger = { settledTokens: 0 };
  return {
    specificationVersion: "v3",
    provider: "openbot",
    modelId: dependencies.routeRef,
    supportedUrls: {},
    async doGenerate(options) {
      const response = await invoke(options, dependencies, false, ledger);
      if (!response.ok) throw await gatewayHttpError(response);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        await response.body?.cancel().catch(() => {});
        return fail();
      }
      if (
        !object(body) ||
        !Array.isArray(body.choices) ||
        body.choices.length !== 1 ||
        !object(body.choices[0]) ||
        !object(body.choices[0].message)
      )
        fail();
      const bodyValue = body as Record<string, any>;
      const choice = bodyValue.choices[0];
      const mapped = mappedContent(choice.message);
      const reason = finishReason(choice.finish_reason);
      const settledUsage = usage(bodyValue.usage);
      ledger.settledTokens +=
        settledUsage.inputTokens.total + settledUsage.outputTokens.total;
      return {
        content: mapped,
        finishReason: reason,
        usage: settledUsage,
        response: {
          ...(typeof bodyValue.id === "string" ? { id: bodyValue.id } : {}),
          ...(typeof bodyValue.created === "number"
            ? { timestamp: new Date(bodyValue.created * 1000) }
            : {}),
          ...(typeof bodyValue.model === "string"
            ? { modelId: bodyValue.model }
            : {}),
        },
        warnings: [],
      } as any;
    },
    async doStream(options) {
      const response = await invoke(options, dependencies, true, ledger);
      if (!response.ok) throw await gatewayHttpError(response);
      // A 2xx with no body is protocol damage, not an HTTP error: never
      // surface it as MODEL_GATEWAY_HTTP_200 (OCR R10).
      if (!response.body) fail();
      const reader = response.body!.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let id = "gateway-response";
      let terminalUsage: ReturnType<typeof usage> | undefined;
      let terminalReason: ReturnType<typeof finishReason> | undefined;
      let terminalSeen = false;
      let terminalPlaceholderSeen = false;
      let responseId: string | undefined;
      const choiceStates = new Map<
        number,
        {
          textId: string;
          textStarted: boolean;
          textEnded: boolean;
          finishReason?: ReturnType<typeof finishReason>;
          tools: Map<number, { id: string; name: string; arguments: string }>;
        }
      >();
      const observedToolIds = new Set<string>();
      let controllerRef: ReadableStreamDefaultController<any> | undefined;
      const abortReason = () =>
        options.abortSignal?.reason ?? new Error("MODEL_GATEWAY_ABORTED");
      const onAbort = () => {
        const reason = abortReason();
        void reader.cancel(reason).catch(() => {});
        try {
          controllerRef?.error(reason);
        } catch {}
      };
      const stream = new ReadableStream<any>({
        start(controller) {
          controllerRef = controller;
          controller.enqueue({ type: "stream-start", warnings: [] });
          options.abortSignal?.addEventListener("abort", onAbort, {
            once: true,
          });
          if (options.abortSignal?.aborted) onAbort();
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (options.abortSignal?.aborted) throw abortReason();
                buffer += decoder.decode(value, { stream: !done });
                if (terminalSeen) {
                  if (buffer.trim()) fail();
                  buffer = "";
                  if (done) {
                    if (!terminalUsage || !terminalReason) fail();
                    const settledUsage = terminalUsage ?? fail();
                    ledger.settledTokens +=
                      settledUsage.inputTokens.total +
                      settledUsage.outputTokens.total;
                    controller.enqueue({
                      type: "finish",
                      usage: settledUsage,
                      finishReason: terminalReason,
                    });
                    controller.close();
                    return;
                  }
                  continue;
                }
                let boundary = buffer.search(/\r?\n\r?\n/);
                while (boundary >= 0) {
                  const frame = buffer.slice(0, boundary);
                  buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
                  boundary = buffer.search(/\r?\n\r?\n/);
                  const data = frame
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");
                  if (!data) fail();
                  if (data === "[DONE]") {
                    if (
                      terminalSeen ||
                      !terminalUsage ||
                      !terminalReason ||
                      [...choiceStates.values()].some(
                        (choice) => !choice.finishReason,
                      ) ||
                      buffer.trim()
                    )
                      fail();
                    terminalSeen = true;
                    break;
                  }
                  if (terminalPlaceholderSeen) fail();
                  let chunk: unknown;
                  try {
                    chunk = JSON.parse(data);
                  } catch {
                    return fail();
                  }
                  if (
                    !object(chunk) ||
                    chunk.type !== undefined ||
                    (chunk.object !== undefined &&
                      chunk.object !== "chat.completion.chunk") ||
                    !Array.isArray(chunk.choices)
                  )
                    fail();
                  const chunkValue = chunk as Record<string, any>;
                  if (
                    terminalReason &&
                    terminalUsage &&
                    Object.keys(chunkValue).length === 1 &&
                    Array.isArray(chunkValue.choices) &&
                    chunkValue.choices.length === 1 &&
                    object(chunkValue.choices[0]) &&
                    Object.keys(chunkValue.choices[0]).length === 1 &&
                    object(chunkValue.choices[0].delta) &&
                    Object.keys(chunkValue.choices[0].delta).length === 0
                  ) {
                    terminalPlaceholderSeen = true;
                    boundary = buffer.search(/\r?\n\r?\n/);
                    continue;
                  }
                  if (chunkValue.id !== undefined) {
                    if (typeof chunkValue.id !== "string") fail();
                    if (
                      responseId !== undefined &&
                      responseId !== chunkValue.id
                    )
                      fail();
                    responseId = chunkValue.id;
                    id = chunkValue.id;
                  }
                  if (chunkValue.usage !== undefined) {
                    const settledUsage = usage(chunkValue.usage);
                    // A second usage block must agree with the first; the
                    // ledger settlement amount comes from terminalUsage (R5-L1).
                    if (
                      terminalUsage &&
                      (terminalUsage.inputTokens.total !==
                        settledUsage.inputTokens.total ||
                        terminalUsage.outputTokens.total !==
                          settledUsage.outputTokens.total)
                    )
                      fail();
                    terminalUsage = settledUsage;
                  }
                  for (const choice of chunkValue.choices) {
                    if (
                      !object(choice) ||
                      !Number.isSafeInteger(choice.index) ||
                      choice.index < 0 ||
                      !object(choice.delta)
                    )
                      fail();
                    let state = choiceStates.get(choice.index);
                    if (!state) {
                      state = {
                        textId: `${id}-text-${choice.index}`,
                        textStarted: false,
                        textEnded: false,
                        tools: new Map(),
                      };
                      choiceStates.set(choice.index, state);
                    }
                    if (state.finishReason) fail();
                    if (
                      choice.delta.role !== undefined &&
                      choice.delta.role !== "assistant"
                    )
                      fail();
                    if (choice.delta.content !== undefined) {
                      if (typeof choice.delta.content !== "string") fail();
                      if (!state.textStarted) {
                        state.textStarted = true;
                        controller.enqueue({
                          type: "text-start",
                          id: state.textId,
                        });
                      }
                      controller.enqueue({
                        type: "text-delta",
                        id: state.textId,
                        delta: choice.delta.content,
                      });
                    }
                    if (choice.delta.tool_calls !== undefined) {
                      if (!Array.isArray(choice.delta.tool_calls)) fail();
                      for (const call of choice.delta.tool_calls) {
                        if (
                          !object(call) ||
                          !Number.isSafeInteger(call.index) ||
                          !object(call.function ?? {})
                        )
                          fail();
                        let tool = state.tools.get(call.index);
                        if (!tool) {
                          tool = { id: "", name: "", arguments: "" };
                          state.tools.set(call.index, tool);
                        }
                        if (call.id !== undefined) {
                          if (typeof call.id !== "string") fail();
                          tool.id += call.id;
                        }
                        if (call.function.name !== undefined) {
                          if (typeof call.function.name !== "string") fail();
                          tool.name += call.function.name;
                        }
                        if (call.function.arguments !== undefined) {
                          if (typeof call.function.arguments !== "string")
                            fail();
                          tool.arguments += call.function.arguments;
                        }
                      }
                    }
                    if (
                      choice.finish_reason !== undefined &&
                      choice.finish_reason !== null
                    ) {
                      state.finishReason = finishReason(choice.finish_reason);
                      if (
                        terminalReason &&
                        JSON.stringify(terminalReason) !==
                          JSON.stringify(state.finishReason)
                      )
                        fail();
                      terminalReason = state.finishReason;
                      if (state.textStarted && !state.textEnded) {
                        state.textEnded = true;
                        controller.enqueue({
                          type: "text-end",
                          id: state.textId,
                        });
                      }
                      for (const tool of state.tools.values()) {
                        if (
                          !tool.id ||
                          tool.id.length > 256 ||
                          [...tool.id].some(
                            (character) => character.charCodeAt(0) < 32,
                          ) ||
                          observedToolIds.has(tool.id) ||
                          !tool.name ||
                          tool.name.length > 128 ||
                          /\s/.test(tool.name) ||
                          !tool.arguments
                        )
                          fail();
                        observedToolIds.add(tool.id);
                        let parsedArguments: unknown;
                        try {
                          parsedArguments = JSON.parse(tool.arguments);
                        } catch {
                          fail();
                        }
                        if (!object(parsedArguments)) fail();
                        controller.enqueue({
                          type: "tool-input-start",
                          id: tool.id,
                          toolName: tool.name,
                        });
                        controller.enqueue({
                          type: "tool-input-delta",
                          id: tool.id,
                          delta: tool.arguments,
                        });
                        controller.enqueue({
                          type: "tool-input-end",
                          id: tool.id,
                        });
                        controller.enqueue({
                          type: "tool-call",
                          toolCallId: tool.id,
                          toolName: tool.name,
                          input: tool.arguments,
                          providerExecuted: false,
                        });
                      }
                      if (
                        state.tools.size > 0 &&
                        state.finishReason.unified !== "tool-calls"
                      )
                        fail();
                    }
                  }
                  boundary = buffer.search(/\r?\n\r?\n/);
                }
                if (done && !terminalSeen) {
                  if (buffer.trim()) fail();
                  throw new Error("MISSING_TERMINAL_USAGE");
                }
              }
            } catch (error) {
              await reader.cancel(error).catch(() => {});
              try {
                controller.error(error);
              } catch {}
            } finally {
              options.abortSignal?.removeEventListener("abort", onAbort);
            }
          };
          void pump();
        },
        async cancel(reason) {
          options.abortSignal?.removeEventListener("abort", onAbort);
          await reader.cancel(reason);
        },
      });
      return {
        stream,
        response: { headers: Object.fromEntries(response.headers.entries()) },
      } as any;
    },
  };
}
