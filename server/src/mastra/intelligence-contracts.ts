import { createHmac, timingSafeEqual } from "node:crypto";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { MastraMessageV1 } from "@mastra/core/memory";
import type { PlatformScope } from "../enterprise/contracts";

const bindingBrand: unique symbol = Symbol("AuthorizedConversationBinding");
const attestationBrand: unique symbol = Symbol("BindingAttestation");
const stableMessageIdBrand: unique symbol = Symbol("StableMessageId");
const intelligenceErrorBrand: unique symbol = Symbol("IntelligenceError");
const createdIntelligenceErrors = new WeakSet<object>();
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "buffer",
)?.get as (this: Uint8Array) => ArrayBuffer;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)?.get as (this: Uint8Array) => number;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)?.get as (this: Uint8Array) => number;
const urlHrefGetter = Object.getOwnPropertyDescriptor(URL.prototype, "href")
  ?.get as (this: URL) => string;
if (
  !typedArrayBufferGetter ||
  !typedArrayByteOffsetGetter ||
  !typedArrayByteLengthGetter ||
  !urlHrefGetter
) {
  throw new Error("Required intrinsic content accessors are unavailable.");
}

export type BindingAttestation = string & {
  readonly [attestationBrand]: true;
};

export type StableMessageId = string & {
  readonly [stableMessageIdBrand]: true;
};

/** Server-minted and signed identity; the private brand prevents structural forgery. */
export interface AuthorizedConversationBinding {
  readonly [bindingBrand]: true;
  readonly attestation: BindingAttestation;
  readonly conversationId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly memberEpoch: number;
  readonly aclEpoch: number;
  readonly threadId: string;
  readonly resourceId: string;
  readonly authorizationEpoch: number;
}

export interface AuthorizedConversationBindingInput {
  readonly conversationId: string;
  readonly threadId: string;
  readonly resourceId: string;
  readonly authorizationEpoch: number;
}

export interface AuthorizedConversationBindingAuthority {
  mint(
    scope: PlatformScope,
    input: AuthorizedConversationBindingInput,
  ): AuthorizedConversationBinding;
  verify(
    scope: PlatformScope,
    conversationId: string,
    value: unknown,
  ): AuthorizedConversationBinding | undefined;
}

