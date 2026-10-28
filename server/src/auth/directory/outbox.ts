/*
 * The transactional notification outbox and the mail-callback completion
 * receipt fence (T02.12 / #534, original task P04; design §5.2 step 5;
 * interfaces §3.1 notification table, §5.1).
 *
 * What this file owns, and nothing else:
 *
 * 1. In-transaction intent registration. `enqueueAuthMailIntent` registers
 *    one mail notification beside its command, in the command's own open
 *    transaction, through the T02.06 controlled write path
 *    (`auth_command_append_outbox` — the only INSERT the final model grants
 *    onto `auth_command_outbox`). The URL and the token are sealed into the
 *    stored payload with AES-256-GCM before the statement runs: the durable
 *    row never carries a readable secret. The intent's stable event
 *    idempotency key IS the row id, so a duplicate registration under a new
 *    command surfaces as a named refusal (the 23505 of the primary key),
 *    never as a second row.
 *
 * 2. The request-local callback ledger. Better Auth's notification callbacks
 *    (the fixed build's runInBackgroundOrAwait paths) swallow their errors,
 *    so a failed dispatch leaves the command "successful" on a dead or
 *    half-converted state. The ledger records, per request and per token:
 *    that a token was created, that its callback started, that it completed
 *    with exactly one outbox receipt, or that it failed with the original
 *    error preserved. `assertMailCallbackCompletion` is the pre-commit
 *    fence: every observed token must hold exactly one completed receipt
 *    and every completed receipt must exist as a durable row of this
 *    command — otherwise it refuses with the preserved original error as
 *    its cause and the executor's rollback takes the token and every
 *    half-written intent with it. A callback that arrives after its
 *    transaction settled (the deferred link-account closure's shape) is
 *    refused before any write or send.
 *
 * 3. The controlled sender. `createControlledMailSender` produces the
 *    sendVerificationEmail-shaped callback the factory wires into the fixed
 *    package (T04.04/P08): invoked inside the live command it translates
 *    the notification into an atomic intent + receipt pair and performs no
 *    external send; invoked late it refuses. Only delivery, after the
 *    commit, sends — the takeover condition the plan states for enabling
 *    the email verification configuration.
 *
 * 4. Post-commit delivery. `drainAuthMailOutbox` is the worker side: it
 *    reads committed pending/failed intents on its own connection — never
 *    the command transaction — and sends each under its stable event key so
 *    a provider can deduplicate a crash-replayed send. A send failure is
 *    reported and the row is left retryable; a notification never decides
 *    admission, so the committed command's facts stand whatever delivery
 *    does. Delivery completion is the guarded status UPDATE; delivered is
 *    terminal.
 *
 * Boundaries this file deliberately does not own: the executor's command
 * envelope and finalizer (T02.08) — begin/finalize are driven by the
 * executor over the same controlled functions; the hook-source
 * classification that refuses the un-wired link-account source before
 * commit (T01.04's registry in transaction-adapter.ts) — the config
 * counter-example stays in force until the factory wiring lands; and the
 * real provider delivery (T04.04/P08's AuthMailDelivery).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { sql as dsql } from "drizzle-orm";
import type {
  AuthMailIntent,
  DirectoryTx,
  EnqueueAuthMailIntent,
  OutboxIntentKind,
  OutboxReceipt,
} from "./contracts";

export const OUTBOX_INTENT_INPUT_REQUIRED = "OUTBOX_INTENT_INPUT_REQUIRED";
export const OUTBOX_INTENT_EVENT_KEY_INVALID =
  "OUTBOX_INTENT_EVENT_KEY_INVALID";
export const OUTBOX_PAYLOAD_SECRET_REQUIRED = "OUTBOX_PAYLOAD_SECRET_REQUIRED";
export const OUTBOX_NO_OPEN_COMMAND = "OUTBOX_NO_OPEN_COMMAND";
export const OUTBOX_COMMAND_FINALIZED = "OUTBOX_COMMAND_FINALIZED";
export const OUTBOX_EVENT_ALREADY_REGISTERED =
  "OUTBOX_EVENT_ALREADY_REGISTERED";
export const OUTBOX_CALLBACK_TX_CLOSED = "OUTBOX_CALLBACK_TX_CLOSED";
export const OUTBOX_CALLBACK_INCOMPLETE = "OUTBOX_CALLBACK_INCOMPLETE";
export const OUTBOX_DUPLICATE_TOKEN_RECEIPT = "OUTBOX_DUPLICATE_TOKEN_RECEIPT";
export const OUTBOX_RECEIPT_MISSING_INTENT_ROW =
  "OUTBOX_RECEIPT_MISSING_INTENT_ROW";
export const OUTBOX_FENCE_TX_MISMATCH = "OUTBOX_FENCE_TX_MISMATCH";
export const OUTBOX_SEALED_PAYLOAD_UNREADABLE =
  "OUTBOX_SEALED_PAYLOAD_UNREADABLE";

/**
 * An outbox refusal: the notification path asked for something the fence
 * must not give it, and nothing was sent. The code is the stable, auditable
 * reason; the message never echoes the payload secret, a token or a URL.
 */
