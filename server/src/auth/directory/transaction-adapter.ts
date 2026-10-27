/*
 * TransactionBoundBa — binds one Better Auth command to the executor's outer
 * transaction (T01.03 / #515, extended by T01.04 / #516; interfaces §3.1).
 *
 * What this file is responsible for, and nothing else:
 *
 * 1. Request-local adapter. For every run it takes the transaction-scoped
 *    Better Auth adapter (built by the caller from the fixed package's own
 *    adapter factory over the open DirectoryTx) and installs it as the outer
 *    ALS store with `isTransactionActive: true` and the executor's
 *    `pendingHooks` array. With that store active, the fixed plugin's
 *    `getCurrentAdapter(callback)` calls resolve to the transaction adapter,
 *    and its nested `runWithTransaction` sees `isTransactionActive` and
 *    reuses the store instead of opening a second transaction on the pool —
 *    the fixed 1.7.1 build does not create a savepoint of its own.
 *
 *    The binding itself imports no Better Auth plugin and no database driver;
 *    Drizzle is the plan's sanctioned ORM and `DirectoryTx` is the server's
 *    own Drizzle transaction type, so savepoints go through `tx.execute`.
 *
 * 2. Command savepoint. A failure anywhere in the operation must not leave
 *    the executor's transaction poisoned. The run opens one savepoint before
 *    the operation: a failure rolls the command's writes back to it and
 *    releases it, so the executor still owns a healthy transaction for its
 *    finalizer/rollback path.
 *
 * 3. First-error preservation. Some fixed-package compensations (the
 *    accept-invitation catch that flips the invitation back to `pending`) run
 *    inside the already-aborted transaction; PostgreSQL answers them with
 *    25P02 ("current transaction is aborted") and that error replaces the
 *    original failure. The adapter is instrumented to record the first
 *    SQLSTATE the fixed package actually hit; when the operation surfaces
 *    25P02, the run rethrows that first error (message and SQLSTATE intact)
 *    instead, so the caller never sees the compensation's 25P02 in place of
 *    the real cause. The same rule covers the swallowed-error case: an
 *    operation that returns "successfully" on an aborted transaction (the
 *    fixed package's runInBackgroundOrAwait catches callback errors, so a
 *    failed email dispatch inside the command leaves the transaction dead
 *    while the command itself reports success) surfaces as a named refusal
 *    carrying the first recorded SQLSTATE as its cause — never as a bare
 *    25P02 from the savepoint release.
 *
 * 4. Hook fence (T01.04). Deferred hooks the fixed package registers during
 *    the operation are captured in this run's store and classified by their
 *    registering source against BA_HOOK_SOURCE_REGISTRY — the pinned build's
 *    own call sites, matched on package file and line from the registration
 *    stack, never by inspecting closure text. Sources dispositioned
 *    read-only or disabled-cache-noop return in the outcome for the executor
 *    to drain exactly once after commit; a notification-outbox-takeover
 *    source (T04.04) is converted — its closure runs inside the still-open
 *    transaction so the controlled sender registers the outbox intent, and
 *    never drains post-commit. Every other source (unregistered
 *    databaseHooks, notifications without an outbox takeover, cache writes
 *    that require the forbidden secondaryStorage) and any unregistered site
 *    is refused before commit — silently dropping, or committing without
 *    classifying, is exactly the failure mode the contract forbids.
 */

import { getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context";
import { sql } from "drizzle-orm";
import type {
  BaAuthorityOptionsView,
  BaTxOutcome,
  DirectoryTx,
  HookSourceClassification,
  PostCommitHook,
  TransactionBoundBa,
} from "./contracts";

export const UNCLASSIFIED_POST_COMMIT_HOOK = "UNCLASSIFIED_POST_COMMIT_HOOK";
export const UNREGISTERED_DATABASE_HOOK = "UNREGISTERED_DATABASE_HOOK";
export const NOTIFICATION_HOOK_WITHOUT_OUTBOX_TAKEOVER =
  "NOTIFICATION_HOOK_WITHOUT_OUTBOX_TAKEOVER";
export const CACHE_HOOK_WITH_FORBIDDEN_STORAGE =
  "CACHE_HOOK_WITH_FORBIDDEN_STORAGE";
export const SWALLOWED_ERROR_ABORTED_TRANSACTION =
  "SWALLOWED_ERROR_ABORTED_TRANSACTION";
export const BA_AUTHORITY_CONFIG_VIOLATION = "BA_AUTHORITY_CONFIG_VIOLATION";
const TRANSACTION_ABORTED_SQLSTATE = "25P02";
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Every `queueAfterTransactionHook` call site in the pinned better-auth
 * 1.7.1 build (better-auth, @better-auth/core, @better-auth/sso and
 * @better-auth/scim; the latter two contain none). Line anchors are exact for
 * the pinned build — a package upgrade that moves or adds a call site fails
 * the registry pin in the transaction-hooks suite and must be re-classified
 * (interfaces §3.1: 未登记 hook 提交前拒绝；依赖包升级增加 hook 必须重新分类).
 */
export const BA_HOOK_SOURCE_REGISTRY: readonly HookSourceClassification[] = [
  {
    hookId: "ba-1.7.1/internal-adapter.mjs:607:updateUser-refreshUserSessions",
    packageFile: "better-auth/dist/db/internal-adapter.mjs",
    line: 607,
    site: "internalAdapter.updateUser → refreshUserSessions",
    disposition: { kind: "disabled-cache-noop" },
  },
  {
    hookId:
      "ba-1.7.1/internal-adapter.mjs:620:updateUserByEmail-refreshUserSessions",
    packageFile: "better-auth/dist/db/internal-adapter.mjs",
    line: 620,
    site: "internalAdapter.updateUserByEmail → refreshUserSessions",
    disposition: { kind: "disabled-cache-noop" },
  },
  {
    hookId: "ba-1.7.1/internal-adapter.mjs:100:deleteCachedUserSessions",
    packageFile: "better-auth/dist/db/internal-adapter.mjs",
    line: 100,
    site: "queueCachedUserSessionDeletion → deleteCachedUserSessions",
    disposition: { reason: "cache-write-with-forbidden-storage" },
  },
  {
    hookId: "ba-1.7.1/internal-adapter.mjs:315:deferred-session-mirror",
    packageFile: "better-auth/dist/db/internal-adapter.mjs",
    line: 315,
    site: "createSession deferSecondaryStorageWrites → session mirror",
    disposition: { reason: "cache-write-with-forbidden-storage" },
  },
  {
    hookId: "ba-1.7.1/link-account.mjs:304:dispatchVerificationEmail",
    packageFile: "better-auth/dist/oauth2/link-account.mjs",
    line: 304,
    site: "dispatchVerificationEmail → send",
    /*
     * The outbox takeover (T04.04 / P08, interfaces §3.1): the deferred
     * send closure is executed inside the still-open command transaction,
     * where the factory-wired sendVerificationEmail (createAuthMail's
     * controlled sender) registers the encrypted intent + receipt. The
     * closure itself never drains post-commit, so a committed command's
     * mail is always the outbox intent and a rolled-back one leaves none.
     */
    disposition: { kind: "notification-outbox-takeover" },
  },
  {
    hookId: "ba-1.7.1/with-hooks.mjs:33:createWithHooks-after",
    packageFile: "better-auth/dist/db/with-hooks.mjs",
    line: 33,
    site: "createWithHooks → *.create.after databaseHooks",
    disposition: { reason: "unregistered-database-hook" },
  },
  {
    hookId: "ba-1.7.1/with-hooks.mjs:69:updateWithHooks-after",
    packageFile: "better-auth/dist/db/with-hooks.mjs",
    line: 69,
    site: "updateWithHooks → *.update.after databaseHooks",
    disposition: { reason: "unregistered-database-hook" },
  },
  {
    hookId: "ba-1.7.1/with-hooks.mjs:105:updateManyWithHooks-after",
    packageFile: "better-auth/dist/db/with-hooks.mjs",
    line: 105,
    site: "updateManyWithHooks → *.update.after databaseHooks",
    disposition: { reason: "unregistered-database-hook" },
  },
  {
    hookId: "ba-1.7.1/with-hooks.mjs:142:deleteWithHooks-after",
    packageFile: "better-auth/dist/db/with-hooks.mjs",
    line: 142,
    site: "deleteWithHooks → *.delete.after databaseHooks",
    disposition: { reason: "unregistered-database-hook" },
  },
  {
    hookId: "ba-1.7.1/with-hooks.mjs:178:deleteManyWithHooks-after",
    packageFile: "better-auth/dist/db/with-hooks.mjs",
    line: 178,
    site: "deleteManyWithHooks → *.delete.after databaseHooks",
    disposition: { reason: "unregistered-database-hook" },
  },
  {
    hookId: "ba-1.7.1/with-hooks.mjs:234:consumeOneWithHooks-after",
    packageFile: "better-auth/dist/db/with-hooks.mjs",
    line: 234,
    site: "consumeOneWithHooks → *.delete.after databaseHooks",
    disposition: { reason: "unregistered-database-hook" },
  },
];

export interface TransactionBoundBaOptions {
  /**
   * Builds the fixed-version Better Auth adapter bound to exactly this open
   * transaction. The caller (the test harness now, the production executor
   * later) knows which adapter factory and resolved options the fixed
   * packages need; the binding itself must not import a Better Auth plugin
   * or a database driver.
   */
  readonly createTxAdapter: (tx: DirectoryTx) => unknown;
  /** Savepoint name prefix; the run appends a per-instance counter. */
  readonly savepointPrefix?: string;
}

interface HookStore {
  adapter: unknown;
  pendingHooks: Array<() => Promise<void>>;
  isTransactionActive: boolean;
}

/** One stack frame of a registration stack: normalized file plus line. */
interface SourceFrame {
  file: string;
  line: number;
}

/** The classification verdict for one captured registration stack. */
export interface HookRegistrationVerdict {
  /** The frame that queued the hook, for the refusal message. */
  readonly frame: string;
  /** The registry entry that frame matched, or undefined when unclassified. */
  readonly entry?: HookSourceClassification;
}

/**
 * A stable key for one stack-frame path, across every install layout of the
 * fixed packages — the workspace's node_modules/.bun farm (scoped spellings
 * like `@better-auth+core@1.7.1+hash/node_modules/@better-auth/core/…`), its
 * symlinks, and Bun's global cache (`better-auth@1.7.1+hash/dist/…`): the
 * segment before the last `/dist/` always ends with the package's short name
 * (version markers stripped), so the key is `<short-name>/dist/<tail>` —
 * `better-auth/dist/db/internal-adapter.mjs` or
 * `core/dist/context/transaction.mjs`. A path with no `/dist/` keeps its raw
 * spelling and can never match a registry entry.
 */
function frameKeyOf(rawPath: string): string {
  const path = rawPath.replace(/\\/g, "/");
  const at = path.lastIndexOf("/dist/");
  if (at === -1) return path;
  const segmentStart = path.lastIndexOf("/", at - 1) + 1;
  const segment = path.slice(segmentStart, at);
  const shortName = segment.replace(/@[^/]*$/, "");
  return `${shortName}${path.slice(at)}`;
}

/** The first frame outside this file and the core queue machinery, if any. */
function registeringFrame(stack: string): SourceFrame | undefined {
  for (const line of stack.split("\n").slice(1)) {
    const location = /\(?([^() ]+):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!location) continue;
    const key = frameKeyOf(location[1]);
    if (key.endsWith("/transaction-adapter.ts")) continue;
    if (key === "core/dist/context/transaction.mjs") continue;
    return { file: key, line: Number(location[2]) };
  }
  return undefined;
}

/**
 * Classifies one captured registration stack against the registry. Exported
 * for the suite's registry pin: classification reads the registering frame
 * (fixed package file + line), never the closure text.
 */
export function classifyHookRegistration(
  stack: string,
): HookRegistrationVerdict {
  const frame = registeringFrame(stack);
  const described = frame ? `${frame.file}:${frame.line}` : "<no frame>";
  const entry =
    frame === undefined
      ? undefined
      : BA_HOOK_SOURCE_REGISTRY.find(
          (candidate) =>
            candidate.packageFile === frame.file &&
            candidate.line === frame.line,
        );
  return { frame: described, entry };
}

const DISPOSITION_REFUSALS: Record<string, { code: string; detail: string }> = {
  "unregistered-database-hook": {
    code: UNREGISTERED_DATABASE_HOOK,
    detail:
      "user-declared databaseHooks run arbitrary code after commit (seedRole, recordProvisioned, stampSignIn, applyConfiguredAdmin and anything added later); the fixed factory registers none, so any registration is refused before commit — global-connection writes from an after-hook can never be part of a committing command",
  },
  "notification-without-outbox-takeover": {
    code: NOTIFICATION_HOOK_WITHOUT_OUTBOX_TAKEOVER,
    detail:
      "dispatchVerificationEmail sends real mail from a deferred hook; notifications may only be delivered by the transactional outbox (finalizer writes the intent, a post-commit worker sends), so this source is refused until the outbox takeover is wired",
  },
  "cache-write-with-forbidden-storage": {
    code: CACHE_HOOK_WITH_FORBIDDEN_STORAGE,
    detail:
      "deleteCachedUserSessions and the deferred session mirror write the secondaryStorage cache; the §3.1 factory hard preconditions forbid configuring it, so this source registering at all means the configuration gate was bypassed",
  },
};

/**
 * The §3.1 factory hard preconditions (T01.04): the authority factory runs on
 * exactly the transaction database — no secondaryStorage, no cookie cache,
 * session and verification rows in the DB. A contrary configuration would let
 * the two internal cache sources register cache-writing hooks the fence must
 * never drain, so it is refused here, before any route runs.
 */
export function assertBaAuthorityPreconditions(
  options: BaAuthorityOptionsView,
): void {
  const violations: string[] = [];
  if (options.secondaryStorage) {
    violations.push("secondaryStorage is configured");
  }
  if (options.session?.cookieCache?.enabled) {
    violations.push("session.cookieCache.enabled is true");
  }
  if (options.session?.storeSessionInDatabase !== true) {
    violations.push("session.storeSessionInDatabase is not true");
  }
  if (options.verification?.storeInDatabase !== true) {
    violations.push("verification.storeInDatabase is not true");
  }
  if (violations.length > 0) {
    throw new Error(
      `${BA_AUTHORITY_CONFIG_VIOLATION}: the BA authority factory hard preconditions (interfaces §3.1) are violated — ${violations.join("; ")}; refusing before any route runs: the internal cache sources this configuration enables register cache-writing post-commit hooks the hook fence must never drain`,
    );
  }
}

/**
 * The SQLSTATE of `error` or of the nearest `cause` in its chain. Drivers
 * disagree on where it lives: node-postgres puts it in `code`, Bun's SQL in
 * `errno` (its `code` is the generic `ERR_POSTGRES_SERVER_ERROR`); the 5-char
 * shape keeps both honest and ignores the generic labels.
 */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (typeof code === "string" && SQLSTATE.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Wraps the transaction adapter so the first SQLSTATE-raising failure the
 * fixed package meets is remembered. Reads go through the same wrapper: a
 * failing read inside the aborted transaction is just as much "the first
 * error" as a failing write.
 */
function instrumentAdapter(adapter: unknown): {
  adapter: unknown;
  firstSqlError: () => unknown;
} {
  let first: unknown;
  const wrapped = new Proxy(adapter as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await (value as (...inner: unknown[]) => unknown).apply(
            target,
            args,
          );
        } catch (error) {
          if (first === undefined && sqlStateOf(error)) first = error;
          throw error;
        }
      };
    },
  });
  return { adapter: wrapped, firstSqlError: () => first };
}

