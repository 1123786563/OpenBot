/*
 * createPasswordRecoveryIngress — §5.1's private recovery surface
 * (T04.05 / #549, original task P08).
 *
 * Three URLs, one owner. The directory ingress classifies
 * POST /api/auth/request-password-reset, GET /api/auth/reset-password/:token
 * and POST /api/auth/reset-password and hands every one of them to this
 * ingress; the pinned build's own handler never serves them (F-01), and no
 * other mount opens a second entrance.
 *
 * 1. The request POST wraps the fixed build's own request route in one
 *    command transaction on the recovery database connection: the
 *    pre-resolved target begins the identity.notify command, the native
 *    route runs inside TransactionBoundBa with the mail conversion context
 *    installed, and the commit fence (assertMailCallbackCompletion plus the
 *    created-token reconciliation below) refuses the commit unless every
 *    reset verification this transaction created carries exactly one
 *    completed encrypted outbox intent. The fixed build's
 *    runInBackgroundOrAwait swallows the converter's error and answers
 *    success — the native success is never the commit answer, and the
 *    preserved original error is what the caller sees. An unknown address
 *    answers the fixed build's exact success shape with nothing behind it:
 *    no command, no token, no intent. A redirectTo that is not the local
 *    /reset-password surface is refused before anything is tokenized.
 *
 * 2. The mail link's GET validates and redirects to the local reset
 *    surface through the fixed build's own callback endpoint; it consumes
 *    nothing (consumption is the reset POST's alone).
 *
 * 3. The reset POST is the identity executor's recovery boundary — one
 *    transaction: locate, lock, re-verify, the tx-bound recovery actor,
 *    identity.password.reset with the native POST as the ONLY
 *    consumeVerificationValue caller, the finalizer's generation bump and
 *    session/proof revocation. This ingress only translates HTTP; it never
 *    consumes a token itself and never calls Identity.execute twice.
 *
 * A deployment without password accounts (pure SSO) has no recovery
 * entrance at all: every one of the three answers a named 503 before any
 * body is executed.
 */

import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import type { DirectoryTx, TransactionBoundBa } from "./directory/contracts";
import type { IdentityExecutor } from "./directory/identity";
import { isIdentityCommandRefusal } from "./directory/identity";
import { NativeAuthRefusal, nativeAuthPath } from "./directory/ingress";
import type { AuthMailOutbox, MailCallbackFence } from "./directory/outbox";
import {
  assertMailCallbackCompletion,
  createMailCallbackFence,
  OutboxRefusal,
  settleMailCallbackFence,
} from "./directory/outbox";
import { runWithAuthMailCommand } from "./mail";

export const PASSWORD_RECOVERY_INPUT_REQUIRED =
  "PASSWORD_RECOVERY_INPUT_REQUIRED";
export const PASSWORD_RECOVERY_CLOSED_FOR_SSO =
  "PASSWORD_RECOVERY_CLOSED_FOR_SSO";
export const PASSWORD_RECOVERY_REDIRECT_UNTRUSTED =
  "PASSWORD_RECOVERY_REDIRECT_UNTRUSTED";
export const PASSWORD_RECOVERY_NOT_WIRED = "PASSWORD_RECOVERY_NOT_WIRED";
export const RESET_TOKEN_WITHOUT_RECEIPT = "RESET_TOKEN_WITHOUT_RECEIPT";

/** The only local surface a reset mail may redirect into (P13's page). */
export const RESET_REDIRECT_PREFIX = "/reset-password";

/**
 * Whether a redirectTo/callbackURL is the trusted local reset surface: a
 * path that starts with /reset-password and nothing that a browser would
 * read as another origin (no scheme, no protocol-relative //host).
 */
export function isTrustedResetRedirect(value: string): boolean {
  return value.startsWith(RESET_REDIRECT_PREFIX) && !value.startsWith("//");
}

/**
 * The fixed-build calls the ingress makes, narrowed to the two recovery
 * endpoints it wraps (the reset POST belongs to the identity executor's
 * `ba` seam, never to this ingress).
 */
