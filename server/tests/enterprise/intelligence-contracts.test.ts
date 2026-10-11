import { expect, test } from "bun:test";
import type { MastraDBMessage } from "@mastra/core/agent";
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
