import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type { DirectoryTx } from "../../src/auth/directory/contracts";

/*
 * T02.12 (#534, original task P04) — the transactional notification outbox
 * and the mail-callback completion receipt fence, checked against the real
 * T02.03 command model and the real T02.06 controlled write path on the
 * isolated BA_TEST_* stack (interfaces §3.1 notification table, §5.1;
 * acceptance F3/H1).
 *
 * What this file pins, and why each part is a database fact rather than a
 * code convention:
 *
 * - `outbox_is_not_delivered_before_commit`: a mail intent enqueued inside
 *   the command's open transaction is invisible to the delivery worker on
 *   its own connection until the commit lands — nothing is sent before
 *   commit, the committed intent is delivered exactly once under its stable
 *   event key, and a second drain adds no second send.
 * - `late_or_failed_callback_cannot_leave_token_without_intent`: a
 *   notification callback whose conversion failed — the error Better Auth's
 *   runInBackgroundOrAwait swallows — leaves a token fact in the fence
 *   ledger with no completed receipt. The pre-commit fence refuses the
 *   commit with the preserved original error as its cause, so the rollback
 *   takes the verification token and every half-written intent with it: the
 *   durable token count and intent count agree (both zero). A callback that
 *   arrives after the transaction settled (the deferred link-account
 *   closure's shape) is refused before any write or send, and a command that
 *   created no token (the unknown-email reset request) commits cleanly with
 *   no receipt required.
 * - `deferred_link_account_notification_becomes_atomic_outbox_intent`: the
 *   controlled notification conversion of the link-account verification
 *   payload — the exact {user, url, token} shape the pinned build's
 *   dispatchVerificationEmail hands its sender — registers exactly one
 *   durable intent inside the command: it survives the commit, disappears on
 *   rollback, and neither the conversion nor the queueing phase sends
 *   anything externally. The URL and the token are sealed in the payload at
 *   rest, and the sealed envelope round-trips under the outbox's own key.
 * - `mail_intent_requires_open_command_and_stable_event_key`: the enqueue
 *   contract refuses to run without an open command (the controlled
 *   append function's own guard surfaces as a named refusal), refuses an
 *   unusable event key before any statement, and turns a duplicate
 *   committed event key into a named idempotency refusal instead of a
 *   second row.
 * - `delivery_failure_never_decides_admission_and_retries`: a failing
 *   delivery is reported and the row is left retryable; the committed
 *   command's durable state is untouched — a notification never decides
 *   admission — and a later drain delivers the same intent under the same
 *   stable key without double-sending.
 *
 * Boundaries this suite deliberately does not claim (later tasks own them):
 * the factory wiring of the controlled sender into the fixed package's
 * emailVerification.sendVerificationEmail and the real AuthMailDelivery
 * provider (T04.04/P08, interfaces §5.1); the hook-source classification
 * that refuses the un-wired link-account source before commit (T01.04's
 * transaction-hooks suite); role separation of the controlled functions
 * (T02.06's schema-roles suite); and the command envelope itself — lock
 * order, finalizer and audit (T02.08). Here the executor's command protocol
 * is driven directly over the real tables, exactly as the schema suites
 * drive begin/finalize.
 *
 * The five BA_TEST_* URLs are all required (presence and same-instance
 * shape); a missing one is a blocked suite, never a silent fallback to the
 * shared, MT or job-level database. No DSN is ever printed — refusals name
 * the variable.
 */