export class OutboxRefusal extends Error {
  constructor(
    readonly code: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${detail}`, options);
    this.name = "OutboxRefusal";
  }
}

/** The AES-256-GCM envelope marker every sealed payload starts with. */
const SEALED_MARKER = "obx-aead1";
/** The scrypt salt label binding the payload key to this envelope version. */
const KEY_LABEL = "openbot-auth-outbox/aead1";
/**
 * The closed intent vocabulary this module may seal (contracts own the type):
 * `link-account.verify` is the pinned build's ONE verification-mail dispatch
 * (T02.12's takeover target — both the deferred link-account hook and the
 * signup/resend paths fire the same callback); `password.reset` is the reset
 * mail. Both converters arrive with T04.04.
 */
const INTENT_KINDS: readonly OutboxIntentKind[] = [
  "link-account.verify",
  "password.reset",
];
/** The longest event key stored as a row id; longer keys are refused, not truncated. */
const EVENT_KEY_MAX = 512;

/** One sealed intent, decrypted: everything the delivery worker may read. */
export type SealedMailIntent = Readonly<{
  v: 1;
  kind: OutboxIntentKind;
  commandId: string;
  eventKey: string;
  userId: string;
  to: string;
  subject: string;
  url: string;
  token: string;
  enqueuedAt: string;
}>;

/** Printable text only: a control character in a row id would ride a table, a log line and a header. */
function isPrintable(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OutboxRefusal(
      OUTBOX_INTENT_INPUT_REQUIRED,
      `a mail intent needs a non-empty ${field}; the registration is refused before any statement`,
    );
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps one failed append to the refusal vocabulary: the controlled
 * function's own guard markers and the primary-key violation carry the
 * decision; anything else is rethrown untouched so a real fault is never
 * renamed into an outbox idempotency story.
 */
function refusalOfAppend(error: unknown): unknown {
  /*
   * Drizzle wraps the driver error: the top-level message is "Failed
   * query: …" and the PostgresError (its own message, its SQLSTATE in
   * errno) sits in the cause chain — so both the guard marker and the
   * SQLSTATE are searched along the chain, never only the surface.
   */
  const markers: string[] = [];
  const states: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const message = messageOf(current);
    const marker = /\bAUTH_[A-Z0-9_]+\b/.exec(message)?.[0];
    if (marker) markers.push(marker);
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code))
        states.push(code);
    }
    current = (current as { cause?: unknown }).cause;
  }
  const guard = markers.some(
    (marker) =>
      marker === "AUTH_COMMAND_NOT_ACTIVE" || marker === "AUTH_COMMAND_UNKNOWN",
  )
    ? OUTBOX_NO_OPEN_COMMAND
    : markers.includes("AUTH_COMMAND_NOT_OPEN")
      ? OUTBOX_COMMAND_FINALIZED
      : undefined;
  if (guard) {
    return new OutboxRefusal(
      guard,
      `the append ran without an open command context (${markers.join(", ")}); a mail intent is registered only inside the executor's live command, never beside a closed or missing one`,
      { cause: error },
    );
  }
  const duplicate =
    states.includes("23505") ||
    /duplicate key value|unique constraint/i.test(messageOf(error));
  if (duplicate) {
    return new OutboxRefusal(
      OUTBOX_EVENT_ALREADY_REGISTERED,
      "the event key is already registered by a committed intent; a notification event keeps exactly one durable intent, and a replay is the caller's idempotency decision, never a second row",
      { cause: error },
    );
  }
  return error;
}

