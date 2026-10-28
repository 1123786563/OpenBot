/*
 * createAuthMail — the §5.1 mail seam (T04.04 / #548, original task P08):
 * the Better Auth typed `sendVerificationEmail` / `sendResetPassword`
 * callbacks and the `AuthMailDelivery` provider adapter, over the T02.12
 * transactional notification outbox.
 *
 * What this file owns, and nothing else:
 *
 * 1. The per-command conversion context. A mail callback the fixed package
 *    invokes is meaningful only inside a live command transaction: there,
 *    and only there, the T02.12 controlled sender registers the encrypted
 *    intent + receipt beside the command's own writes. `runWithAuthMailCommand`
 *    installs that context (tx, fence, outbox) around one BA operation; a
 *    callback that arrives with no context — a late closure, a foreign
 *    request — is refused before anything is written or sent, exactly like
 *    the outbox's own settled-transaction refusal.
 *
 * 2. The callbacks. `sendVerificationEmail` converts the fixed build's
 *    {user, url, token} notification into an `email.verify` intent;
 *    `sendResetPassword` converts the recovery notification into a
 *    `password.reset` intent (the reset HTTP flow itself is T04.05's).
 *    Both carry the URL and the token only inside the outbox's sealed
 *    payload — nothing readable reaches a row, a log or this file's errors.
 *
 * 3. The delivery adapter. `AuthMailDelivery.send({to, subject, text,
 *    html, idempotencyKey})` sends one mail over standard SMTP and returns
 *    the provider's message id; the idempotency key rides the Message-ID so
 *    a crash-replayed send is the same message at the provider. `outboxSender`
 *    adapts the T02.12 drain request to this seam, so only the post-commit
 *    worker ever delivers. Real-provider acceptance evidence is T08.06's;
 *    this deployment's receiver is whatever the SMTP env names.
 *
 * 4. The startup gate. `assertAuthMailTakeover` refuses a configuration that
 *    enables mail without the conversion installed: sendOnSignUp/sendOnSignIn
 *    or sendResetPassword enabled while the callbacks are not this module's
 *    converters, or the deferred link-account source is not dispositioned
 *    for the outbox takeover, never starts (interfaces §3.1: 启用相关邮件
 *    配置前先完成接管).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import nodemailer from "nodemailer";
import type { DirectoryTx, OutboxIntentKind } from "./directory/contracts";
import type {
  AuthMailOutbox,
  BaMailCallbackPayload,
  MailCallbackFence,
  OutboxDeliverySender,
} from "./directory/outbox";
import { OutboxRefusal } from "./directory/outbox";
import { BA_HOOK_SOURCE_REGISTRY } from "./directory/transaction-adapter";

export const AUTH_MAIL_NO_COMMAND_CONTEXT = "AUTH_MAIL_NO_COMMAND_CONTEXT";
export const AUTH_MAIL_OUTBOX_NOT_CONFIGURED =
  "AUTH_MAIL_OUTBOX_NOT_CONFIGURED";
export const AUTH_MAIL_SMTP_MISCONFIGURED = "AUTH_MAIL_SMTP_MISCONFIGURED";
export const AUTH_MAIL_TAKEOVER_REQUIRED = "AUTH_MAIL_TAKEOVER_REQUIRED";

/** One deployment's standard SMTP settings, parsed from the env by config. */
export interface AuthMailSmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly from: string;
}

