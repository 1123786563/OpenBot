/*
 * transaction-http-harness — the test-only HTTP ingress + minimal command
 * executor for the T01.03 (#515) transaction contract.
 *
 * This file exists to *prove* the P01 feasibility contract, not to be the
 * production wiring (that lands with the downstream executor task):
 *
 * - a real Hono app served over loopback TCP (Bun.serve), so every assertion
 *   starts from an actual HTTP request, never an in-process auth.api-only
 *   stand-in;
 * - a fixed-version Better Auth instance (better-auth + organization plugin)
 *   over the production stack's own pieces: Drizzle on Bun's SQL client, with
 *   @better-auth/drizzle-adapter as the storage adapter. Its tables live in
 *   this harness's own schema, created and dropped by the restricted
 *   auth-writer capability of the isolated openbot_enterprise_* test database;
 * - a minimal executor: per request it opens the outer command transaction
 *   (a Drizzle transaction over Bun SQL — the frozen DirectoryTx), records
 *   its identity (txid_current / pg_backend_pid), optionally holds it open,
 *   then runs the fixed directory write entry shape
 *   `TransactionBoundBa.run(tx, () => auth.api.<endpoint>({ headers, body,
 *   query, asResponse: true }))`, committing only when the run succeeds;
 * - a deliberate negative-control mode (`?mode=handler`) that routes the same
 *   request through `auth.handler` instead, so the suite can prove the native
 *   handler never shares the executor's transaction;
 * - a database trigger that records `txid_current()` of every BA-table DML,
 *   so the DML's actual transaction is compared with the executor's outer
 *   txid, plus a controllable fault trigger for the rollback case;
 * - teardown that drops only what this harness created, verified by an
 *   after-close leak probe through the setup URL.
 *
 * Environment: all five BA_TEST_* URLs must be present and shaped (loopback
 * PostgreSQL naming an openbot_enterprise_* database) — the same gate the
 * T01.02 fixture applies, so running this group alone is also blocked on a
 * missing role URL rather than quietly skipping a role. The harness dials two
 * of them: BA_TEST_AUTH_WRITER_DATABASE_URL (writes; must pin
 * `-c role=ob_ent_auth_writer`) and BA_TEST_DATABASE_URL (leak probe); both
 * must name the same instance and database. No DSN is ever printed.
 */

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getAuthTables } from "better-auth/db";
import { organization } from "better-auth/plugins";
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
import type { DirectoryTx } from "../../../src/auth/directory/contracts";
import { createTransactionBoundBa } from "../../../src/auth/directory/transaction-adapter";

const SCHEMA = "ba_tx_harness";
const DML_EVENTS_TABLE = "ba_tx_dml_events";
const FAULT_FUNCTION = "ba_tx_fault_member";
const FAULT_TRIGGER = "ba_tx_fault_member_insert";
const CAPTURE_FUNCTION = "ba_tx_capture_dml";
const WRITER_ROLE_OPTION = "-c role=ob_ent_auth_writer";
const DEFAULT_PASSWORD = "correct-horse-battery-staple";
const BA_URL_VARIABLES = [
  "BA_TEST_DATABASE_URL",
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/*
 * Every directory write the fixed organization plugin can serve as
 * `auth.api.<method>`, mounted under /tx by the harness ingress. This is the
 * exact set the suite drives over real HTTP; interfaces §3.2 endpoints whose
 * disposition is X land in CLOSED_ROUTES instead and are refused by the
 * ingress before any transaction opens.
 */
const WRITE_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["/organization/update", "updateOrganization"],
  ["/organization/invite-member", "createInvitation"],
  ["/organization/accept-invitation", "acceptInvitation"],
  ["/organization/reject-invitation", "rejectInvitation"],
  ["/organization/cancel-invitation", "cancelInvitation"],
  ["/organization/remove-member", "removeMember"],
  ["/organization/update-member-role", "updateMemberRole"],
  ["/organization/leave", "leaveOrganization"],
  ["/organization/create-team", "createTeam"],
  ["/organization/update-team", "updateTeam"],
  ["/organization/add-team-member", "addTeamMember"],
  ["/organization/remove-team-member", "removeTeamMember"],
];