function sealPayload(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    SEALED_MARKER,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function openPayload(key: Buffer, sealed: string, aad: string): string | null {
  try {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== SEALED_MARKER) return null;
    const [marker, iv, ciphertext, tag] = parts;
    if (!marker || !iv || !ciphertext || !tag) return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A wrong key, a tampered ciphertext or a mismatched binding is a failed
    // open: null answers "unreadable", and the caller decides the refusal.
    return null;
  }
}

/** One token's fact in the request-local ledger. */
export interface MailCallbackFact {
  readonly token: string;
  readonly state: "observed" | "started" | "completed" | "failed";
  readonly receipts: readonly OutboxReceipt[];
  /** The callback's preserved original error, kept for the commit fence's cause. */
  readonly error?: unknown;
}

export interface MailCallbackFence {
  readonly commandId: string;
  readonly facts: readonly MailCallbackFact[];
  observeTokenCreated(token: string): void;
  callbackStarted(token: string): void;
  callbackCompleted(token: string, receipt: OutboxReceipt): void;
  callbackFailed(token: string, error: unknown): void;
  settledAs(): "committed" | "rolled-back" | undefined;
}

interface MutableFact {
  token: string;
  state: MailCallbackFact["state"];
  receipts: OutboxReceipt[];
  error?: unknown;
}

/**
 * The private half of one fence: its transaction handle and the settlement
 * transition. Kept in a module WeakMap rather than on the public object so
 * nothing outside this module can settle, reopen or rebind a fence.
 */
const fenceInternals = new WeakMap<
  MailCallbackFence,
  { tx: DirectoryTx; settle(outcome: "committed" | "rolled-back"): void }
>();

/**
 * The request-local callback ledger of one command: the token facts and
 * their receipts live in memory for this request only — never serialized,
 * never logged — while the durable half (the intent rows) lives in the
 * command's transaction. The fence is bound to the transaction handle it
 * was created with, so a closure captured by a deferred hook cannot serve a
 * different request's transaction.
 */
export function createMailCallbackFence(
  tx: DirectoryTx,
  commandId: string,
): MailCallbackFence {
  if (typeof commandId !== "string" || commandId.trim() === "") {
    throw new OutboxRefusal(
      OUTBOX_INTENT_INPUT_REQUIRED,
      "a callback fence is bound to one command id; an empty binding is refused",
    );
  }
  const facts = new Map<string, MutableFact>();
  let settled: "committed" | "rolled-back" | undefined;

  const guard = (): void => {
    if (settled !== undefined) {
      throw new OutboxRefusal(
        OUTBOX_CALLBACK_TX_CLOSED,
        `command ${commandId}'s transaction already settled (${settled}); a late callback may neither write nor send — the notification belongs to the outbox intent registered before the commit, and delivery to the post-commit worker`,
      );
    }
  };
  const factOf = (token: string): MutableFact => {
    let fact = facts.get(token);
    if (!fact) {
      fact = { token, state: "observed", receipts: [] };
      facts.set(token, fact);
    }
    return fact;
  };

  const fence: MailCallbackFence = {
    commandId,
    get facts(): MailCallbackFact[] {
      return [...facts.values()].map((fact) => ({
        token: fact.token,
        state: fact.state,
        receipts: [...fact.receipts],
        error: fact.error,
      }));
    },
    observeTokenCreated(token: string): void {
      guard();
      factOf(requireText(token, "token binding"));
    },
    callbackStarted(token: string): void {
      guard();
      factOf(requireText(token, "token binding")).state = "started";
    },
    callbackCompleted(token: string, receipt: OutboxReceipt): void {
      guard();
      requireText(token, "token binding");
      if (receipt.token !== token) {
        throw new OutboxRefusal(
          OUTBOX_INTENT_INPUT_REQUIRED,
          `a completed receipt for token ${token} carries a different binding (${receipt.token}); the pairing is the fence's accounting, never a caller's to forge`,
        );
      }
      const fact = factOf(token);
      fact.state = "completed";
      fact.receipts.push(receipt);
    },
    callbackFailed(token: string, error: unknown): void {
      guard();
      const fact = factOf(requireText(token, "token binding"));
      fact.state = "failed";
      fact.error = error;
    },
    settledAs: () => settled,
  };
  fenceInternals.set(fence, {
    tx,
    settle(outcome) {
      settled = outcome;
    },
  });
  return fence;
}