const DATABASE_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_URL_VARIABLES = [
  DATABASE_VARIABLE,
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/*
 * The verified BA stack the outbox rides on, applied by this suite and
 * removed again at cleanup — the same discipline every schema suite on the
 * island follows (the shared database carries the enterprise baseline only).
 */
const MIGRATION_TAGS = [
  "0209_better_auth_directory",
  "0210_better_auth_clocks",
  "0211_better_auth_command_authority",
  "0212_better_auth_authority_sources",
  "0213_better_auth_assurance",
  "0214_better_auth_schema_roles",
] as const;
const MIGRATION_PATHS = MIGRATION_TAGS.map((tag) =>
  join(import.meta.dirname, `../../drizzle/${tag}.sql`),
);
/** Every BA table the applied stack creates, dropped again at cleanup. */
const BA_TABLES = [
  "auth_company_session_assurances",
  "auth_company_auth_challenges",
  "auth_team_management_grants",
  "auth_provisioning_rules",
  "auth_command_outbox",
  "auth_command_change_keys",
  "auth_command_receipts",
  "auth_authority_states",
  "auth_eligibility_clocks",
  "auth_invitations",
  "auth_team_members",
  "auth_members",
  "auth_team_bindings",
  "auth_teams",
  "auth_organizations",
] as const;
/** The controlled functions the stack installs, with signatures. */
const CONTROLLED_FUNCTIONS = [
  "auth_directory_begin_command(text,text,text,text,text,text,text,text,text)",
  "auth_directory_finalize_command(text)",
  "auth_command_append_outbox(text,text,text,text)",
  "auth_principals_register(text,text,text)",
  "auth_project_company_membership(text,text,text,text,integer,text)",
  "auth_advance_eligibility_clock(text,text,text,text,bigint,bigint,boolean,text)",
  "auth_read_eligibility_clocks(text,text)",
  "auth_read_session_assurances(text,text)",
  "auth_directory_dml_guard()",
  "auth_directory_commit_fence()",
  "auth_directory_guard_principal(text)",
] as const;
/** The guard/fence triggers, dropped by (table, name) at cleanup. */
const MIGRATION_TRIGGERS = [
  ["auth_members", "auth_directory_dml_guard"],
  ["auth_team_members", "auth_directory_dml_guard"],
  ["auth_team_bindings", "auth_directory_dml_guard"],
  ["auth_organizations", "auth_directory_dml_guard"],
  ["auth_teams", "auth_directory_dml_guard"],
  ["auth_invitations", "auth_directory_dml_guard"],
  ["auth_command_receipts", "auth_command_receipt_fence"],
  ["auth_command_change_keys", "auth_change_key_fence"],
  ["auth_team_members", "auth_team_member_orphan_fence"],
  ["auth_members", "auth_member_orphan_fence"],
] as const;

const USER = "t0212-user";
const USER_EMAIL = "t0212-user@example.test";
const PAYLOAD_SECRET = "t0212-outbox-payload-secret-not-a-credential";

function shapeOf(variable: string, raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback PostgreSQL URL.`);
  }
  let database = "";
  try {
    database = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(/\/+$/, ""),
    );
  } catch {
    throw new Error(`${variable} carries invalid percent-encoding.`);
  }
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must name a loopback openbot_enterprise_* database.`,
    );
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return { endpoint: `${host}:${url.port || "5432"}`, database };
}

function readBaUrls(): string {
  const shapes = new Map<string, string>();
  for (const variable of BA_URL_VARIABLES) {
    const raw = process.env[variable]?.trim();
    if (!raw) {
      throw new Error(
        `${variable} is required: a better-auth DB suite runs only on its five BA_TEST_* role URLs and never inherits TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; a missing URL is blocked, not a fallback.`,
      );
    }
    shapes.set(variable, shapeOf(variable, raw).endpoint);
  }
  const reference = [...shapes.entries()].find(
    ([variable]) => variable === DATABASE_VARIABLE,
  )![1];
  for (const [variable, endpoint] of shapes) {
    if (endpoint !== reference) {
      throw new Error(
        `${variable} must name the same PostgreSQL instance as ${DATABASE_VARIABLE}.`,
      );
    }
  }
  return process.env[DATABASE_VARIABLE]!.trim();
}

/**
 * Returns the island to the pre-BA shape: this suite's triggers, functions,
 * role grants, tables and seeded rows gone. Every statement is a no-op on a
 * pristine baseline, and it recovers a crashed earlier run that left any of
 * them behind. The cluster-wide ob_ent_auth_writer capability role is NOT
 * dropped — the environment's provisioning owns it.
 */