export interface PasswordRecoveryAuthPort {
  readonly api: {
    requestPasswordReset(input: {
      readonly headers?: Headers;
      readonly body: Readonly<Record<string, unknown>>;
      readonly asResponse: true;
    }): Promise<Response>;
    requestPasswordResetCallback(input: {
      readonly headers?: Headers;
      readonly readonly?: never;
      readonly params: Readonly<{ token: string }>;
      readonly query: Readonly<{ callbackURL: string }>;
      readonly asResponse: true;
    }): Promise<Response>;
  };
}

export interface PasswordRecoveryIngressDeps {
  /** The recovery database: every command transaction opens here. */
  readonly database: Pick<Database, "transaction">;
  readonly auth: PasswordRecoveryAuthPort;
  /** The executor's TransactionBoundBa — the native route runs through it. */
  readonly bound: TransactionBoundBa;
  /**
   * The mail outbox the converter registers intents on. Null keeps the
   * request POST honestly refused: without delivery there is no reset mail,
   * and a token that cannot reach its owner must never be created.
   */
  readonly outbox: Pick<AuthMailOutbox, "createControlledMailSender"> | null;
  /** The identity executor's recovery boundary; null is an honest 503. */
  readonly identity: Pick<IdentityExecutor, "recovery"> | null;
  /** False on a pure-SSO deployment: no recovery entrance at all. */
  readonly passwordEnabled: boolean;
}