/**
 * Marks the fence's transaction settled. The executor calls this once the
 * transaction actually committed or rolled back — never inside it — and
 * every later callback, observation or receipt on this fence is refused
 * before any write or send: the request-local capability dies with its
 * transaction.
 */
export function settleMailCallbackFence(
  fence: MailCallbackFence,
  outcome: "committed" | "rolled-back",
): void {
  const internals = fenceInternals.get(fence);
  if (!internals) {
    throw new OutboxRefusal(
      OUTBOX_INTENT_INPUT_REQUIRED,
      "the fence carries no internals; only a fence this module created can be settled",
    );
  }
  if (fence.settledAs() !== undefined) {
    throw new OutboxRefusal(
      OUTBOX_CALLBACK_TX_CLOSED,
      `command ${fence.commandId}'s fence already settled (${fence.settledAs()}); settling twice would reopen the late-callback window the fence exists to close`,
    );
  }
  internals.settle(outcome);
}

/**
 * The pre-commit completion fence (interfaces §5.1): every token this
 * command created holds exactly one completed outbox receipt, every
 * completed receipt exists as a durable intent row of this command, and no
 * callback is left started or failed. A violation throws with the
 * callback's preserved original error as the cause — the executor rolls
 * back, so a swallowed dispatch error can never leave a token committed
 * without its intent.
 */
export async function assertMailCallbackCompletion(
  tx: DirectoryTx,
  fence: MailCallbackFence,
): Promise<void> {
  const internals = fenceInternals.get(fence);
  if (!internals) {
    throw new OutboxRefusal(
      OUTBOX_INTENT_INPUT_REQUIRED,
      "the fence carries no internals; only a fence this module created can be reconciled",
    );
  }
  if (internals.tx !== tx) {
    throw new OutboxRefusal(
      OUTBOX_FENCE_TX_MISMATCH,
      `the fence of command ${fence.commandId} is bound to a different transaction handle; a request-local ledger never reconciles another transaction's tokens`,
    );
  }
  for (const fact of fence.facts) {
    if (fact.state !== "completed" || fact.receipts.length === 0) {
      throw new OutboxRefusal(
        OUTBOX_CALLBACK_INCOMPLETE,
        `token ${fact.token} of command ${fence.commandId} is ${fact.state} with ${fact.receipts.length} receipt(s); refusing the commit so the rollback takes the token and every half-written intent with it`,
        { cause: fact.state === "failed" ? fact.error : undefined },
      );
    }
    if (fact.receipts.length > 1) {
      throw new OutboxRefusal(
        OUTBOX_DUPLICATE_TOKEN_RECEIPT,
        `token ${fact.token} of command ${fence.commandId} completed ${fact.receipts.length} receipts; one token earns exactly one intent, and a second dispatch is a new event with its own key`,
      );
    }
  }
  if (fence.facts.length === 0) return;
  const result = await tx.execute(
    dsql`SELECT id FROM auth_command_outbox WHERE command_id = ${fence.commandId}`,
  );
  const rows = Array.isArray(result)
    ? (result as { id: unknown }[])
    : ((result as { rows?: { id: unknown }[] }).rows ?? []);
  const durable = new Set(rows.map((row) => String(row.id)));
  for (const fact of fence.facts) {
    for (const receipt of fact.receipts) {
      if (!durable.has(receipt.intentId)) {
        throw new OutboxRefusal(
          OUTBOX_RECEIPT_MISSING_INTENT_ROW,
          `receipt ${receipt.intentId} of command ${fence.commandId} has no durable intent row in this transaction; the ledger and the outbox cannot disagree at the commit fence`,
        );
      }
    }
  }
}

/** The payload shape the fixed build's dispatchVerificationEmail hands its sender. */
export type BaMailCallbackPayload = Readonly<{
  user: { id: string; email: string; name?: string | null };
  url: string;
  token: string;
}>;

/** The controlled sender: the sendVerificationEmail-shaped callback the factory wires. */
export type ControlledMailSender = (
  payload: BaMailCallbackPayload,
  request?: unknown,
) => Promise<OutboxReceipt>;

/** One delivery request, shaped for the §5.1 AuthMailDelivery seam. */
export type OutboxDeliveryRequest = Readonly<{
  idempotencyKey: string;
  kind: OutboxIntentKind;
  to: string;
  subject: string;
  url: string;
}>;