async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  const triggerPairs = MIGRATION_TRIGGERS.map(
    ([table, trigger]) => `('${table}', '${trigger}')`,
  ).join(", ");
  const functions = CONTROLLED_FUNCTIONS.map(
    (signature) => `('${signature}')`,
  ).join(", ");
  const tables = BA_TABLES.map((name) => `('${name}')`).join(", ");
  await sql.unsafe(`
    DO $t0212_cleanup$
    DECLARE
      target record;
    BEGIN
      FOR target IN SELECT * FROM (VALUES ${triggerPairs}) AS triggers(table_name, trigger_name) LOOP
        IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
          EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target.trigger_name, target.table_name);
        END IF;
      END LOOP;
      FOR target IN SELECT * FROM (VALUES ${functions}) AS functions(signature) LOOP
        EXECUTE format('DROP FUNCTION IF EXISTS public.%s', target.signature);
      END LOOP;
      FOR target IN SELECT * FROM (VALUES ${tables}) AS tables(table_name) LOOP
        IF to_regclass('public.' || target.table_name) IS NOT NULL THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM ob_ent_directory, ob_ent_data, ob_ent_operator, ob_ent_identity_operator, ob_ent_auth_writer', target.table_name);
        END IF;
      END LOOP;
    END
    $t0212_cleanup$`);
  await sql.unsafe(
    `DROP TABLE IF EXISTS ${BA_TABLES.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
  // The clock/authority prerequisites ALTER existing enterprise tables, so a
  // crashed earlier run can leave their columns behind — the same
  // normalization the sibling schema suites perform.
  await sql.unsafe(
    `ALTER TABLE "enterprise_principals" DROP COLUMN IF EXISTS "identity_generation"`,
  );
  for (const [table, constraint] of [
    ["enterprise_credentials", "enterprise_credential_owner_generation_pair"],
    [
      "enterprise_credential_actions",
      "enterprise_credential_action_generation_pair",
    ],
    [
      "billing_company_finance_grants",
      "billing_company_finance_grant_generation_pair",
    ],
    ["access_grants", "access_grants_principal_generation_pair"],
    ["access_grants", "access_grants_identity_generation_safe_integer"],
    ["access_grants", "access_grants_principal_fk"],
  ] as const) {
    await sql.unsafe(
      `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`,
    );
  }
  for (const [table, column] of [
    ["enterprise_credentials", "owner_identity_generation"],
    ["enterprise_credentials", "owner_company_generation"],
    ["enterprise_credential_actions", "identity_generation"],
    ["enterprise_credential_actions", "company_generation"],
    ["enterprise_credential_actions", "source_team_generation"],
    ["billing_company_finance_grants", "identity_generation"],
    ["billing_company_finance_grants", "company_generation"],
    ["access_grants", "principal_id"],
    ["access_grants", "identity_generation"],
    ["gateway_virtual_keys", "source_identity_generation"],
  ] as const) {
    await sql.unsafe(
      `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`,
    );
  }
  await sql`DELETE FROM verifications WHERE id LIKE 't0212-%'`;
  await sql`DELETE FROM users WHERE id LIKE 't0212-%'`;
}

interface Harness {
  sql: postgres.Sql;
  db: {
    transaction: (fn: (trx: unknown) => Promise<unknown>) => Promise<unknown>;
  };
  /** A fresh setup connection for the after-close leak probe. */
  probe(): postgres.Sql;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const setupUrl = readBaUrls();
  const sql = postgres(setupUrl, {
    max: 2,
    idle_timeout: 5,
    onnotice: () => {},
  });
  try {
    await cleanupFixture(sql);
    for (const path of MIGRATION_PATHS) {
      if (!existsSync(path)) {
        throw new Error(
          `${path} does not exist: the transactional outbox sits on the verified T02.01–T02.06 stack, and a missing prerequisite is a workspace problem, not a target behavior.`,
        );
      }
      await sql.unsafe(readFileSync(path, "utf8"));
    }
    await sql`INSERT INTO users (id, email) VALUES (${USER}, ${USER_EMAIL})`;

    // The executor-shaped transaction handle: a Drizzle transaction over
    // Bun's SQL client — the frozen DirectoryTx — on the island's owner
    // connection. The controlled-function capability check is satisfied for
    // the owner; the writer-role exclusivity of those functions is T02.06's
    // proof, not this suite's subject.
    const client = new SQL(setupUrl, {
      max: 2,
      idleTimeout: 5,
      connectionTimeout: 10_000,
      onnotice: () => {},
    });
    const db = drizzle({ client });

    return {
      sql,
      db,
      probe: () =>
        postgres(setupUrl, { max: 1, idle_timeout: 5, onnotice: () => {} }),
      close: async () => {
        try {
          await cleanupFixture(sql);
        } finally {
          await Promise.allSettled([sql.end({ timeout: 5 }), client.close()]);
        }
      },
    };
  } catch (error) {
    await cleanupFixture(sql).catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    throw error;
  }
}

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await createHarness();
}, 120_000);

afterAll(async () => {
  if (!harness) return;
  await harness.close();
  // The same after-close check the fixture contract established, on a fresh
  // short-lived connection so the probe works after close() released the
  // harness's own pools: a future change that strands a BA object in the
  // shared island fails here instead of quietly piling up per-run objects.
  const sql = harness.probe();
  try {
    const leaked = await sql`
      SELECT nspname AS resource FROM pg_namespace WHERE nspname LIKE 't0212%'
      UNION ALL
      SELECT n.nspname || '.' || c.relname AS resource
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY(${[...BA_TABLES]}::text[])
      UNION ALL
      SELECT 'verifications:' || id FROM verifications WHERE id LIKE 't0212-%'
      UNION ALL
      SELECT 'users:' || id FROM users WHERE id LIKE 't0212-%'`;
    expect(leaked).toEqual([]);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
});

/*
 * The T02.12 target module, loaded lazily so a worktree without it still
 * collects (and fails) every case with a message naming the missing target
 * behavior instead of dying at import time as a zero-case collection error.
 */
type OutboxModule = typeof import("../../src/auth/directory/outbox");
let outboxPromise: Promise<OutboxModule> | undefined;
function loadOutbox(): Promise<OutboxModule> {
  outboxPromise ??= import("../../src/auth/directory/outbox").catch(
    (error: unknown) => {
      throw new Error(
        `server/src/auth/directory/outbox.ts is not loadable — ${error instanceof Error ? error.message : String(error)}: the transactional notification outbox, the mail-callback completion fence and the post-commit delivery this suite pins are the T02.12 target behavior, not an environment problem.`,
      );
    },
  );
  return outboxPromise;
}

/** The outbox services this suite wires, created once the module loads. */
interface OutboxServices {
  enqueue(tx: unknown, intent: unknown): Promise<unknown>;
  createFence(tx: unknown, commandId: string): unknown;
  settle(fence: unknown, outcome: "committed" | "rolled-back"): void;
  sender(options: {
    tx: unknown;
    fence: unknown;
    kind?: string;
    subject?: string;
    eventKey?: string;
  }): (payload: unknown, request?: unknown) => Promise<unknown>;
  assertCompletion(tx: unknown, fence: unknown): Promise<void>;
  openPayload(sealed: string): Record<string, unknown> | null;
  drain(deps: {
    query: (
      text: string,
      params?: unknown[],
    ) => Promise<Record<string, unknown>[]>;
    send: (
      request: Record<string, unknown>,
    ) => Promise<{ providerMessageId: string }>;
    limit?: number;
    attempts?: number;
  }): Promise<{
    considered: number;
    delivered: number;
    failed: { id: string; error: string }[];
  }>;
}

async function services(): Promise<OutboxServices> {
  const outbox = await loadOutbox();
  const instance = outbox.createAuthMailOutbox({
    payloadSecret: PAYLOAD_SECRET,
  });
  return {
    enqueue: (tx, intent) =>
      instance.enqueueAuthMailIntent(tx as never, intent as never),
    createFence: (tx, commandId) =>
      outbox.createMailCallbackFence(tx as never, commandId),
    settle: (fence, outcome) =>
      outbox.settleMailCallbackFence(fence as never, outcome),
    sender: (options) =>
      instance.createControlledMailSender({
        tx: options.tx as never,
        fence: options.fence as never,
        kind: (options.kind ?? "link-account.verify") as never,
        subject: options.subject ?? "Verify your email",
        eventKey: options.eventKey,
      }),
    assertCompletion: (tx, fence) =>
      outbox.assertMailCallbackCompletion(tx as never, fence as never),
    openPayload: (sealed) => instance.openSealedPayload(sealed) as never,
    drain: (deps) => instance.drainAuthMailOutbox(deps as never) as never,
  };
}

/** The refusal code an OUTBOX_* error carries, or undefined for others. */
function outboxCodeOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  return /^OUTBOX_[A-Z0-9_]+/.exec(message)?.[0];
}

let commandCounter = 0;
function uniqueCommandId(): string {
  commandCounter += 1;
  return `t0212-cmd-${process.pid}-${commandCounter}`;
}

/**
 * The executor's command protocol, driven directly over the controlled
 * functions exactly as the schema suites drive begin/finalize: the marker is
 * the caller's statement, the receipt is the begin function's, and the
 * deferred receipt fence at commit demands the finalize.
 */
async function beginCommand(tx: DirectoryTx, commandId: string): Promise<void> {
  await tx.execute(dsql`SELECT set_config('auth.current_command',
    public.auth_directory_begin_command(
      ${commandId}, 'identity', 'identity.notify', null, ${USER}, ${USER},
      'session', ${`t0212-idem-${commandId}`}, ${`t0212-hash-${commandId}`}),
    true)`);
}

async function finalizeCommand(
  tx: DirectoryTx,
  commandId: string,
): Promise<void> {
  await tx.execute(
    dsql`SELECT public.auth_directory_finalize_command(${commandId})`,
  );
  await tx.execute(dsql`SELECT set_config('auth.current_command', '', true)`);
  await tx.execute(dsql`SET CONSTRAINTS ALL IMMEDIATE`);
}

/** The durable token fact: one verification row per dispatched mail, its id derived from the token so each command's fact is unique. */
async function createVerificationToken(
  tx: DirectoryTx,
  token: string,
): Promise<void> {
  await tx.execute(dsql`
    INSERT INTO verifications (id, identifier, value, expires_at)
    VALUES (${`t0212-v-${token}`}, ${USER_EMAIL}, ${token}, now() + interval '1 hour')`);
}

async function countIntents(
  sql: postgres.Sql,
  commandId?: string,
): Promise<number> {
  const [row] = commandId
    ? await sql`SELECT count(*)::int AS count FROM auth_command_outbox WHERE command_id = ${commandId}`
    : await sql`SELECT count(*)::int AS count FROM auth_command_outbox`;
  return Number(row?.count ?? 0);
}

async function countTokens(sql: postgres.Sql, token: string): Promise<number> {
  const [row] = await sql`
    SELECT count(*)::int AS count FROM verifications WHERE value = ${token}`;
  return Number(row?.count ?? 0);
}

async function outboxRows(
  sql: postgres.Sql,
  commandId: string,
): Promise<{ id: string; kind: string; payload: string; status: string }[]> {
  return sql`
    SELECT id, kind, payload, status FROM auth_command_outbox
     WHERE command_id = ${commandId}`;
}

/** The external delivery seam: a spy provider with injectable failures. */
function createDeliverySpy() {
  const sent: Record<string, unknown>[] = [];
  let failuresLeft = 0;
  return {
    sent,
    failNextSends(count: number): void {
      failuresLeft = count;
    },
    send: async (request: Record<string, unknown>) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("injected delivery failure (t0212)");
      }
      sent.push(request);
      return {
        providerMessageId: `t0212-prov-${String(request.idempotencyKey)}`,
      };
    },
  };
}

function drainWith(spy: ReturnType<typeof createDeliverySpy>) {
  return async (sql: postgres.Sql, svc: OutboxServices) =>
    svc.drain({
      query: (text, params) => sql.unsafe(text, params),
      send: spy.send,
    });
}

/**
 * Delivers whatever an earlier case left pending, with a throwaway sender:
 * delivery state is durable table state shared by the whole suite, so each
 * case starts from an empty worker queue and asserts only on its own rows.
 */
async function flushPending(
  sql: postgres.Sql,
  svc: OutboxServices,
): Promise<void> {
  await svc.drain({
    query: (text, params) => sql.unsafe(text, params),
    send: async () => ({ providerMessageId: "t0212-flush" }),
  });
}

const linkAccountPayload = (token: string) => ({
  user: { id: USER, email: USER_EMAIL, name: "T02.12 User" },
  url: `http://127.0.0.1:1/verify-email?token=${token}&callbackURL=%2F`,
  token,
});

