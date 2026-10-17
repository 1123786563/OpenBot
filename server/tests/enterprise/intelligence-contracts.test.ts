import { expect, test } from "../../../tests/support/e2e-compat";
import { convertMessages, type MastraDBMessage } from "@mastra/core/agent";
import { InMemoryStore } from "@mastra/core/storage";
import { Memory } from "@mastra/memory";
import type { PlatformScope } from "../../src/enterprise/contracts";
import {
  type AppendConflict,
  type AuthorizedConversationBinding,
  appendConflict,
  type BindingAttestation,
  createAuthorizedConversationBindingAuthority,
  type IntelligenceError,
  type IntelligenceFailureCode,
  type IntelligenceResult,
  type IntelligenceService,
  intelligenceFailure,
  type MessageInput,
  normalizeIntelligenceError,
  parseMessageInput,
} from "../../src/mastra/intelligence-contracts";

// @ts-expect-error The module-private brand prevents caller construction.
const forgedBinding: AuthorizedConversationBinding = {
  conversationId: "conversation-a",
  tenantId: "tenant-a",
  principalId: "principal-a",
  threadId: "client-selected-thread",
  resourceId: "client-selected-resource",
  authorizationEpoch: 1,
  attestation: "forged-attestation" as BindingAttestation,
};

const emptyMessage: MessageInput = {
  // @ts-expect-error Empty IDs are rejected by the branded message contract.
  id: "",
  role: "user",
  content: { format: 2, parts: [] },
};

// @ts-expect-error Failures cannot be fabricated from public fields.
const fabricatedFailure: IntelligenceError = {
  code: "unavailable",
  retryable: true,
  message: "provider detail",
};

const fabricatedResult: IntelligenceResult<unknown> = {
  ok: false,
  // @ts-expect-error Only the module can construct a branded error value.
  error: {
    code: "unavailable",
    retryable: true,
    message: "provider detail",
  },
};

const scope: PlatformScope = {
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  actorId: "actor-a",
  memberEpoch: 1,
  aclEpoch: 1,
  entrypoint: "web",
};

const bindingInput = {
  conversationId: "conversation-a",
  threadId: "thread-a",
  resourceId: "resource-a",
  authorizationEpoch: 7,
} as const;
const bindingSecret = "test-only-authorized-binding-secret-32-bytes";

test("authorized binding authority requires at least 32 UTF-8 secret bytes", () => {
  expect(() =>
    createAuthorizedConversationBindingAuthority("é".repeat(15)),
  ).toThrow();
  expect(() =>
    createAuthorizedConversationBindingAuthority("é".repeat(16)),
  ).not.toThrow();
});

test("authorized binding verifies mint and JSON round-trip only in its signed context", () => {
  const authority = createAuthorizedConversationBindingAuthority(bindingSecret);
  const binding = authority.mint(scope, bindingInput);
  expect(Object.isFrozen(authority)).toBe(true);
  expect(Object.isFrozen(binding)).toBe(true);
  expect(binding).toMatchObject({
    ...bindingInput,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    memberEpoch: scope.memberEpoch,
    aclEpoch: scope.aclEpoch,
  });
  const verified = authority.verify(
    scope,
    bindingInput.conversationId,
    binding,
  );
  expect(verified).toEqual(binding);
  expect(verified).not.toBe(binding);
  expect(Object.isFrozen(verified)).toBe(true);
  expect(
    authority.verify(
      scope,
      bindingInput.conversationId,
      JSON.parse(JSON.stringify(binding)),
    ),
  ).toEqual(binding);

  const serialized = JSON.parse(JSON.stringify(binding)) as Record<
    string,
    unknown
  >;
  expect(
    authority.verify(scope, bindingInput.conversationId, {
      ...serialized,
      extra: true,
    }),
  ).toBeUndefined();
  expect(
    authority.verify(scope, bindingInput.conversationId, {
      ...serialized,
      attestation: "forged",
    }),
  ).toBeUndefined();
  const hiddenExtra = { ...serialized };
  Object.defineProperty(hiddenExtra, "unserialized", { value: true });
  expect(
    authority.verify(scope, bindingInput.conversationId, hiddenExtra),
  ).toBeUndefined();

  const signedFields = [
    "conversationId",
    "tenantId",
    "workspaceId",
    "principalId",
    "memberEpoch",
    "aclEpoch",
    "threadId",
    "resourceId",
    "authorizationEpoch",
  ] as const;
  for (const field of signedFields) {
    const tampered = { ...serialized, [field]: serialized[field] };
    tampered[field] =
      typeof serialized[field] === "number"
        ? (serialized[field] as number) + 1
        : `${String(serialized[field])}-tampered`;
    expect(
      authority.verify(scope, bindingInput.conversationId, tampered),
    ).toBeUndefined();
  }

  expect(
    createAuthorizedConversationBindingAuthority(
      "a-different-binding-secret-with-enough-bytes",
    ).verify(scope, bindingInput.conversationId, binding),
  ).toBeUndefined();
  expect(
    authority.verify(
      { ...scope, workspaceId: "workspace-other" },
      bindingInput.conversationId,
      binding,
    ),
  ).toBeUndefined();
  expect(
    authority.verify(scope, "conversation-other", binding),
  ).toBeUndefined();
});