/** §5.1's provider seam: one mail, one stable idempotency key. */
export type AuthMailDelivery = Readonly<{
  send(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}>;

/**
 * One Better Auth mail callback, exactly as the pinned build's options type
 * constrains it: the {user, url, token} notification and the request, and
 * no return — the receipt the conversion earns lives in the command's
 * callback fence, where the pre-commit completion assert reads it.
 */
export type BaMailCallback = (
  payload: BaMailCallbackPayload,
  request?: unknown,
) => Promise<void>;

/** The tx/fence/outbox a command's mail callbacks convert through. */
export interface AuthMailCommandContext {
  readonly tx: DirectoryTx;
  readonly fence: MailCallbackFence;
  readonly outbox: Pick<AuthMailOutbox, "createControlledMailSender"> | null;
}

const authMailCommand = new AsyncLocalStorage<AuthMailCommandContext>();

/**
 * Runs one BA operation with the command's mail conversion context
 * installed. The executor wraps its handler this way when an outbox is
 * configured, so every fixed-package callback the operation fires converts
 * on the live transaction — and a callback that escapes the wrapper (a
 * deferred closure run elsewhere) finds no context and is refused.
 */
export function runWithAuthMailCommand<T>(
  context: AuthMailCommandContext,
  operation: () => Promise<T>,
): Promise<T> {
  return authMailCommand.run(context, operation);
}

function currentAuthMailCommand(): Omit<AuthMailCommandContext, "outbox"> & {
  outbox: NonNullable<AuthMailCommandContext["outbox"]>;
} {
  const context = authMailCommand.getStore();
  if (!context) {
    throw new OutboxRefusal(
      AUTH_MAIL_NO_COMMAND_CONTEXT,
      "a mail callback arrived outside a live command transaction; the notification is converted only inside its command (the encrypted outbox intent), and delivery belongs to the post-commit worker — nothing is sent here",
    );
  }
  if (!context.outbox) {
    throw new OutboxRefusal(
      AUTH_MAIL_OUTBOX_NOT_CONFIGURED,
      "a mail callback fired inside a command whose executor carries no mail outbox; the notification cannot be converted into an intent and is refused unsent — configure the outbox with the executor before enabling mail",
    );
  }
  return {
    tx: context.tx,
    fence: context.fence,
    outbox: context.outbox,
  };
}

/** What createAuthMail returns (interfaces §5.1). */
export interface AuthMailServices {
  readonly sendVerificationEmail: BaMailCallback;
  readonly sendResetPassword: BaMailCallback;
  readonly delivery: AuthMailDelivery;
  /** The T02.12 drain side: one outbox request → one delivered mail. */
  readonly outboxSender: OutboxDeliverySender;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * A Message-ID body safe for any SMTP transport: the outbox's event key is
 * printable text but not necessarily msg-id grammar, and the key's role here
 * is provider-level dedup of a crash replay — the outbox row's own status
 * transition is the authoritative exactly-once.
 */
function messageBodyOf(idempotencyKey: string): string {
  return idempotencyKey.replace(/[^A-Za-z0-9._:-]+/g, "_");
}

export function createAuthMail(deps: {
  smtp: AuthMailSmtpSettings;
  outbox: Pick<AuthMailOutbox, "createControlledMailSender">;
}): AuthMailServices {
  const { host, port, secure, user, password, from } = deps.smtp;
  if (!host || !Number.isInteger(port) || port <= 0 || !from) {
    throw new OutboxRefusal(
      AUTH_MAIL_SMTP_MISCONFIGURED,
      "the SMTP settings need a host, a positive integer port and a sender address; a deployment that enables mail is refused before it could half-send",
    );
  }
  if ((user === undefined) !== (password === undefined)) {
    throw new OutboxRefusal(
      AUTH_MAIL_SMTP_MISCONFIGURED,
      "the SMTP settings carry a user without a password (or the reverse); name both or neither in the environment",
    );
  }
  // Loaded lazily so importing the seam never opens sockets; the transport
  // is one pooled connection per process, created from the settings exactly
  // once — a relay greeting is not free, and the post-commit worker's sends
  // are short bursts.
  let transport: nodemailer.Transporter | undefined;
  const transporter = (): nodemailer.Transporter => {
    transport ??=
      user === undefined
        ? nodemailer.createTransport({ host, port, secure, pool: true })
        : nodemailer.createTransport({
            host,
            port,
            secure,
            pool: true,
            auth: { user, pass: password },
          });
    return transport;
  };

  /*
   * One converter of each kind: resolve the live command context, build the
   * controlled sender over it, let the fence keep the receipt (the fixed
   * package's callback type returns nothing and must not learn the outbox's
   * shape). The pinned build has ONE verification-mail callback and T02.12
   * froze its intent kind as `link-account.verify` (the deferred dispatch's
   * takeover target); the signup and resend paths fire the same callback,
   * so the same converter and kind serve them all. `password.reset` is the
   * reset mail's own kind (the reset HTTP flow is T04.05's).
   */
  const converter =
    (kind: OutboxIntentKind, subject: string): BaMailCallback =>
    async (payload, request) => {
      const { tx, fence, outbox } = currentAuthMailCommand();
      const send = outbox.createControlledMailSender({
        tx,
        fence,
        kind,
        subject,
      });
      await send(payload, request);
    };

  const delivery: AuthMailDelivery = {
    async send(input) {
      const messageId = `<${messageBodyOf(input.idempotencyKey)}@openbot-auth-mail>`;
      const info = await transporter().sendMail({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        messageId,
      });
      return { providerMessageId: info.messageId ?? messageId };
    },
  };

  return {
    sendVerificationEmail: converter(
      "link-account.verify",
      "Verify your email",
    ),
    sendResetPassword: converter("password.reset", "Reset your password"),
    delivery,
    outboxSender: (request) =>
      delivery.send({
        to: request.to,
        subject: request.subject,
        text: `${request.subject}\n\n${request.url}\n`,
        html: `<p>${escapeHtml(request.subject)}</p><p><a href="${escapeHtml(request.url)}">${escapeHtml(request.url)}</a></p>`,
        idempotencyKey: request.idempotencyKey,
      }),
  };
}

/** The startup gate's view of the factory's mail-facing options. */
export interface AuthMailTakeoverView {
  readonly emailVerification?: {
    readonly sendOnSignUp?: boolean;
    readonly sendOnSignIn?: boolean;
    readonly sendVerificationEmail?: unknown;
  };
  readonly emailAndPassword?: { readonly sendResetPassword?: unknown };
  /** The converters the factory wired; null when mail is not wired. */
  readonly authMail?: AuthMailServices | null;
  /**
   * Whether the deferred link-account notification source is dispositioned
   * for the outbox takeover in the hook fence's registry. Defaults to the
   * live registry's answer; a test may pin it to prove the refusal shape.
   */
  readonly takeoverDispositionInstalled?: () => boolean;
}

/**
 * The §3.1/§5.1 startup gate: a configuration that enables mail must carry
 * this module's converters, and the hook fence must already disposition the
 * link-account notification source for the outbox takeover. Anything else is
 * refused before a route runs — a notification that could fire from an
 * un-taken-over deferred hook must never reach a live request.
 */
export function assertAuthMailTakeover(view: AuthMailTakeoverView): void {
  const { emailVerification, emailAndPassword } = view;
  const enabled =
    emailVerification?.sendOnSignUp === true ||
    emailVerification?.sendOnSignIn === true ||
    emailAndPassword?.sendResetPassword !== undefined;
  if (!enabled) return;
  const installed =
    view.takeoverDispositionInstalled?.() ??
    defaultTakeoverDispositionInstalled();
  if (!view.authMail || !installed) {
    throw new Error(
      `${AUTH_MAIL_TAKEOVER_REQUIRED}: mail is enabled (sendOnSignUp/sendOnSignIn/sendResetPassword) but the outbox conversion is not installed — wire createAuthMail's callbacks into the factory options and the notification-outbox takeover into the hook fence before enabling mail; refusing to start`,
    );
  }
  if (
    emailVerification?.sendVerificationEmail !== undefined &&
    emailVerification.sendVerificationEmail !==
      view.authMail.sendVerificationEmail
  ) {
    throw new Error(
      `${AUTH_MAIL_TAKEOVER_REQUIRED}: emailVerification.sendVerificationEmail is not createAuthMail's converter — a notification must be translated into an encrypted outbox intent inside its command transaction, never sent from the callback; refusing to start`,
    );
  }
  if (
    emailAndPassword?.sendResetPassword !== undefined &&
    emailAndPassword.sendResetPassword !== view.authMail.sendResetPassword
  ) {
    throw new Error(
      `${AUTH_MAIL_TAKEOVER_REQUIRED}: emailAndPassword.sendResetPassword is not createAuthMail's converter; refusing to start`,
    );
  }
}

/*
 * The live registry's answer: the pinned build's deferred link-account
 * notification source must be dispositioned for the outbox takeover, or a
 * mail-enabled deployment could fire a notification from an un-converted
 * deferred hook. Read directly — the transaction adapter never imports this
 * module, so there is no cycle.
 */
function defaultTakeoverDispositionInstalled(): boolean {
  return BA_HOOK_SOURCE_REGISTRY.some(
    (entry) =>
      entry.packageFile === "better-auth/dist/oauth2/link-account.mjs" &&
      entry.line === 304 &&
      !("reason" in entry.disposition) &&
      entry.disposition.kind === "notification-outbox-takeover",
  );
}