test("outbox_is_not_delivered_before_commit", async () => {
  const svc = await services();
  const sql = harness!.sql;
  await flushPending(sql, svc);
  const spy = createDeliverySpy();
  const drain = drainWith(spy);
  const commandId = uniqueCommandId();
  const token = `t0212-token-pre-commit`;

  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const transaction = harness!.db.transaction(async (trx) => {
    const tx = trx as never as DirectoryTx;
    await beginCommand(tx, commandId);
    await createVerificationToken(tx, token);
    const fence = svc.createFence(tx, commandId);
    // The executor observes the token the native step created, then the
    // controlled sender converts the notification — both inside the open
    // command transaction.
    (fence as { observeTokenCreated(t: string): void }).observeTokenCreated(
      token,
    );
    await svc
      .sender({ tx, fence, eventKey: `${commandId}:pre-commit` })(
        linkAccountPayload(token),
      )
      .catch(() => {
        /* the fixed package swallows callback errors; the fence owns them */
      });
    await gate;
    await finalizeCommand(tx, commandId);
  });

  // While the command transaction is still open, the delivery worker on
  // its own connection can see no committed intent: nothing is sent.
  await drain(sql, svc);
  const sentBeforeCommit = [...spy.sent];
  expect(sentBeforeCommit).toHaveLength(0);

  releaseGate!();
  let failure: unknown;
  const committed = await transaction
    .then(() => true)
    .catch((error: unknown) => {
      failure = error;
      return false;
    });
  expect(
    committed,
    `the fenced command must commit; got ${failure instanceof Error ? failure.message : String(failure)}`,
  ).toBe(true);
  expect(await countIntents(sql, commandId)).toBe(1);

  const first = await drain(sql, svc);
  expect(first.delivered).toBe(1);
  expect(spy.sent).toHaveLength(1);
  expect(spy.sent[0]!.idempotencyKey).toBe(`${commandId}:pre-commit`);
  expect(spy.sent[0]!.url).toBe(linkAccountPayload(token).url);

  // Idempotent delivery: the delivered row is terminal, a second drain
  // adds no second send under the same stable key.
  const second = await drain(sql, svc);
  expect(second.delivered).toBe(0);
  expect(spy.sent).toHaveLength(1);
  const rows = await outboxRows(sql, commandId);
  expect(rows[0]!.status).toBe("delivered");
}, 120_000);