test("authorized binding verification uses captured data descriptors only", () => {
  const authority = createAuthorizedConversationBindingAuthority(bindingSecret);
  const binding = authority.mint(scope, bindingInput);
  const serialized = JSON.parse(JSON.stringify(binding)) as Record<
    string,
    unknown
  >;
  const hostileTenant = {
    toJSON: () => scope.tenantId,
  };
  let tenantReads = 0;
  const disagreeingProxy = new Proxy(serialized, {
    get(target, property, receiver) {
      if (property === "tenantId" && ++tenantReads > 1) {
        return hostileTenant;
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const verified = authority.verify(
    scope,
    bindingInput.conversationId,
    disagreeingProxy,
  );
  expect(verified?.tenantId).toBe(scope.tenantId);
  expect(tenantReads).toBe(0);

  const accessor = { ...serialized };
  Object.defineProperty(accessor, "tenantId", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("must not invoke candidate getter");
    },
  });
  expect(
    authority.verify(scope, bindingInput.conversationId, accessor),
  ).toBeUndefined();

  const throwingDescriptorProxy = new Proxy(serialized, {
    getOwnPropertyDescriptor() {
      throw new Error("untrusted descriptor trap");
    },
  });
  expect(
    authority.verify(
      scope,
      bindingInput.conversationId,
      throwingDescriptorProxy,
    ),
  ).toBeUndefined();

  const { proxy: revokedProxy, revoke } = Proxy.revocable(serialized, {});
  revoke();
  expect(
    authority.verify(scope, bindingInput.conversationId, revokedProxy),
  ).toBeUndefined();
});

test("Mastra storage memory works without Agent.run", async () => {
  const memory = new Memory({
    storage: new InMemoryStore(),
    options: { workingMemory: { enabled: true } },
  });
  await memory.saveThread({
    thread: {
      id: "thread-a",
      resourceId: "resource-a",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
  await memory.updateWorkingMemory({
    threadId: "thread-a",
    resourceId: "resource-a",
    workingMemory: "prefers concise answers",
  });
  expect(
    await memory.getWorkingMemory({
      threadId: "thread-a",
      resourceId: "resource-a",
    }),
  ).toBe("prefers concise answers");

  const messages: MastraDBMessage[] = [
    {
      id: "message-a",
      role: "user",
      threadId: "thread-a",
      resourceId: "resource-a",
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mimeType: "text/plain",
            data: "data:text/plain;base64,eA==",
          },
        ],
      },
    },
  ];
  await memory.saveMessages({ messages });
  const page = await memory.recall({
    threadId: "thread-a",
    resourceId: "resource-a",
    page: 0,
    perPage: 10,
  });
  expect(page.messages.map((message) => message.id)).toEqual(["message-a"]);
  expect(page.messages[0]?.content.parts).toEqual(messages[0]?.content.parts);
});

test("parser preserves complete V2 content and legacy V1 tool results", () => {
  const v2Input = {
    id: "message-a",
    role: "assistant",
    type: "text",
    content: {
      format: 2,
      parts: [
        { type: "text", text: "answer" },
        {
          type: "tool-invocation",
          toolInvocation: {
            toolCallId: "call-a",
            toolName: "search",
            args: { query: "answer" },
            state: "result",
            result: { title: "source" },
          },
        },
        {
          type: "file",
          mimeType: "text/plain",
          data: "data:text/plain;base64,eA==",
        },
      ],
      experimental_attachments: [
        {
          name: "source.txt",
          contentType: "text/plain",
          url: "data:text/plain;base64,eA==",
        },
      ],
      toolInvocations: [{ toolCallId: "call-a", toolName: "search" }],
      reasoning: "searched the source",
      annotations: [{ source: "test" }],
      providerMetadata: { provider: { trace: "trace-a" } },
      metadata: { application: "value-a" },
    },
  };
  const v2 = parseMessageInput(v2Input);
  expect(v2.ok).toBe(true);
  if (!v2.ok) throw new Error("valid V2 message was rejected");
  expect(JSON.stringify(v2.value.content)).toBe(
    JSON.stringify(v2Input.content),
  );

  const v1Input = {
    id: "tool-message-a",
    role: "tool",
    type: "tool-result",
    content: [{ type: "text", text: "found one source" }],
    toolCallIds: ["call-a"],
    toolCallArgs: [{ query: "answer" }],
    toolNames: ["search"],
  };
  const v1 = parseMessageInput(v1Input);
  expect(v1.ok).toBe(true);
  if (!v1.ok) throw new Error("valid V1 tool result was rejected");
  expect(v1.value).toMatchObject(v1Input);

  const appendMessages: Parameters<IntelligenceService["append"]>[2] = [
    v2.value,
    v1.value,
  ];
  expect(appendMessages.map(({ id }) => String(id))).toEqual([
    "message-a",
    "tool-message-a",
  ]);
  expect(scope.tenantId).toBe("tenant-a");
});

test("parsed message content is immutable after detachment", () => {
  const v2Input = {
    id: "immutable-v2",
    role: "assistant",
    content: {
      format: 2,
      parts: [{ type: "text", text: "before", metadata: { value: "before" } }],
      metadata: { nested: { value: "before" } },
    },
  };
  const parsedV2 = parseMessageInput(v2Input);
  expect(parsedV2.ok).toBe(true);
  if (!parsedV2.ok) throw new Error("valid V2 message was rejected");

  const v1Input = {
    id: "immutable-v1",
    role: "assistant",
    type: "tool-call",
    content: "calling tool",
    toolCallIds: ["call-before"],
    toolNames: ["search"],
    toolCallArgs: [{ query: { value: "before" } }],
  };
  const parsedV1 = parseMessageInput(v1Input);
  expect(parsedV1.ok).toBe(true);
  if (!parsedV1.ok) throw new Error("valid V1 message was rejected");

  const beforeV2 = JSON.stringify(parsedV2.value.content);
  const beforeV1 = JSON.stringify(parsedV1.value);
  const v2Content = parsedV2.value.content as unknown as {
    parts: Array<{ metadata: { value: string } }>;
    metadata: { nested: { value: string } };
  };
  const v1Value = parsedV1.value as unknown as {
    toolCallIds: string[];
    toolCallArgs: Array<{ query: { value: string } }>;
  };
  expect(Object.isFrozen(parsedV2.value)).toBe(true);
  expect(Object.isFrozen(parsedV2.value.content)).toBe(true);
  expect(Object.isFrozen(v2Content.parts)).toBe(true);
  expect(Object.isFrozen(v2Content.parts[0])).toBe(true);
  expect(Object.isFrozen(v2Content.parts[0]?.metadata)).toBe(true);
  expect(Object.isFrozen(v2Content.metadata.nested)).toBe(true);
  expect(Object.isFrozen(parsedV1.value)).toBe(true);
  expect(Object.isFrozen(v1Value.toolCallIds)).toBe(true);
  expect(Object.isFrozen(v1Value.toolCallArgs[0]?.query)).toBe(true);

  Reflect.set(v2Content.parts[0]?.metadata ?? {}, "value", "after");
  Reflect.set(v2Content.metadata.nested, "value", "after");
  Reflect.set(v1Value.toolCallIds, "0", "call-after");
  Reflect.set(v1Value.toolCallArgs[0]?.query ?? {}, "value", "after");
  v1Input.toolCallIds[0] = "caller-mutated";
  v1Input.toolCallArgs[0]!.query.value = "caller-mutated";

  expect(JSON.stringify(parsedV2.value.content)).toBe(beforeV2);
  expect(JSON.stringify(parsedV1.value)).toBe(beforeV1);
});

test("malformed Mastra V2 parts are rejected", () => {
  const invalidParts: unknown[][] = [
    [null],
    ["text"],
    [{ text: "missing type" }],
    [{ type: "unknown-part", text: "unknown" }],
    [{ type: "text" }],
    [{ type: "file", mimeType: "text/plain" }],
    [{ type: "tool-invocation", toolInvocation: { state: "call" } }],
    [
      {
        type: "source-url",
        sourceId: "source-a",
        url: "https://example.invalid",
      },
    ],
  ];

  for (const parts of invalidParts) {
    expect(
      parseMessageInput({
        id: "malformed-v2",
        role: "user",
        content: { format: 2, parts },
      }),
    ).toEqual({
      ok: false,
      error: intelligenceFailure("invalid-input"),
    });
  }

  expect(
    parseMessageInput({
      id: "valid-source-v2",
      role: "assistant",
      content: {
        format: 2,
        parts: [
          {
            type: "source",
            source: {
              sourceType: "url",
              id: "source-a",
              url: "https://example.invalid",
            },
          },
        ],
      },
    }).ok,
  ).toBe(true);
});

test("parser detaches legal V1 binary and URL attachments across Mastra conversions", () => {
  const original = Uint8Array.from([1, 2, 3, 254]);
  const sliced = Buffer.from([9, 1, 2, 3, 254, 8]).subarray(1, 5);
  const arrayBuffer = Uint8Array.from([1, 2, 3, 254]).buffer;
  const mutableUrl = new URL("https://example.com/original");
  const inputs: Array<[string, unknown, "image" | "file"]> = [
    ["uint8array", original, "image"],
    ["buffer", sliced, "file"],
    ["arraybuffer", arrayBuffer, "image"],
    ["url", mutableUrl, "file"],
  ];

  for (const [name, data, kind] of inputs) {
    const parsed = parseMessageInput({
      id: `attachment-${name}`,
      role: "user",
      type: "text",
      content: [
        kind === "image"
          ? { type: "image", image: data }
          : { type: "file", data, mimeType: "image/png" },
      ],
    });
    expect(parsed.ok, name).toBe(true);
    if (!parsed.ok) continue;

    if (name === "url") mutableUrl.pathname = "/mutated";
    else if (name === "uint8array") original[0] = 99;
    else if (name === "buffer") sliced[0] = 99;
    else new Uint8Array(arrayBuffer)[0] = 99;

    const part = parsed.value.content as Array<{
      image?: unknown;
      data?: unknown;
    }>;
    const canonicalData = kind === "image" ? part[0]?.image : part[0]?.data;
    expect(canonicalData).toBe(
      name === "url" ? "https://example.com/original" : "AQID/g==",
    );

    const v2 = convertMessages([
      parsed.value as unknown as import("@mastra/core/memory").MastraMessageV1,
    ]).to("Mastra.V2");
    const core = convertMessages(v2).to("AIV4.Core");
    const firstCoreMessage = core[0];
    if (!firstCoreMessage) throw new Error("Mastra Core conversion was empty");
    const corePart = (
      firstCoreMessage.content as Array<{ type?: string; image?: unknown }>
    ).find((part) => part.type === "image");
    const bytes = corePart?.image;
    if (name === "url") {
      expect(bytes).toBeInstanceOf(URL);
      expect((bytes as URL).href).toBe("https://example.com/original");
    } else {
      expect(bytes instanceof Uint8Array ? [...bytes] : bytes).toEqual([
        1, 2, 3, 254,
      ]);
    }
  }
});

test("parser ignores shadowing typed-array and URL accessors", () => {
  const bytes = Buffer.from([9, 1, 2, 3, 254, 8]).subarray(1, 5);
  const byteGetterReads = { buffer: 0, byteOffset: 0, byteLength: 0 };
  for (const key of ["buffer", "byteOffset", "byteLength"] as const) {
    Object.defineProperty(bytes, key, {
      configurable: true,
      get() {
        byteGetterReads[key] += 1;
        throw new Error(`must not invoke own ${key} getter`);
      },
    });
  }

  const url = new URL("https://example.com/intrinsic");
  let hrefGetterReads = 0;
  Object.defineProperty(url, "href", {
    configurable: true,
    get() {
      hrefGetterReads += 1;
      throw new Error("must not invoke own href getter");
    },
  });

  const parsedBytes = parseMessageInput({
    id: "shadowed-bytes",
    role: "user",
    type: "text",
    content: [{ type: "file", mimeType: "application/pdf", data: bytes }],
  });
  const parsedUrl = parseMessageInput({
    id: "shadowed-url",
    role: "user",
    type: "text",
    content: [{ type: "file", mimeType: "application/pdf", data: url }],
  });
  expect(parsedBytes.ok).toBe(true);
  expect(parsedUrl.ok).toBe(true);
  if (!parsedBytes.ok || !parsedUrl.ok) return;
  expect(byteGetterReads).toEqual({ buffer: 0, byteOffset: 0, byteLength: 0 });
  expect(hrefGetterReads).toBe(0);
  expect((parsedBytes.value.content as Array<{ data: string }>)[0]?.data).toBe(
    "AQID/g==",
  );
  expect((parsedUrl.value.content as Array<{ data: string }>)[0]?.data).toBe(
    "https://example.com/intrinsic",
  );
});

test("Mastra adapter preserves application/pdf binary and URL files", () => {
  const inputs = [
    {
      name: "binary",
      data: Uint8Array.from([1, 2, 3, 254]),
      expected: "AQID/g==",
    },
    {
      name: "URL",
      data: new URL("https://example.com/document.pdf"),
      expected: "https://example.com/document.pdf",
    },
  ] as const;

  for (const { name, data, expected } of inputs) {
    const parsed = parseMessageInput({
      id: `pdf-${name}`,
      role: "user",
      type: "text",
      content: [{ type: "file", mimeType: "application/pdf", data }],
    });
    expect(parsed.ok, name).toBe(true);
    if (!parsed.ok) continue;

    const v2 = convertMessages([
      parsed.value as unknown as import("@mastra/core/memory").MastraMessageV1,
    ]).to("Mastra.V2");
    const core = convertMessages(v2).to("AIV4.Core");
    const firstCoreMessage = core[0];
    if (!firstCoreMessage) throw new Error("Mastra Core conversion was empty");
    const filePart = (
      firstCoreMessage.content as Array<{
        type?: string;
        data?: unknown;
        mimeType?: string;
      }>
    ).find((part) => part.type === "file");
    expect(filePart).toBeDefined();
    expect(filePart?.mimeType).toBe("application/pdf");
    const fileData = filePart?.data;
    expect(
      fileData instanceof URL
        ? fileData.href
        : fileData instanceof Uint8Array
          ? Buffer.from(fileData).toString("base64")
          : fileData,
    ).toBe(expected);
  }
});

test("parser rejects maximum sparse arrays promptly", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { parseMessageInput } from "./src/mastra/intelligence-contracts.ts";
const result = parseMessageInput({ id: "sparse", role: "user", type: "text", content: new Array(2 ** 32 - 1) });
console.log(JSON.stringify({ ok: result.ok, code: result.ok ? null : result.error.code }));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), 2_000);
  });
  const completed = child.exited.then(() => "completed" as const);
  const outcome = await Promise.race([completed, timeout]);
  if (outcome === "timeout") {
    timedOut = true;
    child.kill();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(timedOut, `child timed out; stderr: ${stderr}`).toBe(false);
  expect(child.exitCode, stderr).toBe(0);
  expect(stdout.trim()).toBe(
    JSON.stringify({ ok: false, code: "invalid-input" }),
  );
});