export interface PasswordRecoveryIngress {
  /**
   * Answers the request, or null when the URL is not one of the three
   * recovery endpoints (the directory ingress forwards only classified
   * recovery paths, so null keeps the delegation shape uniform).
   */
  handle(request: Request): Promise<Response | null>;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function forwarded(headers: Headers): Headers {
  const clone = new Headers();
  for (const [name, value] of headers.entries()) {
    if (["host", "content-length", "connection"].includes(name.toLowerCase())) {
      continue;
    }
    clone.set(name, value);
  }
  if (!clone.has("content-type")) {
    clone.set("content-type", "application/json");
  }
  return clone;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.clone().json()) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The deepest error message in the cause chain — a database driver wraps a
 * server-side refusal in "Failed query: … params: …", and the recovery
 * surface never echoes statement text or parameters back to a caller. A
 * message that still looks like driver wrapping is not a message at all.
 */
function rootMessageOf(error: unknown): string | undefined {
  let current = error instanceof Error ? error : undefined;
  let deepest = current?.message;
  while (current?.cause instanceof Error) {
    current = current.cause;
    deepest = current.message;
  }
  return deepest && !/params:|Failed query/.test(deepest) ? deepest : undefined;
}

/** The response one refusal becomes — the caller never sees a raw stack. */
function toResponse(error: unknown): Response {
  // The fence's refusal carries the callback's preserved original error as
  // its cause; §5.1 names that error, not the fence's own message, as what
  // the caller must see.
  const surfaced =
    error instanceof OutboxRefusal && error.cause !== undefined
      ? error.cause
      : error;
  if (surfaced instanceof NativeAuthRefusal) {
    return Response.json(
      { error: surfaced.message, code: surfaced.code },
      { status: surfaced.status },
    );
  }
  if (isIdentityCommandRefusal(surfaced)) {
    return Response.json(
      {
        error: surfaced.message,
        code: surfaced.code,
      },
      { status: surfaced.status },
    );
  }
  if (surfaced instanceof OutboxRefusal) {
    return Response.json(
      { error: surfaced.message, code: surfaced.code },
      { status: 500 },
    );
  }
  return Response.json(
    {
      error:
        rootMessageOf(surfaced) ??
        "the password recovery command failed; nothing committed and the token remains retryable",
      code: "PASSWORD_RECOVERY_FAILED",
    },
    { status: 500 },
  );
}

/** The reset-token verification identifiers visible on this transaction. */
async function resetTokenIdentifiers(tx: DirectoryTx): Promise<Set<string>> {
  const rows = rowsOf(
    await tx.execute(
      sql`SELECT identifier FROM verifications WHERE identifier LIKE 'reset-password:%'`,
    ),
  );
  return new Set(rows.map((row) => String(row.identifier)));
}

export function createPasswordRecoveryIngress(
  deps: PasswordRecoveryIngressDeps,
): PasswordRecoveryIngress {
  const requirePasswordSurface = (): void => {
    if (!deps.passwordEnabled) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_CLOSED_FOR_SSO,
        "this deployment authenticates through SSO only: the password recovery entrances are not open, and no reset token is ever issued or consumed here",
        503,
      );
    }
  };

  /**
   * §5.1 step 1: the request POST, one command transaction around the fixed
   * build's own request route.
   */
  async function requestReset(request: Request): Promise<Response> {
    requirePasswordSurface();
    if (!deps.outbox) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_NOT_WIRED,
        "the deployment configured password accounts without the mail outbox: a reset token that could never reach its owner must not be created, so the request is refused rather than half-issued",
        503,
      );
    }
    const body = await readJson(request);
    const email = text(body.email);
    const redirectTo = text(body.redirectTo);
    if (!email) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_INPUT_REQUIRED,
        "the reset request names its target by email; an empty address is refused before anything is read",
        400,
      );
    }
    if (redirectTo !== undefined && !isTrustedResetRedirect(redirectTo)) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_REDIRECT_UNTRUSTED,
        `the redirectTo must be the local ${RESET_REDIRECT_PREFIX} surface; "${redirectTo}" names somewhere else and the reset mail never carries an off-site or foreign destination`,
        400,
      );
    }

    let fence: MailCallbackFence | undefined;
    try {
      return await deps.database.transaction(async (trx) => {
        const tx = trx as never as DirectoryTx;
        // The non-authorizing pre-resolution: the fixed build's own lookup
        // semantics (exact match on the address as given), so the command
        // envelope's target is the user the native route is about to see.
        const known = rowsOf(
          await tx.execute(
            sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`,
          ),
        );
        const targetUserId = known[0] ? String(known[0].id) : null;
        // The reconciliation baseline: every reset verification this
        // transaction can see before the native route runs. The diff after
        // it is what the commit fence holds to account — a foreign token
        // that commits between the two reads reads as unproven here and
        // rolls this request back, which is the safe direction.
        const baseline = await resetTokenIdentifiers(tx);

        if (targetUserId) {
          const commandId = `password-recovery-${randomUUID()}`;
          const payloadHash = createHash("sha256")
            .update(
              JSON.stringify({
                operation: "identity.notify",
                email,
                targetUserId,
              }),
            )
            .digest("hex");
          await tx.execute(
            sql`SELECT set_config('auth.current_command',
              public.auth_directory_begin_command(
                ${commandId}, 'identity', 'identity.notify', null, ${targetUserId}, ${targetUserId},
                'platform', ${`password-reset-request:${randomUUID()}`}, ${payloadHash}),
              true)`,
          );
          fence = createMailCallbackFence(tx, commandId);
        }

        const call = () =>
          deps.bound
            .run(tx, () =>
              deps.auth.api.requestPasswordReset({
                headers: forwarded(request.headers),
                body: { email, ...(redirectTo ? { redirectTo } : {}) },
                asResponse: true,
              }),
            )
            .then((outcome: { value: Response }) => outcome.value);
        const native = fence
          ? await runWithAuthMailCommand(
              { tx, fence, outbox: deps.outbox },
              call,
            )
          : await call();

        // §5.1's commit fence, in order: the ledger's own reconciliation
        // (every token the callbacks observed holds exactly one completed,
        // durable receipt — a failed callback throws here with its
        // preserved original error), then the created-token reconciliation
        // (a token this transaction created that no callback ever observed
        // never commits alone).
        if (fence) {
          await assertMailCallbackCompletion(tx, fence);
        }
        const fresh = [...(await resetTokenIdentifiers(tx))].filter(
          (identifier) => !baseline.has(identifier),
        );
        const proven = new Set(
          (fence?.facts ?? [])
            .filter((fact) => fact.state === "completed")
            .map((fact) => `reset-password:${fact.token}`),
        );
        const orphans = fresh.filter((identifier) => !proven.has(identifier));
        if (orphans.length > 0) {
          throw new NativeAuthRefusal(
            RESET_TOKEN_WITHOUT_RECEIPT,
            `this transaction created ${orphans.length} reset verification token(s) with no completed outbox receipt; the notification never converted inside its command, and the token must not commit alone`,
            500,
          );
        }

        if (fence) {
          await tx.execute(
            sql`SELECT public.auth_directory_finalize_command(${fence.commandId})`,
          );
          await tx.execute(
            sql`SELECT set_config('auth.current_command', '', true)`,
          );
        }
        return native;
      });
    } catch (error) {
      // §5.1: the caller sees the preserved original error of the failed
      // callback — not the savepoint machinery's refusal of the poisoned
      // transaction it caused.
      const failedFact = fence?.facts.find((fact) => fact.state === "failed");
      if (fence && fence.settledAs() === undefined) {
        settleMailCallbackFence(fence, "rolled-back");
      }
      return toResponse(failedFact?.error ?? error);
    }
  }

  /** The mail link's GET: validate, redirect locally, consume nothing. */
  async function resetCallback(
    request: Request,
    token: string,
  ): Promise<Response> {
    requirePasswordSurface();
    const url = new URL(request.url);
    const callbackURL = url.searchParams.get("callbackURL") ?? "";
    if (!callbackURL) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_INPUT_REQUIRED,
        "the reset link names the local surface it must land on; a callbackURL-less request is refused before the token is read",
        400,
      );
    }
    if (!isTrustedResetRedirect(callbackURL)) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_REDIRECT_UNTRUSTED,
        `the callbackURL must be the local ${RESET_REDIRECT_PREFIX} surface; "${callbackURL}" names somewhere else and the reset link never bounces off-site`,
        400,
      );
    }
    return deps.auth.api.requestPasswordResetCallback({
      headers: forwarded(request.headers),
      params: { token },
      query: { callbackURL },
      asResponse: true,
    });
  }

  /**
   * §5.1 step 2: the reset POST is the identity executor's recovery
   * boundary — this ingress translates HTTP and derives the idempotency
   * key; the single outer transaction, the tx-bound actor, the native
   * consume and the finalizer all belong to the executor.
   */
  async function resetPassword(request: Request): Promise<Response> {
    requirePasswordSurface();
    if (!deps.identity?.recovery) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_NOT_WIRED,
        "the identity executor's recovery boundary is not wired: a password reset never happens without its transaction owner, and the request is refused before anything is written",
        503,
      );
    }
    const body = await readJson(request);
    const token = text(body.token);
    const newPassword =
      typeof body.newPassword === "string" && body.newPassword.length > 0
        ? body.newPassword
        : undefined;
    if (!token || !newPassword) {
      throw new NativeAuthRefusal(
        PASSWORD_RECOVERY_INPUT_REQUIRED,
        "the reset carries the mail link's token and the new password; anything less is refused before the token is read",
        400,
      );
    }
    // The key is bound to the token alone: a network retry of the same link
    // is the same command (the identity idempotency domain), while the
    // token's own row is what a consumed replay cannot produce — the
    // locating read refuses it before any receipt could answer for it.
    const idempotencyKey = `password-recovery:${createHash("sha256").update(token).digest("hex")}`;
    try {
      await deps.identity.recovery.resetPasswordByToken({
        resetToken: token,
        newPassword,
        idempotencyKey,
      });
    } catch (error) {
      return toResponse(error);
    }
    return Response.json({ status: true }, { status: 200 });
  }

  /*
   * The route boundary: a refusal of any named kind becomes its response
   * here, so the mounted app never sees a raw exception from the recovery
   * surface (the directory ingress delegates to handle() directly).
   */
  async function guarded(
    route: (request: Request, ...rest: string[]) => Promise<Response>,
    request: Request,
    ...rest: string[]
  ): Promise<Response> {
    try {
      return await route(request, ...rest);
    } catch (error) {
      return toResponse(error);
    }
  }

  return Object.freeze({
    async handle(request: Request): Promise<Response | null> {
      const path = nativeAuthPath(new URL(request.url).pathname);
      if (request.method === "POST" && path === "/request-password-reset") {
        return guarded(requestReset, request);
      }
      if (
        request.method === "GET" &&
        path.startsWith(`${RESET_REDIRECT_PREFIX}/`) &&
        path.length > RESET_REDIRECT_PREFIX.length + 1
      ) {
        return guarded(
          resetCallback,
          request,
          path.slice(RESET_REDIRECT_PREFIX.length + 1),
        );
      }
      if (request.method === "POST" && path === "/reset-password") {
        return guarded(resetPassword, request);
      }
      return null;
    },
  });
}