test("late_or_failed_callback_cannot_leave_token_without_intent", async () => {
  const svc = await services();
  const sql = harness!.sql;
  await flushPending(sql, svc);
  const spy = createDeliverySpy();

  // Pre-arm: one committed intent under the event key the failed arm will
  // collide with, so the conversion inside the next command hits a real
  // database idempotency refusal — the shape a mid-command callback
  // failure takes in production.
  const preCommand = uniqueCommandId();
  const collisionKey = `${preCommand}:collision`;
  await harness!.db.transaction(async (trx) => {
    const tx = trx as never as DirectoryTx;
    await beginCommand(tx, preCommand);
    await svc.enqueue(tx, {
      commandId: preCommand,
      kind: "link-account.verify",
      eventKey: collisionKey,
      userId: USER,
      to: USER_EMAIL,
      subject: "Verify your email",
      url: "http://127.0.0.1:1/verify-email?token=pre",
      token: "t0212-token-pre",
    });
    await finalizeCommand(tx, preCommand);
  });

  // The failed-callback arm: the token exists, the conversion fails, the
  // package swallows the error, and the pre-commit fence refuses the
  // commit with the preserved original error — so the rollback leaves no
  // token without an intent.
  const failedCommand = uniqueCommandId();
  const failedToken = `t0212-token-failed`;
  let fenceRefusal: unknown;
  const committed = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, failedCommand);
      await createVerificationToken(tx, failedToken);
      const fence = svc.createFence(tx, failedCommand);
      (fence as { observeTokenCreated(t: string): void }).observeTokenCreated(
        failedToken,
      );
      await svc
        .sender({ tx, fence, eventKey: collisionKey })(
          linkAccountPayload(failedToken),
        )
        .catch(() => {
          /* runInBackgroundOrAwait swallows the callback error here */
        });
      await svc.assertCompletion(tx, fence);
      await finalizeCommand(tx, failedCommand);
      return true;
    })
    .catch((error: unknown) => {
      fenceRefusal = error;
      return false;
    });
  expect(committed).toBe(false);
  expect(outboxCodeOf(fenceRefusal)).toBe("OUTBOX_CALLBACK_INCOMPLETE");
  // The original callback error is preserved as the refusal's cause,
  // never masked by the fence's own refusal.
  const cause = (fenceRefusal as { cause?: unknown }).cause;
  expect(outboxCodeOf(cause)).toBe("OUTBOX_EVENT_ALREADY_REGISTERED");
  // Durable state after the refused commit: no token without an intent —
  // both sides of the pairing are gone with the rollback.
  const tokenCount = await countTokens(sql, failedToken);
  const intentCount = await countIntents(sql, failedCommand);
  expect(tokenCount).toBe(0);
  expect(intentCount).toBe(0);
  expect(tokenCount).toBe(intentCount);
  // The pre-armed intent is untouched by the failed command's rollback.
  expect(await countIntents(sql, preCommand)).toBe(1);

  // The late-callback arm: the deferred closure's shape — the sender
  // invoked after its transaction settled — refuses before any write or
  // send.
  const lateCommand = uniqueCommandId();
  const lateToken = `t0212-token-late`;
  let lateSender: ((payload: unknown) => Promise<unknown>) | undefined;
  let lateFence: unknown;
  const lateCommitted = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, lateCommand);
      await createVerificationToken(tx, lateToken);
      const fence = svc.createFence(tx, lateCommand);
      lateFence = fence;
      (fence as { observeTokenCreated(t: string): void }).observeTokenCreated(
        lateToken,
      );
      lateSender = svc.sender({ tx, fence, eventKey: `${lateCommand}:late` });
      await lateSender(linkAccountPayload(lateToken));
      await svc.assertCompletion(tx, fence);
      await finalizeCommand(tx, lateCommand);
      return true;
    })
    .catch(() => false);
  expect(lateCommitted).toBe(true);
  svc.settle(lateFence, "committed");
  const lateRefusal = await lateSender!(
    linkAccountPayload("t0212-token-late-replay"),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outboxCodeOf(lateRefusal)).toBe("OUTBOX_CALLBACK_TX_CLOSED");
  expect(spy.sent).toHaveLength(0);
  expect(await countIntents(sql, lateCommand)).toBe(1);

  // The unknown-email arm: no token was created, so no receipt is owed —
  // the fence passes and the command commits (the fixed build's
  // {status:true} contract for an unknown reset address).
  const silentCommand = uniqueCommandId();
  const silentCommitted = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, silentCommand);
      const fence = svc.createFence(tx, silentCommand);
      await svc.assertCompletion(tx, fence);
      await finalizeCommand(tx, silentCommand);
      return true;
    })
    .catch(() => false);
  expect(silentCommitted).toBe(true);
  expect(await countIntents(sql, silentCommand)).toBe(0);
}, 120_000);