const bindingSerializedKeys = [
  "attestation",
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

type BindingPayload = Omit<
  AuthorizedConversationBinding,
  typeof bindingBrand | "attestation"
>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function bindingPayloadFromScope(
  scope: PlatformScope,
  input: AuthorizedConversationBindingInput,
): BindingPayload {
  if (
    !isNonEmptyString(scope.tenantId) ||
    !isNonEmptyString(scope.workspaceId) ||
    !isNonEmptyString(scope.principalId) ||
    !isEpoch(scope.memberEpoch) ||
    !isEpoch(scope.aclEpoch) ||
    !isNonEmptyString(input.conversationId) ||
    !isNonEmptyString(input.threadId) ||
    !isNonEmptyString(input.resourceId) ||
    !isEpoch(input.authorizationEpoch)
  ) {
    throw new TypeError("Invalid authorized conversation binding input.");
  }
  return {
    conversationId: input.conversationId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    principalId: scope.principalId,
    memberEpoch: scope.memberEpoch,
    aclEpoch: scope.aclEpoch,
    threadId: input.threadId,
    resourceId: input.resourceId,
    authorizationEpoch: input.authorizationEpoch,
  };
}

function canonicalBinding(payload: BindingPayload): string {
  return JSON.stringify([
    "openbot.authorized-conversation-binding",
    1,
    payload.conversationId,
    payload.tenantId,
    payload.workspaceId,
    payload.principalId,
    payload.memberEpoch,
    payload.aclEpoch,
    payload.threadId,
    payload.resourceId,
    payload.authorizationEpoch,
  ]);
}

function constructBinding(
  payload: BindingPayload,
  signature: Uint8Array,
): AuthorizedConversationBinding {
  const result = {
    ...payload,
    attestation: Buffer.from(signature).toString(
      "base64url",
    ) as BindingAttestation,
  };
  Object.defineProperty(result, bindingBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(result) as AuthorizedConversationBinding;
}

function readSerializedBinding(value: unknown):
  | {
      readonly payload: BindingPayload;
      readonly attestation: string;
    }
  | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const properties = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(properties);
    const keys = ownKeys.filter(
      (key): key is string => typeof key === "string",
    );
    if (
      keys.length !== bindingSerializedKeys.length ||
      ownKeys.some(
        (key) =>
          key !== bindingBrand &&
          (typeof key !== "string" ||
            !bindingSerializedKeys.includes(
              key as (typeof bindingSerializedKeys)[number],
            )),
      ) ||
      bindingSerializedKeys.some((key) => !Object.hasOwn(properties, key))
    ) {
      return undefined;
    }
    const symbols = ownKeys.filter(
      (key): key is symbol => typeof key === "symbol",
    );
    if (symbols.some((symbol) => symbol !== bindingBrand)) return undefined;
    const brandDescriptor = (
      properties as Record<PropertyKey, PropertyDescriptor>
    )[bindingBrand];
    if (
      brandDescriptor &&
      (!("value" in brandDescriptor) ||
        brandDescriptor.value !== true ||
        brandDescriptor.enumerable !== false)
    ) {
      return undefined;
    }
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of bindingSerializedKeys) {
      const descriptor = properties[key];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return undefined;
      }
      captured[key] = descriptor.value;
    }
    if (
      !isNonEmptyString(captured.attestation) ||
      !isNonEmptyString(captured.conversationId) ||
      !isNonEmptyString(captured.tenantId) ||
      !isNonEmptyString(captured.workspaceId) ||
      !isNonEmptyString(captured.principalId) ||
      !isEpoch(captured.memberEpoch) ||
      !isEpoch(captured.aclEpoch) ||
      !isNonEmptyString(captured.threadId) ||
      !isNonEmptyString(captured.resourceId) ||
      !isEpoch(captured.authorizationEpoch)
    ) {
      return undefined;
    }
    return {
      payload: Object.freeze({
        conversationId: captured.conversationId,
        tenantId: captured.tenantId,
        workspaceId: captured.workspaceId,
        principalId: captured.principalId,
        memberEpoch: captured.memberEpoch,
        aclEpoch: captured.aclEpoch,
        threadId: captured.threadId,
        resourceId: captured.resourceId,
        authorizationEpoch: captured.authorizationEpoch,
      }) as BindingPayload,
      attestation: captured.attestation,
    };
  } catch {
    return undefined;
  }
}

/** Creates a closure-backed authority for signed, scope-bound conversation identities. */
export function createAuthorizedConversationBindingAuthority(
  secret: string,
): AuthorizedConversationBindingAuthority {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError(
      "Authorized conversation binding secret must be at least 32 UTF-8 bytes.",
    );
  }
  const key = Buffer.from(secret, "utf8");
  const sign = (payload: BindingPayload) =>
    createHmac("sha256", key)
      .update(canonicalBinding(payload), "utf8")
      .digest();
  return Object.freeze({
    mint(scope: PlatformScope, input: AuthorizedConversationBindingInput) {
      const payload = bindingPayloadFromScope(scope, input);
      return constructBinding(payload, sign(payload));
    },
    verify(scope: PlatformScope, conversationId: string, value: unknown) {
      try {
        const serialized = readSerializedBinding(value);
        if (!serialized) return undefined;
        const expected = bindingPayloadFromScope(scope, {
          conversationId,
          threadId: serialized.payload.threadId,
          resourceId: serialized.payload.resourceId,
          authorizationEpoch: serialized.payload.authorizationEpoch,
        });
        if (
          canonicalBinding(expected) !== canonicalBinding(serialized.payload)
        ) {
          return undefined;
        }
        if (!/^[A-Za-z0-9_-]+$/.test(serialized.attestation)) return undefined;
        const supplied = Buffer.from(serialized.attestation, "base64url");
        if (
          supplied.length !== 32 ||
          supplied.toString("base64url") !== serialized.attestation
        ) {
          return undefined;
        }
        const computed = sign(serialized.payload);
        if (
          computed.length !== supplied.length ||
          !timingSafeEqual(computed, supplied)
        ) {
          return undefined;
        }
        return constructBinding(serialized.payload, computed);
      } catch {
        return undefined;
      }
    },
  });
}