test("message parser rejects empty IDs and client-selected selectors", () => {
  for (const id of ["", "   "]) {
    const invalid = parseMessageInput({
      id,
      role: "user",
      content: { format: 2, parts: [{ type: "text", text: "hello" }] },
    });
    expect(invalid).toEqual({
      ok: false,
      error: intelligenceFailure("invalid-input"),
    });
  }

  for (const selector of ["tenantId", "threadId", "resourceId", "store"]) {
    const invalid = parseMessageInput({
      id: "message-a",
      role: "user",
      content: { format: 2, parts: [{ type: "text", text: "hello" }] },
      [selector]: "client-choice",
    });
    expect(invalid).toEqual({
      ok: false,
      error: intelligenceFailure("invalid-input"),
    });
  }
});

test("message parser snapshots hostile own properties and detaches JSON content", () => {
  const invalidInput = (value: unknown) => {
    try {
      return parseMessageInput(value);
    } catch (error) {
      return error;
    }
  };
  const expectInvalid = (value: unknown) => {
    expect(invalidInput(value)).toEqual({
      ok: false,
      error: intelligenceFailure("invalid-input"),
    });
  };

  const throwingGetter = {
    role: "user",
    content: { format: 2, parts: [] },
  };
  Object.defineProperty(throwingGetter, "id", {
    enumerable: true,
    get() {
      throw new Error("getter escaped");
    },
  });
  expectInvalid(throwingGetter);

  const proxyTarget = {
    id: "message-a",
    role: "user",
    content: { format: 2, parts: [] },
  };
  for (const hostile of [
    new Proxy(proxyTarget, {
      ownKeys() {
        throw new Error("ownKeys");
      },
    }),
    new Proxy(proxyTarget, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor");
      },
    }),
  ])
    expectInvalid(hostile);
  const disagreeing = new Proxy(proxyTarget, {
    get(target, key, receiver) {
      if (key === "id") return "message-b";
      return Reflect.get(target, key, receiver);
    },
  });
  const captured = parseMessageInput(disagreeing);
  expect(captured.ok && String(captured.value.id)).toBe("message-a");

  const nested = { text: "before" };
  const parsed = parseMessageInput({
    id: "message-a",
    role: "user",
    content: {
      format: 2,
      parts: [{ type: "text", text: "hello", metadata: nested }],
    },
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("valid nested payload was rejected");
  nested.text = "after";
  expect(JSON.stringify(parsed.value.content)).toContain('"text":"before"');

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expectInvalid({
    id: "message-a",
    role: "user",
    content: { format: 2, parts: [], metadata: cycle },
  });
  expectInvalid({
    id: "message-a",
    role: "user",
    content: { format: 2, parts: [], metadata: { value: undefined } },
  });
  expectInvalid({
    id: "message-a",
    role: "user",
    content: { format: 2, parts: [], [Symbol("extra")]: true },
  });
  expectInvalid({
    id: "message-a",
    role: "user",
    content: "result",
    type: "tool-result",
    toolCallIds: "call-a",
  });
  expectInvalid({
    id: "message-a",
    role: "user",
    content: "result",
    type: "tool-result",
    toolNames: [1],
  });
  expectInvalid({
    id: "message-a",
    role: "user",
    content: "result",
    type: "tool-result",
    toolCallArgs: [() => null],
  });
  expectInvalid({
    id: "message-a",
    role: "user",
    content: "result",
    type: "tool-result",
    toolCallArgs: [1],
  });
});