test("deferred_link_account_notification_becomes_atomic_outbox_intent", async () => {
  const svc = await services();
  const sql = harness!.sql;
  await flushPending(sql, svc);
  const spy = createDeliverySpy();
  const drain = drainWith(spy);

  // The commit arm: conversion inside the open command registers exactly
  // one durable intent, sends nothing while converting or queueing, and
  // seals the URL and token at rest.
  const commitCommand = uniqueCommandId();
  const commitToken = `t0212-token-link-account`;
  const eventKey = `link-account.verify:${createHash("sha256").update(commitToken).digest("hex")}`;
  const committed = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, commitCommand);
      await createVerificationToken(tx, commitToken);
      const fence = svc.createFence(tx, commitCommand);
      (fence as { observeTokenCreated(t: string): void }).observeTokenCreated(
        commitToken,
      );
      const receipt = await svc.sender({ tx, fence })(
        linkAccountPayload(commitToken),
      );
      expect(spy.sent).toHaveLength(0);
      expect((receipt as { intentId: string }).intentId).toBe(eventKey);
      await svc.assertCompletion(tx, fence);
      await finalizeCommand(tx, commitCommand);
      return true;
    })
    .catch(() => false);
  expect(committed).toBe(true);
  const intents = await outboxRows(sql, commitCommand);
  expect(intents).toHaveLength(1);
  expect(intents[0]!.kind).toBe("link-account.verify");
  // Sealed at rest: neither the raw token nor the full URL appears in the
  // stored payload, and the envelope round-trips under the outbox's key.
  expect(intents[0]!.payload).not.toContain(commitToken);
  const payload = svc.openPayload(intents[0]!.payload);
  expect(payload?.url).toBe(linkAccountPayload(commitToken).url);
  expect(payload?.token).toBe(commitToken);
  expect(payload?.eventKey).toBe(eventKey);
  // Queueing and delivery stay external-send-free until after the commit:
  // the drain is the only thing that sends, under the stable event key.
  expect(spy.sent).toHaveLength(0);

  // The rollback arm: the same conversion inside a command that then
  // fails takes its intent with it — atomicity is the table's, not the
  // caller's discipline.
  const rollbackCommand = uniqueCommandId();
  const rollbackCommitted = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, rollbackCommand);
      const fence = svc.createFence(tx, rollbackCommand);
      await svc.sender({ tx, fence, eventKey: `${rollbackCommand}:rb` })(
        linkAccountPayload("t0212-token-rollback"),
      );
      await finalizeCommand(tx, rollbackCommand);
      throw new Error("t0212 injected command failure after conversion");
    })
    .then(() => true)
    .catch(() => false);
  expect(rollbackCommitted).toBe(false);
  expect(await countIntents(sql, rollbackCommand)).toBe(0);

  // Post-commit delivery of the committed intent: exactly one send, and
  // the delivered URL is the sealed BA-generated one.
  const report = await drain(sql, svc);
  expect(report.delivered).toBeGreaterThanOrEqual(1);
  const mine = spy.sent.filter(
    (request) => request.idempotencyKey === eventKey,
  );
  expect(mine).toHaveLength(1);
  expect(mine[0]!.url).toBe(linkAccountPayload(commitToken).url);
  expect(mine[0]!.to).toBe(USER_EMAIL);
}, 120_000);