type MastraV2Input = Omit<
  MastraDBMessage,
  "createdAt" | "threadId" | "resourceId" | "id"
> & { readonly id: StableMessageId };

type MastraV1Input = Omit<
  MastraMessageV1,
  "createdAt" | "threadId" | "resourceId" | "id"
> & { readonly id: StableMessageId };

/** Lossless caller message shapes supported by the pinned Mastra V1 and V2 APIs. */
export type MessageInput = MastraV2Input | MastraV1Input;

export type StoredMessage = MessageInput & { readonly createdAt: Date };

export interface HistoryPage {
  readonly messages: readonly StoredMessage[];
  readonly nextCursor: string | null;
}

export type AppendReceipt =
  | {
      readonly status: "persisted";
      readonly messageIds: readonly StableMessageId[];
      readonly payloadDigest: string;
    }
  | {
      readonly status: "pending";
      readonly messageIds: readonly StableMessageId[];
      readonly retryAfter: Date | null;
    };

export interface MemoryQuery {
  readonly text: string;
  readonly limit: number;
}

export interface MemorySourceIdentity {
  readonly sourceId: string;
  readonly sourceVersion: string;
}

export interface AuthorizedMemoryContext {
  readonly text: string;
  readonly sources: readonly MemorySourceIdentity[];
}

export interface PersistedSourceReceipt {
  readonly messageIds: readonly StableMessageId[];
  readonly payloadDigest: string;
}

export interface LearningJobReceipt {
  readonly jobId: string;
  readonly sourceDigest: string;
  readonly status: "queued" | "existing";
}

export type IntelligenceFailureCode =
  | "unauthorized"
  | "not-found"
  | "unavailable"
  | "invalid-input";

export interface IntelligenceFailure {
  readonly [intelligenceErrorBrand]: true;
  readonly code: IntelligenceFailureCode;
  readonly retryable: boolean;
  readonly message: string;
}

/** Same stable message ID with a different body is a non-retryable append conflict. */
export interface AppendConflict {
  readonly [intelligenceErrorBrand]: true;
  readonly code: "conflict";
  readonly kind: "duplicate-message-id";
  readonly messageId: StableMessageId;
  readonly retryable: false;
  readonly message: string;
}

export type IntelligenceError = IntelligenceFailure | AppendConflict;

export type IntelligenceResult<
  T,
  E extends IntelligenceError = IntelligenceFailure,
> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const safeFailureMessages: Record<IntelligenceFailureCode, string> = {
  unauthorized: "This conversation is not available to you.",
  "not-found": "The requested conversation was not found.",
  unavailable: "The conversation service is temporarily unavailable.",
  "invalid-input": "The conversation request is invalid.",
};

/** Creates a public failure using a fixed message; internal error text is never accepted. */
export function intelligenceFailure(
  code: IntelligenceFailureCode,
): IntelligenceFailure {
  const safeCode = isIntelligenceFailureCode(code) ? code : "unavailable";
  return registerIntelligenceError({
    code: safeCode,
    retryable: safeCode === "unavailable",
    message: safeFailureMessages[safeCode],
  });
}

function isIntelligenceFailureCode(
  value: unknown,
): value is IntelligenceFailureCode {
  switch (value) {
    case "unauthorized":
    case "not-found":
    case "unavailable":
    case "invalid-input":
      return true;
    default:
      return false;
  }
}