test("public failures use fixed messages and carry retry classification", () => {
  const sensitiveDetail = "postgres://tenant-secret:password@example.invalid";
  const failure = Reflect.apply(intelligenceFailure, undefined, [
    "unavailable",
    sensitiveDetail,
  ]);
  expect(failure).toMatchObject({
    code: "unavailable",
    retryable: true,
    message: "The conversation service is temporarily unavailable.",
  });
  expect(failure.message).not.toContain(sensitiveDetail);
});

const invalidFailureCodes: readonly [string, unknown][] = [
  ["unknown string", "unexpected-code"],
  ["prototype name __proto__", "__proto__"],
  ["prototype name toString", "toString"],
  ["object", { credential: "object-secret" }],
  ["function", () => "function-secret"],
  ["credential-bearing string", "postgres://user:password@db.invalid"],
];

for (const [label, code] of invalidFailureCodes) {
  test(`failure factory normalizes invalid runtime code: ${label}`, () => {
    const failure = intelligenceFailure(code as IntelligenceFailureCode);
    const normalized = normalizeIntelligenceError(failure);
    expect(failure.code).toBe("unavailable");
    expect(typeof failure.message).toBe("string");
    expect(failure.message).toBe(
      "The conversation service is temporarily unavailable.",
    );
    expect(normalized).toBe(failure);
    expect(failure.message).not.toContain("password");
  });
}

