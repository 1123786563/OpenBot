import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { SQL } from "bun";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import {
  boolean,
  integer,
  pgSchema,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type {
  DirectoryTx,
  PostCommitHook,
} from "../../src/auth/directory/contracts";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";

/*
 * The T01.04 (#516) deferred-hook contract (interfaces §3.1): every source in
 * the pinned better-auth build that can register a post-commit hook is
 * classified by that source, an unclassified (or user-declared databaseHook)
 * registration is refused before commit, and the request-reset email callback
 * — whose errors the fixed package swallows inside
 * `runInBackgroundOrAwait` — cannot commit its verification token without the
 * outbox receipt that takes the notification over (§5.1 step 1).
 *
 * Like the T01.03 transaction contract, every assertion here starts from a
 * real HTTP request against this suite's own Hono ingress, whose executor
 * opens the outer transaction, binds the fixed instance to it with
 * TransactionBoundBa, checks the reset fence before commit, and drains the
 * classified hooks exactly once only after the commit succeeded. The pinned
 * internal cache source (refreshUserSessions) is driven for real through
 * `auth.api.updateUser`; the databaseHook counterexample is a second fixed
 * instance whose `user.update.after` writes on the global pool connection.
 */

const MAIN_SCHEMA = "ba_t0104_hooks";
const DBHOOK_SCHEMA = "ba_t0104_dbhook";
const DML_EVENTS_TABLE = "ba_dml_events";
const OUTBOX_TABLE = "ba_outbox";
const MARKERS_TABLE = "ba_global_write_markers";
const OUTBOX_FAULT_FUNCTION = "ba_outbox_fault_fn";
const OUTBOX_FAULT_TRIGGER = "ba_outbox_fault";
const CAPTURE_FUNCTION = "ba_capture_dml";
const WRITER_ROLE_OPTION = "-c role=ob_ent_auth_writer";
const BA_URL_VARIABLES = [
  "BA_TEST_DATABASE_URL",
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const RESET_IDENTIFIER_PREFIX = "reset-password:";
const NATIVE_RESET_RESPONSE = {
  status: true,
  message:
    "If this email exists in our system, check your email for the reset link",
};

interface DmlEvent {
  id: number;
  model: string;
  txid: string;
}

interface ResetCallbackState {
  started: boolean;
  completed: boolean;
  originalError: unknown;
  receipts: Set<string>;
  tx: DirectoryTx | null;
}

/** The dbhook instance's after-hook writes a marker through the global pool. */
const dbhookAttempted = { flag: false };

type SqlClient = SQL;

function makeClient(url: URL, options: string): SqlClient {
  return new SQL({
    adapter: "postgres" as const,
    hostname:
      url.hostname === "localhost" || url.hostname === "[::1]"
        ? "127.0.0.1"
        : url.hostname,
    port: Number(url.port || 5432),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    connection: { options },
    max: 4,
    idleTimeout: 5,
    connectionTimeout: 10_000,
    onnotice: () => {},
  }) as never as SqlClient;
}

function parseBaUrl(variable: string): URL {
  const raw = process.env[variable]?.trim();
  if (!raw) {
    throw new Error(
      `${variable} is required: the transaction-hooks suite runs only on the five BA_TEST_* URLs of the isolated openbot_enterprise_* database; a missing URL means blocked, not a shared-database fallback.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a PostgreSQL URL.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !/^openbot_enterprise_/.test(database)
  ) {
    throw new Error(
      `${variable} must be a loopback PostgreSQL URL naming an openbot_enterprise_* database.`,
    );
  }
  return url;
}

const TABLE_TYPE: Record<string, string> = {
  string: "text",
  number: "integer",
  boolean: "boolean",
  date: "timestamptz",
};

const CORE_MODELS = ["user", "session", "account", "verification"] as const;

/** The fixed package's own core-table declaration, as DDL, per suite schema. */
function coreTableDdl(schema: string): string[] {
  const tables = getAuthTables({ emailAndPassword: { enabled: true } });
  const statements: string[] = [];
  for (const model of CORE_MODELS) {
    const table = tables[model];
    if (!table) throw new Error(`fixed BA schema declares no ${model} table`);
    const columns = ['"id" text PRIMARY KEY'];
    for (const [field, attributes] of Object.entries(table.fields)) {
      let definition = `"${field}" ${TABLE_TYPE[attributes.type] ?? "text"}`;
      if (attributes.required) definition += " NOT NULL";
      if (attributes.unique) definition += " UNIQUE";
      columns.push(definition);
    }
    statements.push(
      `CREATE TABLE "${schema}"."${model}" (${columns.join(", ")})`,
    );
  }
  return statements;
}

/** DML evidence: every write to a suite-watched table records its transaction. */
function captureDdl(schema: string, watched: readonly string[]): string[] {
  const statements = [
    `CREATE TABLE "${schema}"."${DML_EVENTS_TABLE}" (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      model text NOT NULL,
      txid bigint NOT NULL,
      at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE FUNCTION "${schema}"."${CAPTURE_FUNCTION}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO "${schema}"."${DML_EVENTS_TABLE}" (model, txid) VALUES (TG_TABLE_NAME, txid_current());
  RETURN NULL;
END
$fn$`,
  ];
  for (const model of watched) {
    statements.push(
      `CREATE TRIGGER "ba_capture_${model}" AFTER INSERT OR UPDATE OR DELETE ON "${schema}"."${model}" FOR EACH ROW EXECUTE FUNCTION "${schema}"."${CAPTURE_FUNCTION}"()`,
    );
  }
  return statements;
}

function columnOf(type: string, field: string) {
  switch (type) {
    case "number":
      return integer(field);
    case "boolean":
      return boolean(field);
    case "date":
      return timestamp(field, { withTimezone: true });
    default:
      return text(field);
  }
}

function coreDrizzleTables(schema: string) {
  const suite = pgSchema(schema);
  const tables = getAuthTables({ emailAndPassword: { enabled: true } });
  const schemaMap: Record<string, ReturnType<typeof suite.table>> = {};
  for (const model of CORE_MODELS) {
    const columns: Record<string, unknown> = {};
    for (const [field, attributes] of Object.entries(tables[model].fields)) {
      const column = columnOf(attributes.type, field);
      columns[field] = attributes.required
        ? (column as { notNull: () => unknown }).notNull()
        : column;
    }
    schemaMap[model] = suite.table(model, {
      id: text("id").primaryKey(),
      ...columns,
    });
  }
  return schemaMap;
}

function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown };
    for (const code of [record.code, record.errno]) {
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function mapError(error: unknown): {
  status: number;
  body: Record<string, string>;
} {
  const apiError = error as {
    status?: string;
    statusCode?: number;
    body?: { code?: string; message?: string };
  };
  if (apiError?.body?.code || apiError?.body?.message) {
    const statusByName: Record<string, number> = {
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      INTERNAL_SERVER_ERROR: 500,
    };
    const status =
      (typeof apiError.statusCode === "number"
        ? apiError.statusCode
        : undefined) ??
      (apiError.status ? statusByName[apiError.status] : undefined) ??
      500;
    return {
      status,
      body: {
        code: apiError.body.code ?? apiError.status ?? "UNKNOWN",
        message:
          apiError.body.message ?? "better-auth endpoint rejected the command",
      },
    };
  }
  const sqlState = sqlStateOf(error);
  if (sqlState) {
    let deepest: unknown = error;
    for (let depth = 0; depth < 8; depth += 1) {
      const cause = (deepest as { cause?: unknown }).cause;
      if (!cause) break;
      deepest = cause;
    }
    return {
      status: 500,
      body: {
        code: sqlState,
        message: String((deepest as { message?: unknown }).message ?? error),
      },
    };
  }
  // The binding's refusals are plain errors whose message leads with the
  // refusal constant (UNREGISTERED_DATABASE_HOOK, …); surface it as the code
  // so the caller can branch on it.
  const message = String((error as { message?: unknown }).message ?? error);
  const refusal = /^([A-Z][A-Z0-9_]{4,}):/.exec(message);
  return {
    status: 500,
    body: { code: refusal?.[1] ?? "COMMAND_FAILED", message },
  };
}

function forwardHeaders(headers: Headers): Headers {
  const forwarded = new Headers();
  for (const [name, value] of headers.entries()) {
    if (["host", "content-length", "connection"].includes(name.toLowerCase())) {
      continue;
    }
    forwarded.set(name, value);
  }
  if (!forwarded.has("content-type")) {
    forwarded.set("content-type", "application/json");
  }
  return forwarded;
}

let client: SqlClient;
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
/** Request-local state the §5.1 reset callback writes its progress into. */
let activeReset: ResetCallbackState | undefined;
let resolvedMainOptions: unknown;
let resolvedDbhookOptions: unknown;

const mainTables = coreDrizzleTables(MAIN_SCHEMA);
const dbhookTables = coreDrizzleTables(DBHOOK_SCHEMA);
let dbMain: ReturnType<typeof drizzle>;
let dbDbhook: ReturnType<typeof drizzle>;
let authMain: Awaited<ReturnType<typeof betterAuth>>;
let authDbhook: Awaited<ReturnType<typeof betterAuth>>;

async function signUp(
  instance: "main" | "dbhook",
  email: string,
  name: string,
): Promise<{ userId: string; email: string; cookie: string }> {
  const auth = instance === "main" ? authMain : authDbhook;
  const response = await (
    auth.api as unknown as Record<string, (input: unknown) => Promise<Response>>
  ).signUpEmail({
    body: { email, password: DEFAULT_PASSWORD, name },
    asResponse: true,
  });
  if (response.status !== 200) {
    throw new Error(`signUpEmail failed: ${response.status}`);
  }
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("signUpEmail returned no session cookie");
  const body = (await response.json()) as {
    token: string;
    user: { id: string };
  };
  return {
    userId: body.user.id,
    email: email.toLowerCase(),
    cookie: setCookie.split(";")[0],
  };
}

/** Proxies a tx-bound adapter so the executor sees reset tokens as created. */
function recordResetCreates(
  adapter: unknown,
  created: { model: string; identifier: string }[],
): unknown {
  return new Proxy(adapter as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "create" || typeof value !== "function") return value;
      return async (input: {
        model?: string;
        data?: { identifier?: unknown };
      }) => {
        const result = await (value as (input: unknown) => unknown).apply(
          target,
          [input],
        );
        if (
          input?.model === "verification" &&
          typeof input.data?.identifier === "string" &&
          input.data.identifier.startsWith(RESET_IDENTIFIER_PREFIX)
        ) {
          created.push({
            model: "verification",
            identifier: input.data.identifier,
          });
        }
        return result;
      };
    },
  });
}

/**
 * The minimal command executor: one outer transaction per request, the fixed
 * command bound to it through TransactionBoundBa, the §5.1 reset fence before
 * commit, and the classified hooks drained exactly once only after commit.
 */
async function executeCommand(options: {
  instance: "main" | "dbhook";
  apiMethod: string;
  request: Request;
  fence?: boolean;
  failAfter?: boolean;
}): Promise<Response> {
  const db = options.instance === "main" ? dbMain : dbDbhook;
  const schemaMap = options.instance === "main" ? mainTables : dbhookTables;
  const resolved =
    options.instance === "main" ? resolvedMainOptions : resolvedDbhookOptions;
  const createdIdentifiers: { model: string; identifier: string }[] = [];
  const bound = createTransactionBoundBa({
    createTxAdapter: (tx) => {
      const base = drizzleAdapter(tx as never, {
        provider: "pg",
        schema: schemaMap,
        transaction: false,
      })(resolved as never);
      return options.instance === "main"
        ? recordResetCreates(base, createdIdentifiers)
        : base;
    },
  });

  const url = new URL(options.request.url);
  const bodyText = await options.request.text();
  const headers = forwardHeaders(options.request.headers);
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams.entries()) {
    if (["failAfter", "instance"].includes(name)) continue;
    query[name] = value;
  }

  const verdict = {
    registered: 0,
    drained: 0,
    kinds: [] as string[],
    hookIds: [] as string[],
    drainDmlEvents: 0,
    drainFailures: 0,
  };
  let committedHooks: readonly PostCommitHook[] = [];
  let outcomeResponse: Response | undefined;
  let outerTxid = "";
  let outerPid = 0;

  const responseHeaders = (): Headers => {
    const merged = new Headers(outcomeResponse?.headers ?? new Headers());
    merged.set("x-harness-mode", "api");
    merged.set("x-harness-outer-txid", outerTxid);
    merged.set("x-harness-backend-pid", String(outerPid));
    merged.set("x-hooks-registered", String(verdict.registered));
    merged.set("x-hooks-drained", String(verdict.drained));
    merged.set("x-hooks-kinds", verdict.kinds.join(","));
    merged.set("x-hook-ids", verdict.hookIds.join(","));
    merged.set("x-drain-dml-events", String(verdict.drainDmlEvents));
    merged.set("x-hook-drain-failures", String(verdict.drainFailures));
    return merged;
  };

  try {
    await db.transaction(async (trx) => {
      if (activeReset) activeReset.tx = trx as never as DirectoryTx;
      const identityResult = await trx.execute(
        dsql`select txid_current() as txid, pg_backend_pid() as pid`,
      );
      const identityRows = (Array.isArray(identityResult)
        ? identityResult
        : (identityResult as unknown as { rows?: unknown[] })
            .rows) as unknown as { txid: string; pid: number }[];
      const identity = identityRows?.[0];
      if (!identity) throw new Error("could not read transaction identity");
      outerTxid = String(identity.txid);
      outerPid = Number(identity.pid);

      const result = await bound.run(trx as never as DirectoryTx, () =>
        (
          (options.instance === "main" ? authMain : authDbhook)
            .api as unknown as Record<
            string,
            (input: unknown) => Promise<Response>
          >
        )[options.apiMethod]({
          headers,
          body: JSON.parse(bodyText || "{}"),
          query,
          asResponse: true,
        }),
      );
      outcomeResponse = result.value;
      committedHooks = result.pendingHooks;
      verdict.registered = result.pendingHooks.length;
      verdict.kinds = result.pendingHooks.map((hook) => hook.kind);
      verdict.hookIds = result.pendingHooks.map((hook) => hook.hookId);

      if (options.fence && activeReset) {
        const state = activeReset;
        const tokens = createdIdentifiers
          .filter((entry) => entry.model === "verification")
          .map((entry) =>
            entry.identifier.slice(RESET_IDENTIFIER_PREFIX.length),
          );
        const missing = tokens.filter((token) => !state.receipts.has(token));
        const callbackFailed =
          state.started &&
          (!state.completed || state.originalError !== undefined);
        if (missing.length > 0 || callbackFailed) {
          throw (
            state.originalError ??
            new Error(
              `RESET_TOKEN_WITHOUT_OUTBOX_RECEIPT: this transaction created ${missing.length} reset verification token(s) with no completed outbox receipt; refusing to commit the token alone`,
            )
          );
        }
      }
      if (options.failAfter) {
        throw new Error(
          "injected executor fault after the command (T01.04 rollback fence)",
        );
      }
    });
  } catch (error) {
    // Rolled back: no hook drains. When the fence's request-local state kept
    // the original (swallowed) callback error, that error — not the savepoint
    // machinery's refusal — is what the caller gets (§5.1: 缺失或失败先抛保留
    // 的原异常并回滚).
    const surfaced =
      options.fence && activeReset?.originalError !== undefined
        ? activeReset.originalError
        : error;
    const mapped = mapError(surfaced);
    const headerList = responseHeaders();
    headerList.set("content-type", "application/json");
    headerList.set("x-harness-rolled-back", "1");
    return new Response(JSON.stringify(mapped.body), {
      status: mapped.status,
      headers: headerList,
    });
  }

  const countEvents = async (): Promise<number> =>
    Number(
      (
        (await client`select count(*)::int as n from ${client(MAIN_SCHEMA)}.${client(DML_EVENTS_TABLE)}`) as unknown as {
          n: number;
        }[]
      )[0]?.n ?? 0,
    );
  const eventsBefore = await countEvents();
  for (const hook of committedHooks) {
    try {
      await hook.run();
      verdict.drained += 1;
    } catch {
      verdict.drainFailures += 1;
    }
  }
  verdict.drainDmlEvents = (await countEvents()) - eventsBefore;

  return new Response(outcomeResponse?.body, {
    status: outcomeResponse?.status ?? 200,
    headers: responseHeaders(),
  });
}

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-t0104-${process.pid}-${sequence}@example.test`;
}

beforeAll(async () => {
  // Five-URL gate first, exactly the contract the T01.02 fixture and the
  // T01.03 harness enforce for this island: same loopback instance, same
  // enterprise database, no shared/MT fallback, no DSN printed.
  const shapes = new Map<string, string>();
  for (const variable of BA_URL_VARIABLES) {
    const url = parseBaUrl(variable);
    const host =
      url.hostname === "localhost" || url.hostname === "[::1]"
        ? "127.0.0.1"
        : url.hostname;
    shapes.set(
      variable,
      `${host}:${url.port || "5432"}/${url.pathname.replace(/^\//, "")}`,
    );
  }
  const writerUrl = parseBaUrl("BA_TEST_AUTH_WRITER_DATABASE_URL");
  if (
    !(writerUrl.searchParams.get("options") ?? "").includes(WRITER_ROLE_OPTION)
  ) {
    throw new Error(
      `BA_TEST_AUTH_WRITER_DATABASE_URL must pin its session to the auth-writer capability via "${WRITER_ROLE_OPTION}".`,
    );
  }
  const reference = shapes.get("BA_TEST_DATABASE_URL");
  for (const [variable, shape] of shapes) {
    if (shape !== reference) {
      throw new Error(
        `${variable} must name the same instance and database as BA_TEST_DATABASE_URL (${reference}); it names ${shape}.`,
      );
    }
  }

  client = makeClient(writerUrl, writerUrl.searchParams.get("options") ?? "");

  for (const schema of [MAIN_SCHEMA, DBHOOK_SCHEMA]) {
    await client.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.unsafe(`CREATE SCHEMA "${schema}"`);
    for (const statement of coreTableDdl(schema)) {
      await client.unsafe(statement);
    }
  }
  // Suite-owned extras first: the capture triggers below watch the outbox and
  // marker tables too, so they have to exist before the triggers attach.
  await client.unsafe(`CREATE TABLE "${MAIN_SCHEMA}"."${OUTBOX_TABLE}" (
    token text PRIMARY KEY,
    user_id text NOT NULL,
    command text NOT NULL,
    receipt text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.unsafe(`CREATE TABLE "${DBHOOK_SCHEMA}"."${MARKERS_TABLE}" (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    note text NOT NULL
  )`);
  for (const statement of captureDdl(MAIN_SCHEMA, [
    ...CORE_MODELS,
    OUTBOX_TABLE,
  ])) {
    await client.unsafe(statement);
  }
  for (const statement of captureDdl(DBHOOK_SCHEMA, [
    ...CORE_MODELS,
    MARKERS_TABLE,
  ])) {
    await client.unsafe(statement);
  }
  await client.unsafe(`CREATE FUNCTION "${MAIN_SCHEMA}"."${OUTBOX_FAULT_FUNCTION}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'injected outbox fault (T01.04 reset fence)' USING ERRCODE = 'P0001';
END
$fn$`);

  dbMain = drizzle({ client: client as never, schema: mainTables });
  dbDbhook = drizzle({ client: client as never, schema: dbhookTables });

  authMain = betterAuth({
    secret: "t0104-hooks-fixed-test-secret-not-a-credential",
    baseURL: "http://127.0.0.1:1",
    trustedOrigins: ["http://127.0.0.1:1"],
    emailAndPassword: {
      enabled: true,
      /*
       * §5.1 step 1: the callback registers the outbox intent inside the
       * CURRENT transaction and records start/completion/original error in
       * request-local state. Actual delivery belongs to the post-commit outbox
       * worker (P04/P08); the receipt row is the proof of transactional
       * registration.
       */
      sendResetPassword: async ({ user, token }) => {
        const state = activeReset;
        if (!state) {
          throw new Error(
            "sendResetPassword ran outside a fenced request; the fixed package must not dispatch reset mail without the executor fence",
          );
        }
        state.started = true;
        try {
          await state.tx!.execute(
            dsql`insert into ${dsql.raw(`"${MAIN_SCHEMA}"."${OUTBOX_TABLE}"`)} (token, user_id, command, receipt)
              values (${token}, ${user.id}, 'request-password-reset', ${`receipt:${token}`})`,
          );
          state.receipts.add(token);
          state.completed = true;
        } catch (error) {
          state.originalError = error;
          state.completed = false;
          throw error;
        }
      },
    },
    // The §3.1 factory hard preconditions, set the way the authority factory
    // must set them; assertBaAuthorityPreconditions refuses anything else.
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    database: (options: unknown) => {
      resolvedMainOptions = options;
      return drizzleAdapter(dbMain as never, {
        provider: "pg",
        schema: mainTables,
        transaction: true,
      })(options as never);
    },
  });
  await authMain.$context;

  authDbhook = betterAuth({
    secret: "t0104-dbhook-fixed-test-secret-not-a-credential",
    baseURL: "http://127.0.0.1:1",
    trustedOrigins: ["http://127.0.0.1:1"],
    emailAndPassword: { enabled: true },
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
    databaseHooks: {
      user: {
        update: {
          // The counterexample interfaces §3.1 refuses before commit: an
          // after-hook whose body writes through the global pool connection,
          // outside the executor's transaction.
          after: async () => {
            dbhookAttempted.flag = true;
            await client`insert into ${client(DBHOOK_SCHEMA)}.${client(MARKERS_TABLE)} (note)
              values ('global-connection write from a user.update.after databaseHook')`;
          },
        },
      },
    },
    database: (options: unknown) => {
      resolvedDbhookOptions = options;
      return drizzleAdapter(dbDbhook as never, {
        provider: "pg",
        schema: dbhookTables,
        transaction: true,
      })(options as never);
    },
  });
  await authDbhook.$context;

  const app = new Hono();
  app.onError((error, context) => context.json({ error: error.message }, 500));
  app.post("/hooks-tx/update-user", (context) => {
    const instance =
      context.req.query("instance") === "dbhook" ? "dbhook" : "main";
    return executeCommand({
      instance,
      apiMethod: "updateUser",
      request: context.req.raw,
      failAfter: context.req.query("failAfter") === "1",
    });
  });
  app.post("/hooks-tx/request-password-reset", (context) => {
    activeReset = {
      started: false,
      completed: false,
      originalError: undefined,
      receipts: new Set<string>(),
      tx: null,
    };
    return executeCommand({
      instance: "main",
      apiMethod: "requestPasswordReset",
      request: context.req.raw,
      fence: true,
    }).finally(() => {
      activeReset = undefined;
    });
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  baseUrl = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
  server?.stop(true);
  try {
    for (const schema of [MAIN_SCHEMA, DBHOOK_SCHEMA]) {
      await client?.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  } finally {
    await client?.end({ timeout: 5 }).catch(() => {});
  }
  // Teardown removes only what this suite created; a stray schema, table or
  // routine fails here instead of piling up in the shared test database.
  const probe = makeClient(parseBaUrl("BA_TEST_DATABASE_URL"), "");
  try {
    const rows = (await probe`
      SELECT resource FROM (
        SELECT nspname AS resource FROM pg_namespace WHERE nspname IN (${MAIN_SCHEMA}, ${DBHOOK_SCHEMA})
        UNION ALL
        SELECT n.nspname || '.' || c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname IN (${MAIN_SCHEMA}, ${DBHOOK_SCHEMA})
        UNION ALL
        SELECT n.nspname || '.' || p.proname FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN (${MAIN_SCHEMA}, ${DBHOOK_SCHEMA})
      ) leaked ORDER BY 1`) as unknown as { resource: string }[];
    expect(rows.map((row) => row.resource)).toEqual([]);
  } finally {
    await probe.end({ timeout: 3 }).catch(() => {});
  }
}, 120_000);

function postJson(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return fetch(new URL(path, `${baseUrl}/`).href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function readUserName(
  schema: string,
  userId: string,
): Promise<string | null> {
  const rows =
    (await client`select name from ${client(schema)}.${client("user")} where id = ${userId}`) as unknown as {
      name: string;
    }[];
  return rows[0]?.name ?? null;
}

/** Committed reset-password verification rows for one user. */
async function resetTokenRows(
  schema: string,
  userId: string,
): Promise<string[]> {
  const rows =
    (await client`select identifier from ${client(schema)}.${client("verification")}
    where value = ${userId} and identifier like ${`${RESET_IDENTIFIER_PREFIX}%`}`) as unknown as {
      identifier: string;
    }[];
  return rows.map((row) => row.identifier);
}

async function outboxRows(): Promise<string[]> {
  const rows =
    (await client`select token from ${client(MAIN_SCHEMA)}.${client(OUTBOX_TABLE)} order by token`) as unknown as {
      token: string;
    }[];
  return rows.map((row) => row.token);
}

async function markerRows(): Promise<{ id: number; note: string }[]> {
  return (await client`select id, note from ${client(DBHOOK_SCHEMA)}.${client(MARKERS_TABLE)} order by id`) as unknown as {
    id: number;
    note: string;
  }[];
}

async function dmlEvents(schema: string): Promise<DmlEvent[]> {
  return (await client`select id, model, txid::text as txid from ${client(schema)}.${client(DML_EVENTS_TABLE)} order by id`) as unknown as DmlEvent[];
}

async function resetDmlEvents(schema: string): Promise<void> {
  await client`delete from ${client(schema)}.${client(DML_EVENTS_TABLE)}`;
}

test("deferred_after_hooks_are_classified_not_dropped", {
  timeout: 120_000,
}, async () => {
  const user = await signUp("main", unique("hooks-a"), "Hooks A");

  // Commit half: updateUser queues the pinned refreshUserSessions no-op; the
  // run returns it classified instead of dropping or refusing it, and the
  // executor drains it exactly once after the commit.
  await resetDmlEvents(MAIN_SCHEMA);
  const committed = await postJson(
    "/hooks-tx/update-user",
    { name: "Renamed Once" },
    user.cookie,
  );
  expect(committed.status).toBe(200);
  expect(committed.headers.get("x-hooks-registered")).toBe("1");
  expect(committed.headers.get("x-hooks-drained")).toBe("1");
  expect(committed.headers.get("x-hooks-kinds")).toBe("disabled-cache-noop");
  expect(committed.headers.get("x-hook-ids") ?? "").toContain(
    "refreshUserSessions",
  );
  // Zero cache I/O and zero database writes from the drained no-op: nothing
  // the hook did produced a row in any watched table.
  expect(committed.headers.get("x-drain-dml-events")).toBe("0");
  expect(await readUserName(MAIN_SCHEMA, user.userId)).toBe("Renamed Once");

  // Rollback half: the same command, aborted by the executor after the run —
  // the hook still registered, but a rollback drains none of them and the
  // command's write is gone.
  const rolledBack = await postJson(
    "/hooks-tx/update-user?failAfter=1",
    { name: "Renamed Never" },
    user.cookie,
  );
  expect(rolledBack.status).toBe(500);
  expect(rolledBack.headers.get("x-hooks-registered")).toBe("1");
  expect(rolledBack.headers.get("x-hooks-drained")).toBe("0");
  expect(rolledBack.headers.get("x-harness-rolled-back")).toBe("1");
  expect(await readUserName(MAIN_SCHEMA, user.userId)).toBe("Renamed Once");
});

test("after_hook_writes_cannot_use_global_connection", {
  timeout: 120_000,
}, async () => {
  const user = await signUp("dbhook", unique("hooks-b"), "Hooks B");
  dbhookAttempted.flag = false;
  const before = {
    user: await readUserName(DBHOOK_SCHEMA, user.userId),
    markers: await markerRows(),
  };
  await resetDmlEvents(DBHOOK_SCHEMA);

  const refused = await postJson(
    "/hooks-tx/update-user?instance=dbhook",
    { name: "Global Write Attempt" },
    user.cookie,
  );
  // The registration is refused before the commit: the command never lands.
  expect(refused.status).toBe(500);
  const body = (await refused.json()) as { code: string; message: string };
  expect(body.code).toBe("UNREGISTERED_DATABASE_HOOK");
  expect(body.message).toContain("databaseHooks");
  // The after-hook body never ran, so its global-connection write never
  // happened either — nothing committed, database exactly as before.
  expect(dbhookAttempted.flag).toBe(false);
  expect(refused.headers.get("x-hooks-drained")).toBe("0");
  expect(refused.headers.get("x-harness-rolled-back")).toBe("1");
  const after = {
    user: await readUserName(DBHOOK_SCHEMA, user.userId),
    markers: await markerRows(),
  };
  expect(after).toEqual(before);
  expect(await dmlEvents(DBHOOK_SCHEMA)).toEqual([]);
});

test("request_reset_swallowed_callback_cannot_commit_token_alone", {
  timeout: 120_000,
}, async () => {
  const happyUser = await signUp("main", unique("hooks-c1"), "Hooks C1");
  const faultedUser = await signUp("main", unique("hooks-c2"), "Hooks C2");

  // Happy path: the outbox takes the notification over inside the same
  // transaction, so the token and its receipt commit together.
  await resetDmlEvents(MAIN_SCHEMA);
  const ok = await postJson("/hooks-tx/request-password-reset", {
    email: happyUser.email,
  });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual(NATIVE_RESET_RESPONSE);
  expect(await resetTokenRows(MAIN_SCHEMA, happyUser.userId)).toHaveLength(1);
  expect(await outboxRows()).toHaveLength(1);
  const outerTxid = ok.headers.get("x-harness-outer-txid");
  expect(outerTxid).toBeTruthy();
  const events = await dmlEvents(MAIN_SCHEMA);
  // The token row and the outbox receipt ran in the executor's transaction,
  // which is what makes the receipt a commit fence for the token.
  expect(events.some((event) => event.model === "verification")).toBe(true);
  expect(events.some((event) => event.model === OUTBOX_TABLE)).toBe(true);
  expect(events.every((event) => event.txid === outerTxid)).toBe(true);

  // Faulted outbox: the fixed package swallows the callback error and answers
  // success; the executor's fence refuses the commit and the preserved
  // original error reaches the caller — the token never commits alone.
  await client.unsafe(
    `CREATE TRIGGER "${OUTBOX_FAULT_TRIGGER}" BEFORE INSERT ON "${MAIN_SCHEMA}"."${OUTBOX_TABLE}"
     FOR EACH ROW EXECUTE FUNCTION "${MAIN_SCHEMA}"."${OUTBOX_FAULT_FUNCTION}"()`,
  );
  try {
    const blocked = await postJson("/hooks-tx/request-password-reset", {
      email: faultedUser.email,
    });
    expect(blocked.status).toBe(500);
    const body = (await blocked.json()) as { code: string; message: string };
    // The original, swallowed error — not a generic fence message.
    expect(body.message).toContain(
      "injected outbox fault (T01.04 reset fence)",
    );
    expect(blocked.headers.get("x-harness-rolled-back")).toBe("1");
    expect(await resetTokenRows(MAIN_SCHEMA, faultedUser.userId)).toHaveLength(
      0,
    );
    // The happy path's rows are untouched by the rollback.
    expect(await resetTokenRows(MAIN_SCHEMA, happyUser.userId)).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
  } finally {
    await client.unsafe(
      `DROP TRIGGER IF EXISTS "${OUTBOX_FAULT_TRIGGER}" ON "${MAIN_SCHEMA}"."${OUTBOX_TABLE}"`,
    );
  }

  // Unknown email: the native response keeps its exact shape and no token or
  // outbox intent appears (§5.1: nothing to fence, nothing committed).
  const unknown = await postJson("/hooks-tx/request-password-reset", {
    email: "nobody-t0104@example.test",
  });
  expect(unknown.status).toBe(200);
  expect(await unknown.json()).toEqual(NATIVE_RESET_RESPONSE);
  expect(await resetTokenRows(MAIN_SCHEMA, happyUser.userId)).toHaveLength(1);
  expect(await resetTokenRows(MAIN_SCHEMA, faultedUser.userId)).toHaveLength(0);
  expect(await outboxRows()).toHaveLength(1);
});

test("contrary_cache_config_is_refused_before_any_route", {
  timeout: 120_000,
}, async () => {
  const { assertBaAuthorityPreconditions } = await import(
    "../../src/auth/directory/transaction-adapter"
  );

  // The pinned-factory-shaped instance above satisfies every §3.1 hard
  // precondition, so the startup check passes for it.
  expect(() =>
    assertBaAuthorityPreconditions(resolvedMainOptions),
  ).not.toThrow();

  // A real fixed instance per contrary option — no route is ever called on
  // any of them: the §3.1 startup check must refuse them first.
  const contraryInstance = async (
    extra: Parameters<typeof betterAuth>[0],
  ): Promise<unknown> => {
    let resolved: unknown;
    const instance = betterAuth({
      secret: "t0104-anti-config-fixed-test-secret-not-a-credential",
      baseURL: "http://127.0.0.1:1",
      emailAndPassword: { enabled: true },
      session: { storeSessionInDatabase: true },
      verification: { storeInDatabase: true },
      database: (options: unknown) => {
        resolved = options;
        return drizzleAdapter(dbMain as never, {
          provider: "pg",
          schema: mainTables,
          transaction: true,
        })(options as never);
      },
      ...extra,
    });
    await instance.$context;
    return resolved;
  };

  const secondaryStorage = await contraryInstance({
    secondaryStorage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
    },
  } as Parameters<typeof betterAuth>[0]);
  expect(() => assertBaAuthorityPreconditions(secondaryStorage)).toThrow(
    /BA_AUTHORITY_CONFIG_VIOLATION/,
  );
  expect(() => assertBaAuthorityPreconditions(secondaryStorage)).toThrow(
    /secondaryStorage/,
  );

  const cookieCache = await contraryInstance({
    session: { storeSessionInDatabase: true, cookieCache: { enabled: true } },
  } as Parameters<typeof betterAuth>[0]);
  expect(() => assertBaAuthorityPreconditions(cookieCache)).toThrow(
    /BA_AUTHORITY_CONFIG_VIOLATION/,
  );
  expect(() => assertBaAuthorityPreconditions(cookieCache)).toThrow(
    /cookieCache/,
  );

  const sessionsNotInDatabase = await contraryInstance({
    session: { storeSessionInDatabase: false },
  } as Parameters<typeof betterAuth>[0]);
  expect(() => assertBaAuthorityPreconditions(sessionsNotInDatabase)).toThrow(
    /BA_AUTHORITY_CONFIG_VIOLATION/,
  );
  expect(() => assertBaAuthorityPreconditions(sessionsNotInDatabase)).toThrow(
    /storeSessionInDatabase/,
  );

  const verificationNotInDatabase = await contraryInstance({
    verification: { storeInDatabase: false },
  } as Parameters<typeof betterAuth>[0]);
  expect(() =>
    assertBaAuthorityPreconditions(verificationNotInDatabase),
  ).toThrow(/BA_AUTHORITY_CONFIG_VIOLATION/);
  expect(() =>
    assertBaAuthorityPreconditions(verificationNotInDatabase),
  ).toThrow(/verification.*storeInDatabase/);
});

test("hook_source_registry_pins_the_fixed_build_call_sites", async () => {
  const { BA_HOOK_SOURCE_REGISTRY, classifyHookRegistration } = await import(
    "../../src/auth/directory/transaction-adapter"
  );

  // Every queueAfterTransactionHook call site in the pinned better-auth
  // 1.7.1 build (the four fixed packages; @better-auth/sso and
  // @better-auth/scim contain none) is registered exactly once. A package
  // upgrade that moves or adds a call site fails this pin.
  expect(
    BA_HOOK_SOURCE_REGISTRY.map(
      (entry: { packageFile: string; line: number }) =>
        `${entry.packageFile}:${entry.line}`,
    ).sort(),
  ).toEqual(
    [
      "better-auth/dist/db/internal-adapter.mjs:100",
      "better-auth/dist/db/internal-adapter.mjs:315",
      "better-auth/dist/db/internal-adapter.mjs:607",
      "better-auth/dist/db/internal-adapter.mjs:620",
      "better-auth/dist/db/with-hooks.mjs:33",
      "better-auth/dist/db/with-hooks.mjs:69",
      "better-auth/dist/db/with-hooks.mjs:105",
      "better-auth/dist/db/with-hooks.mjs:142",
      "better-auth/dist/db/with-hooks.mjs:178",
      "better-auth/dist/db/with-hooks.mjs:234",
      "better-auth/dist/oauth2/link-account.mjs:304",
    ].sort(),
  );

  // Classification reads the registration stack, not the closure text: the
  // frame that queued the hook names the fixed package file and line.
  const stackOf = (file: string, line: number): string =>
    [
      "Error",
      "    at HookQueue.push (/repo/server/src/auth/directory/transaction-adapter.ts:1:1)",
      "    at <anonymous> (/install/@better-auth+core@1.7.1+5eccc1bd652576f0/node_modules/@better-auth/core/dist/context/transaction.mjs:140:21)",
      `    at async <anonymous> (/install/better-auth@1.7.1+6b8e0f31af62e28e/dist/${file}:${line}:10)`,
    ].join("\n");

  const refreshViaUpdate = classifyHookRegistration(
    stackOf("db/internal-adapter.mjs", 607),
  );
  expect(refreshViaUpdate.entry?.disposition).toEqual({
    kind: "disabled-cache-noop",
  });
  expect(refreshViaUpdate.entry?.hookId).toContain("refreshUserSessions");
  expect(
    classifyHookRegistration(stackOf("db/internal-adapter.mjs", 620)).entry
      ?.disposition,
  ).toEqual({ kind: "disabled-cache-noop" });

  // The two sources that must never register under the pinned configuration.
  expect(
    classifyHookRegistration(stackOf("db/internal-adapter.mjs", 100)).entry
      ?.disposition,
  ).toEqual({ reason: "cache-write-with-forbidden-storage" });
  expect(
    classifyHookRegistration(stackOf("db/internal-adapter.mjs", 315)).entry
      ?.disposition,
  ).toEqual({ reason: "cache-write-with-forbidden-storage" });

  // The notification source: converted, never drained (F-08, T04.04). The
  // registration executes inside the still-open transaction, where the
  // factory-wired controlled sender registers the encrypted outbox intent
  // and its receipt; the closure itself never joins the post-commit drain.
  expect(
    classifyHookRegistration(stackOf("oauth2/link-account.mjs", 304)).entry
      ?.disposition,
  ).toEqual({ kind: "notification-outbox-takeover" });

  // databaseHooks: user-declared after-hooks are refused before commit no
  // matter which of the six with-hooks call sites queued them.
  expect(
    classifyHookRegistration(stackOf("db/with-hooks.mjs", 69)).entry
      ?.disposition,
  ).toEqual({ reason: "unregistered-database-hook" });

  // A site the registry does not know is unclassified — refused before commit.
  const unknown = classifyHookRegistration(
    stackOf("db/internal-adapter.mjs", 999),
  );
  expect(unknown.entry).toBeUndefined();
});