export function appendConflict(messageId: StableMessageId): AppendConflict {
  return registerIntelligenceError({
    code: "conflict",
    kind: "duplicate-message-id",
    messageId,
    retryable: false,
    message: "A message ID is already stored with different content.",
  });
}

function registerIntelligenceError(
  error: Omit<IntelligenceFailure, typeof intelligenceErrorBrand>,
): IntelligenceFailure;
function registerIntelligenceError(
  error: Omit<AppendConflict, typeof intelligenceErrorBrand>,
): AppendConflict;
function registerIntelligenceError(error: object): IntelligenceError {
  Object.defineProperty(error, intelligenceErrorBrand, {
    value: true,
    enumerable: false,
  });
  Object.freeze(error);
  createdIntelligenceErrors.add(error);
  return error as IntelligenceError;
}

/** Preserve genuine failures and collapse all untrusted values to a safe fallback. */
export function normalizeIntelligenceError(value: unknown): IntelligenceError {
  if (
    value !== null &&
    typeof value === "object" &&
    createdIntelligenceErrors.has(value)
  ) {
    return value as IntelligenceError;
  }
  return intelligenceFailure("unavailable");
}

const forbiddenSelectors = new Set([
  "actorId",
  "connectionString",
  "principalId",
  "resourceId",
  "storage",
  "store",
  "tenantId",
  "threadId",
  "workspaceId",
]);

const allowedMessageKeys = new Set([
  "content",
  "id",
  "role",
  "toolCallArgs",
  "toolCallIds",
  "toolNames",
  "type",
]);

/** Validate and brand an untrusted boundary message without dropping V1/V2 fields. */
export function parseMessageInput(
  value: unknown,
): IntelligenceResult<MessageInput> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }

    // Reflect once and retain only descriptor values; never read the untrusted object again.
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some((key) => !allowedMessageKeys.has(key as string)) ||
      keys.some((key) => forbiddenSelectors.has(key as string))
    ) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }
    const candidate: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return { ok: false, error: intelligenceFailure("invalid-input") };
      }
      candidate[key] = clonePersistenceValue(descriptor.value, new WeakSet());
    }

    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }
    const content = candidate.content;
    const isV2 =
      content !== null &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).format === 2 &&
      Array.isArray((content as Record<string, unknown>).parts) &&
      ["user", "assistant", "system", "signal"].includes(
        candidate.role as string,
      );
    const isV1 =
      (typeof content === "string" || Array.isArray(content)) &&
      ["system", "user", "assistant", "tool", "signal"].includes(
        candidate.role as string,
      ) &&
      ["text", "tool-call", "tool-result"].includes(candidate.type as string);
    if (!isV1 && !isV2) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }
    if (isV2 && !validV2Parts(content as Record<string, unknown>)) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }
    if (isV1 && !validV1Helpers(candidate)) {
      return { ok: false, error: intelligenceFailure("invalid-input") };
    }

    for (const key of Object.keys(candidate)) {
      deepFreezePersistenceValue(candidate[key]);
    }

    return {
      ok: true,
      value: Object.freeze({
        ...candidate,
        id: candidate.id as StableMessageId,
      }) as MessageInput,
    };
  } catch {
    return { ok: false, error: intelligenceFailure("invalid-input") };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasStringFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => typeof value[field] === "string");
}

function validV2Parts(content: Record<string, unknown>): boolean {
  const parts = content.parts;
  return Array.isArray(parts) && parts.every(validV2Part);
}