/**
 * A compensation write on the aborted transaction surfaces 25P02; the caller
 * gets the first SQLSTATE the command actually hit instead. Any other failure
 * is rethrown untouched: replacing a deliberate business error with an earlier
 * error a package caught internally would be a different bug.
 */
function preferFirstSqlState(error: unknown, first: unknown): unknown {
  if (
    first !== undefined &&
    sqlStateOf(error) === TRANSACTION_ABORTED_SQLSTATE
  ) {
    return first;
  }
  return error;
}

/**
 * The store's pendingHooks queue with the registration stack captured at push
 * time. Only the core queue machinery pushes here (`queueAfterTransactionHook`
 * under the store this run installs); the captured stack is what the
 * classification reads, so the fence never guesses from closure text.
 */
class HookQueue extends Array<() => Promise<void>> {
  readonly registrations: string[] = [];

  push(...hooks: Array<() => Promise<void>>): number {
    for (let index = 0; index < hooks.length; index += 1) {
      this.registrations.push(new Error().stack ?? "");
    }
    return super.push(...hooks);
  }
}

export function createTransactionBoundBa(
  options: TransactionBoundBaOptions,
): TransactionBoundBa {
  let savepointCounter = 0;
  const prefix = options.savepointPrefix ?? "ba_command";

  const rollbackToSavepoint = async (
    tx: DirectoryTx,
    savepoint: string,
  ): Promise<void> => {
    // ROLLBACK TO is legal on an aborted transaction and restores it to a
    // usable state; releasing after it keeps the savepoint stack clean.
    await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${savepoint}`));
    await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
  };

  return {
    async run<T>(
      tx: DirectoryTx,
      operation: () => Promise<T>,
    ): Promise<BaTxOutcome<T>> {
      const als = await getCurrentDBAdapterAsyncLocalStorage();
      const instrumented = instrumentAdapter(options.createTxAdapter(tx));
      const pendingHooks = new HookQueue();
      const store: HookStore = {
        adapter: instrumented.adapter,
        pendingHooks,
        isTransactionActive: true,
      };

      savepointCounter += 1;
      const savepoint = `${prefix}_${savepointCounter}`;
      await tx.execute(sql.raw(`SAVEPOINT ${savepoint}`));

      let value: T;
      try {
        value = await als.run(store as never, operation);
      } catch (error) {
        await rollbackToSavepoint(tx, savepoint);
        throw preferFirstSqlState(error, instrumented.firstSqlError());
      }

      /*
       * A swallowed error (the fixed package's runInBackgroundOrAwait catches
       * callback failures, so a failed email dispatch aborts the transaction
       * while the command reports success) leaves the transaction dead: a
       * probe statement answers 25P02 before the fence could ever observe it.
       * Probe now, with the savepoint still open: on an aborted transaction,
       * restore the savepoint and refuse with the first SQLSTATE the command
       * actually recorded as the cause — the executor's fence then decides
       * with the original error, never a bare 25P02.
       */
      try {
        await tx.execute(sql`select 1`);
      } catch (error) {
        if (sqlStateOf(error) === TRANSACTION_ABORTED_SQLSTATE) {
          await rollbackToSavepoint(tx, savepoint);
          const first = instrumented.firstSqlError();
          throw new Error(
            `${SWALLOWED_ERROR_ABORTED_TRANSACTION}: the operation returned but its transaction is aborted — an error the fixed package swallowed poisoned it; rolling the command back`,
            first === undefined ? undefined : { cause: first },
          );
        }
        throw error;
      }

      /*
       * Classify every registration while the savepoint is still open, so a
       * refusal rolls the command back to it; only a fully classified queue
       * releases the savepoint and returns.
       */
      const classified: PostCommitHook[] = [];
      for (
        let index = 0;
        index < pendingHooks.registrations.length;
        index += 1
      ) {
        const verdict = classifyHookRegistration(
          pendingHooks.registrations[index],
        );
        const entry = verdict.entry;
        if (entry === undefined) {
          await rollbackToSavepoint(tx, savepoint);
          throw new Error(
            `${UNCLASSIFIED_POST_COMMIT_HOOK}: the pinned better-auth build registered a deferred post-commit hook from an unregistered source (${verdict.frame}); refusing to commit the command — every queueAfterTransactionHook call site in the fixed build must be classified in BA_HOOK_SOURCE_REGISTRY before it may commit`,
          );
        }
        const disposition = entry.disposition;
        if ("reason" in disposition) {
          const refusal = DISPOSITION_REFUSALS[disposition.reason];
          await rollbackToSavepoint(tx, savepoint);
          throw new Error(
            `${refusal.code}: ${entry.site} (${verdict.frame}) registered a deferred post-commit hook — ${refusal.detail}`,
          );
        }
        if (disposition.kind === "notification-outbox-takeover") {
          /*
           * The conversion (T04.04): run the deferred notification closure
           * right here, inside the still-open transaction, so the
           * factory-wired controlled sender it calls registers the
           * encrypted outbox intent and its receipt on this command — the
           * pre-commit completion fence then decides with the real facts.
           * The closure is never queued for the post-commit drain: a
           * committed command delivers only through the outbox worker, and
           * a failure here rolls the command back to this savepoint.
           */
          try {
            await pendingHooks[index]();
          } catch (error) {
            await rollbackToSavepoint(tx, savepoint);
            throw preferFirstSqlState(error, instrumented.firstSqlError());
          }
          continue;
        }
        classified.push({
          hookId: `${entry.hookId}#${index + 1}`,
          kind: disposition.kind,
          run: pendingHooks[index],
        });
      }

      await tx.execute(sql.raw(`RELEASE SAVEPOINT ${savepoint}`));
      return { value, pendingHooks: classified };
    },
  };
}