const CLOSED_ROUTES: readonly string[] = [
  "/organization/create",
  "/organization/delete",
  "/organization/remove-team",
  "/organization/create-role",
  "/organization/update-role",
  "/organization/delete-role",
  "/organization/get-role",
  "/organization/list-roles",
  "/organization/list",
  "/organization/get-invitation",
  "/organization/list-user-invitations",
  "/organization/list-user-teams",
];

export interface HarnessUser {
  userId: string;
  /** The normalized email, for invitation rows that must match it. */
  email: string;
  cookie: string;
  /** The raw session token (cookie value is signed; the row key is not). */
  sessionToken: string;
}

export interface DmlEvent {
  id: number;
  model: string;
  txid: string;
}

export interface TransactionHarness {
  baseUrl: string;
  /** Real HTTP against the harness ingress. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Creates a real user + session through the fixed BA instance. */
  signUp(email: string, name: string): Promise<HarnessUser>;
  seedOrganization(input: {
    id: string;
    name: string;
    slug: string;
  }): Promise<void>;
  seedMember(input: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<void>;
  seedInvitation(input: {
    id: string;
    organizationId: string;
    email: string;
    inviterId: string;
    role?: string;
    status?: string;
  }): Promise<void>;
  readInvitation(
    invitationId: string,
  ): Promise<
    | { id: string; status: string; organizationId: string; email: string }
    | undefined
  >;
  readMembers(
    organizationId: string,
  ): Promise<{ id: string; userId: string; role: string }[]>;
  readSessionActiveOrganization(sessionToken: string): Promise<string | null>;
  memberIdOf(
    organizationId: string,
    userId: string,
  ): Promise<string | undefined>;
  /** Committed DML evidence recorded by the capture trigger. */
  dmlEvents(): Promise<DmlEvent[]>;
  resetDmlEvents(): Promise<void>;
  /** Make the next member insert for this user fail with SQLSTATE 23505. */
  installMemberFault(userId: string): Promise<void>;
  removeMemberFault(): Promise<void>;
  /** Undo what the negative-control handler committed outside any executor. */
  cleanupOutsideExecutor(input: {
    organizationId: string;
    userId: string;
    invitationId: string;
  }): Promise<void>;
  /** Harness-owned namespaces/relations still present (probe via setup URL). */
  leakedResources(): Promise<string[]>;
  close(): Promise<void>;
}

interface BaEndpoint {
  endpoint: string;
  database: string;
}

function parseBaUrl(variable: string): URL {
  const raw = process.env[variable]?.trim();
  if (!raw) {
    throw new Error(
      `${variable} is required: the transaction harness runs only on the five BA_TEST_* URLs of the isolated openbot_enterprise_* database; a missing URL means blocked, not a shared-database fallback.`,
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

function endpointOf(url: URL): string {
  return `${
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname
  }:${url.port || "5432"}`;
}

function sqlOptions(): { connection: { options: string } } {
  const writer = parseBaUrl("BA_TEST_AUTH_WRITER_DATABASE_URL");
  const options = writer.searchParams.get("options") ?? "";
  if (!options.includes(WRITER_ROLE_OPTION)) {
    throw new Error(
      `BA_TEST_AUTH_WRITER_DATABASE_URL must pin its session to the auth-writer capability via "${WRITER_ROLE_OPTION}".`,
    );
  }
  return { connection: { options } };
}

const TABLE_TYPE: Record<string, string> = {
  string: "text",
  number: "integer",
  boolean: "boolean",
  date: "timestamptz",
};

/** The fixed packages' own schema declaration, as table DDL, in FK order. */
function buildTableDdl(tables: ReturnType<typeof getAuthTables>): string[] {
  const statements: string[] = [];
  const order = [
    "user",
    "session",
    "account",
    "verification",
    "organization",
    "team",
    "member",
    "teamMember",
    "invitation",
  ];
  for (const model of order) {
    const table = tables[model];
    if (!table) throw new Error(`fixed BA schema declares no ${model} table`);
    const columns = ['"id" text PRIMARY KEY'];
    for (const [field, attributes] of Object.entries(table.fields)) {
      let definition = `"${field}" ${TABLE_TYPE[attributes.type] ?? "text"}`;
      if (attributes.required) definition += " NOT NULL";
      if (attributes.unique) definition += " UNIQUE";
      if (attributes.references) {
        definition += ` REFERENCES "${SCHEMA}"."${attributes.references.model}"("${attributes.references.field}")`;
      }
      columns.push(definition);
    }
    statements.push(
      `CREATE TABLE "${SCHEMA}"."${model}" (${columns.join(", ")})`,
    );
  }
  return statements;
}

/** DML evidence: every write to a BA table records the transaction it ran in. */
function buildCaptureDdl(): string[] {
  const statements = [
    `CREATE TABLE "${SCHEMA}"."${DML_EVENTS_TABLE}" (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      model text NOT NULL,
      txid bigint NOT NULL,
      at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE FUNCTION "${SCHEMA}"."${CAPTURE_FUNCTION}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO "${SCHEMA}"."${DML_EVENTS_TABLE}" (model, txid) VALUES (TG_TABLE_NAME, txid_current());
  RETURN NULL;
END
$fn$`,
    `CREATE FUNCTION "${SCHEMA}"."${FAULT_FUNCTION}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."userId" = TG_ARGV[0] THEN
    RAISE EXCEPTION 'injected member write fault (T01.03 transaction contract)' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$fn$`,
  ];
  for (const model of [
    "user",
    "session",
    "account",
    "verification",
    "organization",
    "team",
    "member",
    "teamMember",
    "invitation",
  ]) {
    statements.push(
      `CREATE TRIGGER "ba_tx_capture_${model}" AFTER INSERT OR UPDATE OR DELETE ON "${SCHEMA}"."${model}" FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}"."${CAPTURE_FUNCTION}"()`,
    );
  }
  return statements;
}

/**
 * Drizzle table objects for the same models, built from the same
 * `getAuthTables` declaration the DDL comes from, so the adapter's queries and
 * the database can never disagree about a column. `pgSchema` keeps every
 * adapter statement schema-qualified, so the harness needs no search_path.
 */
/** The column builder for one schema-declared field, keyed by its declared type. */
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

function buildDrizzleTables(tables: ReturnType<typeof getAuthTables>) {
  const harness = pgSchema(SCHEMA);
  const schema: Record<string, ReturnType<typeof harness.table>> = {};
  for (const [model, table] of Object.entries(tables)) {
    const columns: Record<string, unknown> = {};
    for (const [field, attributes] of Object.entries(table.fields)) {
      const column = columnOf(attributes.type, field);
      columns[field] = attributes.required
        ? (column as { notNull: () => unknown }).notNull()
        : column;
    }
    schema[model] = harness.table(model, {
      id: text("id").primaryKey(),
      ...columns,
    });
  }
  return schema;
}

class RollbackAfterCapture extends Error {
  constructor(
    readonly response: Response,
    readonly identity: { txid: string; backendPid: number },
  ) {
    super("rollback after negative-control capture");
  }
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

/**
 * The harness's own control parameters never reach Better Auth: `query` is the
 * incoming query minus them, which keeps the frozen ingress shape
 * `auth.api.<endpoint>({headers, body, query, asResponse})` intact.
 */
function forwardedQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams.entries()) {
    if (name === "mode" || name === "holdMs") continue;
    query[name] = value;
  }
  return query;
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
    /*
     * ORM drivers wrap the server's error ("Failed query: …\nparams: …") and
     * keep the real message on the innermost cause; the caller gets that, not
     * the echo of the query it just sent.
     */
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
  return {
    status: 500,
    body: {
      code: "COMMAND_FAILED",
      message: String((error as { message?: unknown }).message ?? error),
    },
  };
}

export async function createTransactionHarness(): Promise<TransactionHarness> {
  // Five-URL gate first: shape only, no connection, missing/mis-shaped means
  // blocked — exactly the contract the T01.02 fixture enforces for its island.
  const shapes = new Map<string, BaEndpoint>();
  for (const variable of BA_URL_VARIABLES) {
    const url = parseBaUrl(variable);
    shapes.set(variable, { endpoint: endpointOf(url), database: url.pathname });
  }
  const { connection } = sqlOptions();
  const setup = parseBaUrl("BA_TEST_DATABASE_URL");
  const writerShape = shapes.get("BA_TEST_AUTH_WRITER_DATABASE_URL");
  const setupShape = shapes.get("BA_TEST_DATABASE_URL");
  if (!writerShape || !setupShape) throw new Error("unreachable: URLs parsed");
  if (
    setupShape.endpoint !== writerShape.endpoint ||
    setupShape.database !== writerShape.database
  ) {
    throw new Error(
      `BA_TEST_DATABASE_URL must name the same instance and database as BA_TEST_AUTH_WRITER_DATABASE_URL (${writerShape.endpoint}/${writerShape.database}); it names ${setupShape.endpoint}/${setupShape.database}.`,
    );
  }

  const writerUrl = parseBaUrl("BA_TEST_AUTH_WRITER_DATABASE_URL");
  const client = new SQL({
    adapter: "postgres" as const,
    hostname:
      writerUrl.hostname === "localhost" || writerUrl.hostname === "[::1]"
        ? "127.0.0.1"
        : writerUrl.hostname,
    port: Number(writerUrl.port || 5432),
    username: decodeURIComponent(writerUrl.username),
    password: decodeURIComponent(writerUrl.password),
    database: decodeURIComponent(writerUrl.pathname.replace(/^\//, "")),
    connection,
    max: 4,
    idleTimeout: 5,
    connectionTimeout: 10_000,
    onnotice: () => {},
  });

  const tables = getAuthTables({
    plugins: [organization({ teams: { enabled: true } })],
    emailAndPassword: { enabled: true },
  });
  const drizzleTables = buildDrizzleTables(tables);
  const db = drizzle({ client, schema: drizzleTables });

  await client.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
  for (const statement of buildTableDdl(tables)) {
    await client.unsafe(statement);
  }
  for (const statement of buildCaptureDdl()) {
    await client.unsafe(statement);
  }

  const app = new Hono();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  let resolvedOptions: unknown;
  const auth = betterAuth({
    secret: "t0103-harness-fixed-test-secret-not-a-credential",
    baseURL: baseUrl,
    trustedOrigins: [baseUrl],
    emailAndPassword: { enabled: true },
    plugins: [organization({ teams: { enabled: true } })],
    /*
     * Function form of `database`: the fixed packages hand us the resolved
     * options here, which is exactly what a transaction-bound adapter needs
     * to be built from the same adapter factory as the pool-bound base
     * adapter. The production factory passes `drizzleAdapter(database, …)`
     * the same way (server/src/auth/index.ts); this harness runs that adapter
     * over its own Drizzle instance in the isolated database.
     */
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(db as never, {
        provider: "pg",
        schema: drizzleTables,
        transaction: true,
      })(options as never);
    },
  });
  // Force initialization so a factory error is a fixture failure, not a lazy
  // first-request surprise.
  await auth.$context;

  const bound = createTransactionBoundBa({
    createTxAdapter: (tx: DirectoryTx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: drizzleTables,
        transaction: false,
      })(resolvedOptions as never),
  });

  const firstRow = async <T>(result: unknown): Promise<T> => {
    const rows = (
      Array.isArray(result) ? result : (result as { rows?: T[] }).rows
    ) as T[];
    return rows?.[0];
  };

  async function execute(
    path: string,
    apiMethod: string | null,
    request: Request,
  ): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") === "handler" ? "handler" : "api";
    const holdMs = Math.min(
      Math.max(Number(url.searchParams.get("holdMs")) || 0, 0),
      2_000,
    );
    const bodyText = await request.text();
    const headers = forwardHeaders(request.headers);
    const query = forwardedQuery(url);

    try {
      const outcome = await db.transaction(async (trx) => {
        const identity = await firstRow<{ txid: string; pid: number }>(
          await trx.execute(
            dsql`select txid_current() as txid, pg_backend_pid() as pid`,
          ),
        );
        if (!identity) throw new Error("could not read transaction identity");
        if (holdMs) {
          await trx.execute(dsql`select pg_sleep(${holdMs / 1000})`);
        }

        if (mode === "handler") {
          /*
           * Negative control: the native handler path. auth.handler re-binds
           * the ALS store per request with isTransactionActive:false and opens
           * its own transaction on the pool — under the outer store or not —
           * so the suite can assert the DML txid never equals the executor's.
           */
          const sanitizedQuery = new URLSearchParams(query).toString();
          const response = await auth.handler(
            new Request(
              `${baseUrl}/api/auth${path}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`,
              { method: "POST", headers, body: bodyText },
            ),
          );
          throw new RollbackAfterCapture(response, {
            txid: String(identity.txid),
            backendPid: Number(identity.pid),
          });
        }

        const result = await bound.run(trx as never as DirectoryTx, () =>
          (
            auth.api as unknown as Record<
              string,
              (input: unknown) => Promise<Response>
            >
          )[apiMethod as string]({
            headers,
            body: JSON.parse(bodyText || "{}"),
            query,
            asResponse: true,
          }),
        );
        return {
          response: result.value,
          identity: {
            txid: String(identity.txid),
            backendPid: Number(identity.pid),
          },
          pendingHooks: result.pendingHooks.length,
        };
      });
      const responseHeaders = new Headers(outcome.response.headers);
      responseHeaders.set("x-harness-outer-txid", outcome.identity.txid);
      responseHeaders.set(
        "x-harness-backend-pid",
        String(outcome.identity.backendPid),
      );
      responseHeaders.set("x-harness-mode", mode);
      responseHeaders.set(
        "x-harness-pending-hooks",
        String(outcome.pendingHooks ?? 0),
      );
      return new Response(outcome.response.body, {
        status: outcome.response.status,
        headers: responseHeaders,
      });
    } catch (error) {
      if (error instanceof RollbackAfterCapture) {
        const responseHeaders = new Headers(error.response.headers);
        responseHeaders.set("x-harness-outer-txid", error.identity.txid);
        responseHeaders.set(
          "x-harness-backend-pid",
          String(error.identity.backendPid),
        );
        responseHeaders.set("x-harness-mode", "handler");
        responseHeaders.set("x-harness-pending-hooks", "0");
        return new Response(error.response.body, {
          status: error.response.status,
          headers: responseHeaders,
        });
      }
      const mapped = mapError(error);
      return new Response(JSON.stringify(mapped.body), {
        status: mapped.status,
        headers: { "content-type": "application/json", "x-harness-mode": mode },
      });
    }
  }

  for (const [path, apiMethod] of WRITE_ROUTES) {
    app.post(`/tx${path}`, (context) =>
      execute(path, apiMethod, context.req.raw),
    );
  }
  for (const path of CLOSED_ROUTES) {
    app.post(`/tx${path}`, (context) =>
      context.json({ code: "DIRECTORY_WRITE_DISABLED", path }, 403),
    );
  }

  let closed = false;
  return {
    baseUrl,
    request: (path, init) => fetch(new URL(path, `${baseUrl}/`).href, init),

    async signUp(email, name) {
      const response = await (
        auth.api as unknown as Record<
          string,
          (input: unknown) => Promise<Response>
        >
      ).signUpEmail({
        body: { email, password: DEFAULT_PASSWORD, name },
        asResponse: true,
      });
      if (response.status !== 200) {
        throw new Error(
          `signUpEmail for the harness user failed: ${response.status}`,
        );
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
        sessionToken: body.token,
      };
    },

    async seedOrganization({ id, name, slug }) {
      await client`INSERT INTO "ba_tx_harness".organization (id, name, slug, "createdAt") VALUES (${id}, ${name}, ${slug}, now())`;
    },

    async seedMember({ id, organizationId, userId, role }) {
      await client`INSERT INTO "ba_tx_harness".member (id, "organizationId", "userId", role, "createdAt") VALUES (${id}, ${organizationId}, ${userId}, ${role}, now())`;
    },

    async seedInvitation({
      id,
      organizationId,
      email,
      inviterId,
      role,
      status,
    }) {
      await client`INSERT INTO "ba_tx_harness".invitation (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES (${id}, ${organizationId}, ${email}, ${role ?? "member"}, ${status ?? "pending"}, ${new Date(Date.now() + 86_400_000)}, now(), ${inviterId})`;
    },

    async readInvitation(invitationId) {
      const rows =
        await client`select id, status, "organizationId", email from "ba_tx_harness".invitation where id = ${invitationId}`;
      return (
        rows as unknown as Array<{
          id: string;
          status: string;
          organizationId: string;
          email: string;
        }>
      )[0];
    },

    async readMembers(organizationId) {
      const rows =
        await client`select id, "userId", role from "ba_tx_harness".member where "organizationId" = ${organizationId} order by id`;
      return rows as unknown as Array<{
        id: string;
        userId: string;
        role: string;
      }>;
    },

    async readSessionActiveOrganization(sessionToken) {
      const rows =
        await client`select "activeOrganizationId" from "ba_tx_harness".session where token = ${sessionToken}`;
      const row = (
        rows as unknown as Array<{
          activeOrganizationId: string | null;
        }>
      )[0];
      return row?.activeOrganizationId ?? null;
    },

    async memberIdOf(organizationId, userId) {
      const rows =
        await client`select id from "ba_tx_harness".member where "organizationId" = ${organizationId} and "userId" = ${userId}`;
      return (rows as unknown as Array<{ id: string }>)[0]?.id;
    },

    async dmlEvents() {
      const rows =
        await client`select id, model, txid::text as txid from "ba_tx_harness"."ba_tx_dml_events" order by id`;
      return rows as unknown as DmlEvent[];
    },

    async resetDmlEvents() {
      await client.unsafe(`DELETE FROM "${SCHEMA}"."${DML_EVENTS_TABLE}"`);
    },

    async installMemberFault(userId) {
      await client.unsafe(
        `CREATE TRIGGER "${FAULT_TRIGGER}" BEFORE INSERT ON "${SCHEMA}"."member" FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}"."${FAULT_FUNCTION}"('${userId}')`,
      );
    },

    async removeMemberFault() {
      await client.unsafe(
        `DROP TRIGGER IF EXISTS "${FAULT_TRIGGER}" ON "${SCHEMA}"."member"`,
      );
    },

    async cleanupOutsideExecutor({ organizationId, userId, invitationId }) {
      await client`DELETE FROM "ba_tx_harness".member WHERE "organizationId" = ${organizationId} AND "userId" = ${userId}`;
      await client`UPDATE "ba_tx_harness".invitation SET status = 'pending' WHERE id = ${invitationId}`;
    },

    async leakedResources() {
      const probeUrl = setup;
      const probe = new SQL({
        adapter: "postgres" as const,
        hostname:
          probeUrl.hostname === "localhost" || probeUrl.hostname === "[::1]"
            ? "127.0.0.1"
            : probeUrl.hostname,
        port: Number(probeUrl.port || 5432),
        username: decodeURIComponent(probeUrl.username),
        password: decodeURIComponent(probeUrl.password),
        database: decodeURIComponent(probeUrl.pathname.replace(/^\//, "")),
        max: 1,
      });
      try {
        const rows = await probe`
          SELECT resource FROM (
            SELECT nspname AS resource FROM pg_namespace WHERE nspname = ${SCHEMA}
            UNION ALL
            SELECT n.nspname || '.' || c.relname FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${SCHEMA}
            UNION ALL
            SELECT n.nspname || '.' || p.proname FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = ${SCHEMA}
          ) leaked ORDER BY 1`;
        return (rows as unknown as Array<{ resource: string }>).map((row) =>
          String(row.resource),
        );
      } finally {
        await probe.end({ timeout: 3 });
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      server.stop(true);
      try {
        await client.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      } finally {
        await client.end({ timeout: 3 });
      }
    },
  };
}