test("untrusted error values normalize to the generic safe failure", () => {
  const secret = "postgres://tenant-secret:password@example.invalid";
  const unsafe = {
    code: "unavailable",
    retryable: true,
    message: secret,
  };
  const unsafeConflict = {
    code: "conflict",
    kind: "duplicate-message-id",
    messageId: "caller-forged-id",
    retryable: false,
    message: secret,
  };
  const castFailure = (fabricatedResult as { readonly error: unknown }).error;
  for (const candidate of [
    unsafe,
    unsafeConflict,
    new Error(secret),
    castFailure,
  ]) {
    const normalized = normalizeIntelligenceError(candidate);
    expect(normalized).toMatchObject({
      code: "unavailable",
      retryable: true,
      message: "The conversation service is temporarily unavailable.",
    });
    expect(normalized.message).not.toContain(secret);
  }

  const genuine = intelligenceFailure("unauthorized");
  expect(normalizeIntelligenceError(genuine)).toBe(genuine);
});

test("append contract represents same ID with different content as conflict", () => {
  const first = parseMessageInput({
    id: "stable-message-id",
    role: "assistant",
    content: { format: 2, parts: [{ type: "text", text: "first body" }] },
  });
  const retry = parseMessageInput({
    id: "stable-message-id",
    role: "assistant",
    content: { format: 2, parts: [{ type: "text", text: "changed body" }] },
  });
  expect(first.ok).toBe(true);
  expect(retry.ok).toBe(true);
  if (!first.ok || !retry.ok) throw new Error("valid messages were rejected");
  expect(first.value.id).toBe(retry.value.id);
  expect(first.value.content).not.toEqual(retry.value.content);

  const conflict: AppendConflict = appendConflict(first.value.id);
  expect(normalizeIntelligenceError(conflict)).toBe(conflict);
  const sameIdDifferentContent: Awaited<
    ReturnType<IntelligenceService["append"]>
  > = {
    ok: false,
    error: conflict,
  };
  expect(sameIdDifferentContent).toMatchObject({
    ok: false,
    error: {
      code: "conflict",
      kind: "duplicate-message-id",
      messageId: "stable-message-id",
      retryable: false,
    },
  });
});

void forgedBinding;
void emptyMessage;
void fabricatedFailure;
void fabricatedResult;