function validV2Part(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "reasoning":
      return (
        typeof value.reasoning === "string" &&
        Array.isArray(value.details) &&
        value.details.every(
          (detail) =>
            isRecord(detail) &&
            ((detail.type === "text" && typeof detail.text === "string") ||
              (detail.type === "redacted" && typeof detail.data === "string")),
        )
      );
    case "tool-invocation": {
      const invocation = value.toolInvocation;
      return (
        isRecord(invocation) &&
        hasStringFields(invocation, ["toolCallId", "toolName", "state"]) &&
        Object.hasOwn(invocation, "args") &&
        [
          "partial-call",
          "call",
          "result",
          "approval-requested",
          "approval-responded",
          "output-error",
          "output-denied",
        ].includes(invocation.state as string)
      );
    }
    case "source": {
      const source = value.source;
      return (
        isRecord(source) &&
        source.sourceType === "url" &&
        hasStringFields(source, ["id", "url"])
      );
    }
    case "source-document":
      return hasStringFields(value, ["sourceId", "mediaType", "title"]);
    case "file":
      return hasStringFields(value, ["mimeType", "data"]);
    case "step-start":
      return true;
    default:
      return value.type.startsWith("data-") && Object.hasOwn(value, "data");
  }
}

function deepFreezePersistenceValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    deepFreezePersistenceValue((value as Record<string, unknown>)[key]);
  }
  Object.freeze(value);
}

function clonePersistenceValue(
  value: unknown,
  ancestors: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object")
    throw new TypeError("Unsupported persisted value");
  if (ancestors.has(value)) throw new TypeError("Cyclic persisted value");
  ancestors.add(value);
  try {
    if (value instanceof Uint8Array) {
      const buffer = Reflect.apply(
        typedArrayBufferGetter,
        value,
        [],
      ) as ArrayBuffer;
      const byteOffset = Reflect.apply(
        typedArrayByteOffsetGetter,
        value,
        [],
      ) as number;
      const byteLength = Reflect.apply(
        typedArrayByteLengthGetter,
        value,
        [],
      ) as number;
      return Buffer.from(buffer, byteOffset, byteLength).toString("base64");
    }
    if (value instanceof ArrayBuffer) {
      return Buffer.from(value).toString("base64");
    }
    if (value instanceof URL)
      return Reflect.apply(urlHrefGetter, value, []) as string;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Symbol key in persisted value");
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        !lengthDescriptor ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw new TypeError("Invalid JSON array length");
      }
      const length = lengthDescriptor.value as number;
      if (keys.length !== length + 1 || !keys.includes("length")) {
        throw new TypeError("Non-JSON array shape");
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^(0|[1-9]\d*)$/.test(key) ||
          Number(key) >= length
        ) {
          throw new TypeError("Non-JSON array shape");
        }
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Non-data array element");
        }
        result.push(clonePersistenceValue(descriptor.value, ancestors));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Non-JSON object prototype");
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Non-data object property");
      }
      result[key] = clonePersistenceValue(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function validV1Helpers(candidate: Record<string, unknown>): boolean {
  for (const key of ["toolCallIds", "toolNames"] as const) {
    const value = candidate[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    ) {
      return false;
    }
  }
  const args = candidate.toolCallArgs;
  return (
    args === undefined ||
    (Array.isArray(args) &&
      args.every(
        (item) =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      ))
  );
}

/** Persistence, authorized memory, and learning submission only. */
export interface IntelligenceService {
  resolve(
    scope: PlatformScope,
    conversationId: string,
  ): Promise<IntelligenceResult<AuthorizedConversationBinding>>;
  history(
    scope: PlatformScope,
    conversationId: string,
    cursor: string | null,
    limit: number,
  ): Promise<IntelligenceResult<HistoryPage>>;
  append(
    scope: PlatformScope,
    conversationId: string,
    messages: readonly MessageInput[],
  ): Promise<
    IntelligenceResult<AppendReceipt, IntelligenceFailure | AppendConflict>
  >;
  context(
    scope: PlatformScope,
    conversationId: string,
    query: MemoryQuery,
  ): Promise<IntelligenceResult<AuthorizedMemoryContext>>;
  enqueueLearning(
    scope: PlatformScope,
    conversationId: string,
    sourceReceipt: PersistedSourceReceipt,
  ): Promise<IntelligenceResult<LearningJobReceipt>>;
}