export type OutboxDeliverySender = (
  request: OutboxDeliveryRequest,
) => Promise<{ providerMessageId: string }>;

/** The delivery worker's statement seam: parameterized text in, rows out. */
export type OutboxQuery = (
  text: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

export interface OutboxDeliveryReport {
  considered: number;
  delivered: number;
  failed: { id: string; error: string }[];
}

/** The mail outbox services one factory wiring holds. */
export interface AuthMailOutbox {
  readonly enqueueAuthMailIntent: EnqueueAuthMailIntent["enqueueAuthMailIntent"];
  createControlledMailSender(options: {
    tx: DirectoryTx;
    fence: MailCallbackFence;
    kind?: OutboxIntentKind;
    subject?: string;
    /** A fixed event key for the wired sender; default is derived from the token binding. */
    eventKey?: string;
  }): ControlledMailSender;
  openSealedPayload(sealed: string): SealedMailIntent | null;
  drainAuthMailOutbox(deps: {
    query: OutboxQuery;
    send: OutboxDeliverySender;
    limit?: number;
    attempts?: number;
  }): Promise<OutboxDeliveryReport>;
}

type EnqueueFn = (
  tx: DirectoryTx,
  intent: AuthMailIntent,
) => Promise<OutboxReceipt>;

/**
 * Builds the mail outbox services over one payload secret. The secret never
 * leaves this closure and never reaches a refusal message; the derived key
 * seals every intent's URL and token so the durable rows carry no readable
 * secret and no log line can quote one.
 */
export function createAuthMailOutbox(options: {
  payloadSecret: string;
}): AuthMailOutbox {
  if (typeof options.payloadSecret !== "string" || !options.payloadSecret) {
    throw new OutboxRefusal(
      OUTBOX_PAYLOAD_SECRET_REQUIRED,
      "the mail outbox seals every intent payload; a deployment without payload key material is refused before it could store a readable secret",
    );
  }
  const key = scryptSync(options.payloadSecret, KEY_LABEL, 32);
  const openWithAad = (
    sealed: string,
    aad: string,
  ): SealedMailIntent | null => {
    const plaintext = openPayload(key, sealed, aad);
    if (plaintext === null) return null;
    try {
      return JSON.parse(plaintext) as SealedMailIntent;
    } catch {
      return null;
    }
  };

  const enqueueAuthMailIntent: EnqueueFn = async (tx, intent) => {
    const commandId = requireText(intent?.commandId, "command id");
    const kind = requireText(intent?.kind, "kind") as OutboxIntentKind;
    if (!INTENT_KINDS.includes(kind)) {
      throw new OutboxRefusal(
        OUTBOX_INTENT_INPUT_REQUIRED,
        `intent kind "${String(kind)}" has no registered converter; the vocabulary arrives with the task that owns it`,
      );
    }
    const eventKey = requireText(intent?.eventKey, "event key");
    if (eventKey.length > EVENT_KEY_MAX || !isPrintable(eventKey)) {
      throw new OutboxRefusal(
        OUTBOX_INTENT_EVENT_KEY_INVALID,
        `the event key is the durable intent id: printable, at most ${EVENT_KEY_MAX} characters, derived from stable facts — this one is not, and a truncated or clock-derived key would break delivery idempotency`,
      );
    }
    requireText(intent?.userId, "user id");
    requireText(intent?.to, "recipient address");
    requireText(intent?.subject, "subject");
    const url = requireText(intent?.url, "url");
    const token = requireText(intent?.token, "token");

    const sealedIntent: SealedMailIntent = {
      v: 1,
      kind,
      commandId,
      eventKey,
      userId: intent.userId,
      to: intent.to,
      subject: intent.subject,
      url,
      token,
      enqueuedAt: new Date().toISOString(),
    };
    // The AAD binds the envelope to its row identity: a ciphertext replayed
    // under another id or kind fails the open instead of decrypting.
    // The envelope is authenticated under the fixed marker; the row
    // binding (kind, event key against the row it rides in) is re-checked
    // by the delivery worker after the open, so a ciphertext replayed under
    // another row id is refused there instead of decrypting into it.
    const sealed = sealPayload(
      key,
      JSON.stringify(sealedIntent),
      SEALED_MARKER,
    );

    try {
      await tx.execute(
        dsql`SELECT public.auth_command_append_outbox(${eventKey}, ${commandId}, ${kind}, ${sealed})`,
      );
    } catch (error) {
      throw refusalOfAppend(error);
    }
    return { intentId: eventKey, commandId, kind, token };
  };

  return {
    enqueueAuthMailIntent,
    openSealedPayload: (sealed) => {
      const intent = openWithAad(sealed, SEALED_MARKER);
      if (intent?.v !== 1) return null;
      return intent;
    },
    createControlledMailSender:
      ({
        tx,
        fence,
        kind = "link-account.verify",
        subject = "Verify your email",
        eventKey,
      }) =>
      async (payload) => {
        if (fence.settledAs() !== undefined) {
          throw new OutboxRefusal(
            OUTBOX_CALLBACK_TX_CLOSED,
            `the controlled sender of command ${fence.commandId} was invoked after its transaction settled (${fence.settledAs()}); a late callback may neither write nor send`,
          );
        }
        if (
          !payload ||
          typeof payload !== "object" ||
          typeof (payload as BaMailCallbackPayload).url !== "string" ||
          typeof (payload as BaMailCallbackPayload).token !== "string" ||
          typeof (payload as BaMailCallbackPayload).user?.id !== "string" ||
          typeof (payload as BaMailCallbackPayload).user?.email !== "string"
        ) {
          throw new OutboxRefusal(
            OUTBOX_INTENT_INPUT_REQUIRED,
            "the controlled sender translates the fixed build's {user, url, token} notification payload; anything else is refused before a receipt is owed",
          );
        }
        const notification = payload as BaMailCallbackPayload;
        const resolvedEventKey =
          eventKey ??
          `${kind}:${createHash("sha256").update(notification.token).digest("hex")}`;
        fence.observeTokenCreated(notification.token);
        fence.callbackStarted(notification.token);
        try {
          const receipt = await enqueueAuthMailIntent(tx, {
            commandId: fence.commandId,
            kind,
            eventKey: resolvedEventKey,
            userId: notification.user.id,
            to: notification.user.email,
            subject,
            url: notification.url,
            token: notification.token,
          });
          fence.callbackCompleted(notification.token, receipt);
          return receipt;
        } catch (error) {
          // The ledger keeps the original error; the fixed package may
          // swallow the rethrow, but the pre-commit fence still owns it.
          fence.callbackFailed(notification.token, error);
          throw error;
        }
      },
    drainAuthMailOutbox: async ({ query, send, limit = 16, attempts = 2 }) => {
      const rows = await query(
        "SELECT id, command_id, kind, payload FROM auth_command_outbox WHERE status IN ('pending','failed') ORDER BY created_at, id LIMIT $1",
        [limit],
      );
      const report: OutboxDeliveryReport = {
        considered: rows.length,
        delivered: 0,
        failed: [],
      };
      for (const row of rows) {
        const id = String(row.id);
        const kind = String(row.kind) as OutboxIntentKind;
        const intent = openWithAad(String(row.payload), SEALED_MARKER);
        // The row binding the seal could not carry as AAD is checked here:
        // a ciphertext replayed under another row id or kind refuses to
        // deliver rather than decrypting into the wrong intent.
        if (!intent || intent.kind !== kind || intent.eventKey !== id) {
          await query(
            "UPDATE auth_command_outbox SET status = 'failed' WHERE id = $1 AND status <> 'delivered'",
            [id],
          );
          report.failed.push({
            id,
            error: OUTBOX_SEALED_PAYLOAD_UNREADABLE,
          });
          continue;
        }
        let delivered = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts && !delivered; attempt += 1) {
          try {
            await send({
              idempotencyKey: id,
              kind,
              to: intent.to,
              subject: intent.subject,
              url: intent.url,
            });
            // Zero updated rows means another worker delivered first: the
            // send still rode the same stable key, so it is not a failure.
            await query(
              "UPDATE auth_command_outbox SET status = 'delivered', delivered_at = now() WHERE id = $1 AND status IN ('pending','failed') RETURNING id",
              [id],
            );
            delivered = true;
          } catch (error) {
            lastError = error;
          }
        }
        if (delivered) {
          report.delivered += 1;
          continue;
        }
        await query(
          "UPDATE auth_command_outbox SET status = 'failed' WHERE id = $1 AND status <> 'delivered'",
          [id],
        );
        report.failed.push({ id, error: messageOf(lastError) });
      }
      return report;
    },
  };
}