test("mail_intent_requires_open_command_and_stable_event_key", async () => {
  const svc = await services();
  const sql = harness!.sql;
  await flushPending(sql, svc);

  // No open command: the append function's own guard surfaces as a named
  // refusal, never as a raw SQLSTATE.
  const before = await countIntents(sql);
  const closedCommand = uniqueCommandId();
  const closedRefusal = await harness!.db
    .transaction(async (trx) => {
      await svc.enqueue(trx as never as DirectoryTx, {
        commandId: closedCommand,
        kind: "link-account.verify",
        eventKey: `${closedCommand}:no-command`,
        userId: USER,
        to: USER_EMAIL,
        subject: "Verify your email",
        url: "http://127.0.0.1:1/verify-email?token=x",
        token: "t0212-token-x",
      });
      return undefined;
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(outboxCodeOf(closedRefusal)).toBe("OUTBOX_NO_OPEN_COMMAND");
  expect(await countIntents(sql)).toBe(before);

  // An unusable event key is refused before any statement.
  const keyCommand = uniqueCommandId();
  const keyRefusal = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, keyCommand);
      await svc.enqueue(tx, {
        commandId: keyCommand,
        kind: "link-account.verify",
        eventKey: "   ",
        userId: USER,
        to: USER_EMAIL,
        subject: "Verify your email",
        url: "http://127.0.0.1:1/verify-email?token=y",
        token: "t0212-token-y",
      });
      return undefined;
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(outboxCodeOf(keyRefusal)).toMatch(/^OUTBOX_INTENT_/);
  expect(await countIntents(sql)).toBe(before);

  // A duplicate committed event key under a new command is a named
  // idempotency refusal, not a second row.
  const firstCommand = uniqueCommandId();
  const sharedKey = `${firstCommand}:shared`;
  await harness!.db.transaction(async (trx) => {
    const tx = trx as never as DirectoryTx;
    await beginCommand(tx, firstCommand);
    await svc.enqueue(tx, {
      commandId: firstCommand,
      kind: "link-account.verify",
      eventKey: sharedKey,
      userId: USER,
      to: USER_EMAIL,
      subject: "Verify your email",
      url: "http://127.0.0.1:1/verify-email?token=z",
      token: "t0212-token-z",
    });
    await finalizeCommand(tx, firstCommand);
  });
  const secondCommand = uniqueCommandId();
  const duplicateRefusal = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, secondCommand);
      await svc.enqueue(tx, {
        commandId: secondCommand,
        kind: "link-account.verify",
        eventKey: sharedKey,
        userId: USER,
        to: USER_EMAIL,
        subject: "Verify your email",
        url: "http://127.0.0.1:1/verify-email?token=z2",
        token: "t0212-token-z2",
      });
      return undefined;
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(outboxCodeOf(duplicateRefusal)).toBe(
    "OUTBOX_EVENT_ALREADY_REGISTERED",
  );
  expect(await countIntents(sql, firstCommand)).toBe(1);
  expect(await countIntents(sql, secondCommand)).toBe(0);
}, 120_000);

test("delivery_failure_never_decides_admission_and_retries", async () => {
  const svc = await services();
  const sql = harness!.sql;
  await flushPending(sql, svc);
  const spy = createDeliverySpy();
  const drain = drainWith(spy);
  const commandId = uniqueCommandId();
  const eventKey = `${commandId}:retry`;

  const committed = await harness!.db
    .transaction(async (trx) => {
      const tx = trx as never as DirectoryTx;
      await beginCommand(tx, commandId);
      await svc.enqueue(tx, {
        commandId,
        kind: "link-account.verify",
        eventKey,
        userId: USER,
        to: USER_EMAIL,
        subject: "Verify your email",
        url: "http://127.0.0.1:1/verify-email?token=r",
        token: "t0212-token-r",
      });
      await finalizeCommand(tx, commandId);
      return true;
    })
    .catch(() => false);
  expect(committed).toBe(true);

  // The provider fails: the drain reports it and leaves the row retryable.
  // The committed command's durable facts — the finalized receipt and the
  // pending intent — are exactly what they were: a notification never
  // decides admission.
  spy.failNextSends(2);
  const failing = await drain(sql, svc);
  expect(failing.delivered).toBe(0);
  expect(failing.failed.map((entry) => entry.id)).toContain(eventKey);
  const [afterFailure] = await outboxRows(sql, commandId);
  expect(afterFailure!.status).toBe("failed");
  const [receipt] = await sql`
      SELECT finalized FROM auth_command_receipts WHERE command_id = ${commandId}`;
  expect(receipt?.finalized).toBe(true);

  // A later scheduled drain with a healthy provider delivers the same
  // intent under the same stable key, once.
  const retry = await drain(sql, svc);
  expect(retry.delivered).toBe(1);
  expect(spy.sent).toHaveLength(1);
  expect(spy.sent[0]!.idempotencyKey).toBe(eventKey);
  const again = await drain(sql, svc);
  expect(again.delivered).toBe(0);
  expect(spy.sent).toHaveLength(1);
  const [delivered] = await outboxRows(sql, commandId);
  expect(delivered!.status).toBe("delivered");
}, 120_000);
