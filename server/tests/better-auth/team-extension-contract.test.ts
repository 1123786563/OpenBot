import { readFileSync } from "node:fs";
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
import {
  afterAll,
  beforeAll,
  expect,
  test,
} from "../../../tests/support/bun-test-compat";
import type {
  DirectoryTx,
  TeamMutationCapability,
} from "../../src/auth/directory/contracts";
import {
  createFixedVersionTeamMemberCommands,
  createScopedTeamExtension,
  issueTeamMutationCapability,
  TEAM_CAPABILITY_ACTION_MISMATCH,
  TEAM_CAPABILITY_ALREADY_CONSUMED,
  TEAM_CAPABILITY_NOT_ISSUED,
  TEAM_CAPABILITY_TARGET_MISMATCH,
  TEAM_CAPABILITY_TRANSACTION_MISMATCH,
  TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING,
  TeamExtensionRefusal,
} from "../../src/auth/directory/team-extension";
import { createTransactionBoundBa } from "../../src/auth/directory/transaction-adapter";

/*
 * The T01.05 (#517) scoped team command contract (interfaces §3, P01):
 * a plain company member holding a team management grant runs exactly that
 * team's add/remove team-member command — through the pinned organization
 * plugin's own adapter helpers, inside the executor's transaction — without
 * an admin session, without a role change, and without a skip-authorization
 * flag. The capability the server issues is single-use and bound to the
 * transaction, the executor store, the action and the target; a capability
 * that crosses a team, a request, a transaction, an action, a target or the
 * object boundary is refused before any DML.
 *
 * Every request here is real HTTP against this suite's own Hono ingress. The
 * ingress authenticates the member through the fixed instance's own
 * `getSession`, resolves the grant in the request's transaction, issues the
 * capability there and consumes it there; the suite's evidence for "the write
 * belongs to the executor's transaction" is the `txid_current()` recorded by a
 * database trigger, compared with the outer transaction's own identity.
 */

const SCHEMA = "ba_t0105_team";
const DML_EVENTS_TABLE = "ba_dml_events";
const GRANTS_TABLE = "ba_team_management_grants";
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

interface HarnessUser {
  userId: string;
  email: string;
  cookie: string;
  sessionToken: string;
}

interface DmlEvent {
  id: number;
  model: string;
  operation: string;
  scopeId: string | null;
  txid: string;
}

interface MemberRow {
  id: string;
  role: string;
}

interface TeamRow {
  id: string;
  organizationId: string;
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

function parseBaUrl(variable: string): URL {
  const raw = process.env[variable]?.trim();
  if (!raw) {
    throw new Error(
      `${variable} is required: the scoped team extension runs only on the five BA_TEST_* URLs of the isolated openbot_enterprise_* database; a missing URL means blocked, not a shared-database fallback.`,
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

function clientFor(url: URL, connection?: { connection: { options: string } }) {
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
    ...(connection ?? {}),
    max: 4,
    idleTimeout: 5,
    connectionTimeout: 10_000,
    onnotice: () => {},
  });
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

/**
 * DML evidence: every team/teamMember write records the transaction it ran in
 * and the team scope it touched, so the suite can prove "this team only" and
 * "this transaction only" from the database itself.
 */
function buildCaptureDdl(): string[] {
  return [
    `CREATE TABLE "${SCHEMA}"."${DML_EVENTS_TABLE}" (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      model text NOT NULL,
      operation text NOT NULL,
      scope_id text,
      txid bigint NOT NULL,
      at timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE FUNCTION "${SCHEMA}"."${CAPTURE_FUNCTION}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE scope text;
BEGIN
  scope := COALESCE(
    to_jsonb(NEW)->>'teamId',
    to_jsonb(OLD)->>'teamId',
    to_jsonb(NEW)->>'id',
    to_jsonb(OLD)->>'id'
  );
  INSERT INTO "${SCHEMA}"."${DML_EVENTS_TABLE}" (model, operation, scope_id, txid)
  VALUES (TG_TABLE_NAME, TG_OP, scope, txid_current());
  RETURN NULL;
END
$fn$`,
    `CREATE TRIGGER "ba_t0105_capture_team" AFTER INSERT OR UPDATE OR DELETE ON "${SCHEMA}"."team" FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}"."${CAPTURE_FUNCTION}"()`,
    `CREATE TRIGGER "ba_t0105_capture_team_member" AFTER INSERT OR UPDATE OR DELETE ON "${SCHEMA}"."teamMember" FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}"."${CAPTURE_FUNCTION}"()`,
    `CREATE TABLE "${SCHEMA}"."${GRANTS_TABLE}" (
      "grantId" text PRIMARY KEY,
      "tenantId" text NOT NULL,
      "workspaceId" text NOT NULL,
      "teamId" text NOT NULL,
      "userId" text NOT NULL,
      actions text[] NOT NULL,
      generation integer NOT NULL,
      status text NOT NULL
    )`,
  ];
}

/** Drizzle table objects for the same models, built from getAuthTables. */
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

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function firstRow<T>(result: unknown): T | undefined {
  return rowsOf<T>(result)[0];
}

type TeamAction = TeamMutationCapability["action"];

interface Harness {
  baseUrl: string;
  request(path: string, init?: RequestInit): Promise<Response>;
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
  seedTeam(input: {
    id: string;
    organizationId: string;
    name: string;
  }): Promise<void>;
  seedGrant(input: {
    grantId: string;
    tenantId: string;
    workspaceId: string;
    teamId: string;
    userId: string;
    actions: readonly TeamAction[];
    generation?: number;
    status?: string;
  }): Promise<void>;
  memberRole(
    organizationId: string,
    userId: string,
  ): Promise<string | undefined>;
  teamMemberRow(
    teamId: string,
    userId: string,
  ): Promise<{ id: string; teamId: string; userId: string } | undefined>;
  adminSessionRows(
    organizationId: string,
  ): Promise<{ id: string; role: string }[]>;
  memberSessionRows(organizationId: string): Promise<{ id: string }[]>;
  sessionCount(): Promise<number>;
  dmlEvents(): Promise<DmlEvent[]>;
  resetDmlEvents(): Promise<void>;
  leakedResources(): Promise<string[]>;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  // Five-URL gate first: shape only, no connection; missing or mis-shaped is
  // blocked, never a fallback to the shared/MT/job-level URLs.
  const shapes = new Map<string, { endpoint: string; database: string }>();
  for (const variable of BA_URL_VARIABLES) {
    const url = parseBaUrl(variable);
    shapes.set(variable, {
      endpoint: endpointOf(url),
      database: url.pathname,
    });
  }
  const setup = parseBaUrl("BA_TEST_DATABASE_URL");
  const writer = parseBaUrl("BA_TEST_AUTH_WRITER_DATABASE_URL");
  const writerShape = shapes.get("BA_TEST_AUTH_WRITER_DATABASE_URL");
  const setupShape = shapes.get("BA_TEST_DATABASE_URL");
  if (
    !writerShape ||
    !setupShape ||
    setupShape.endpoint !== writerShape.endpoint ||
    setupShape.database !== writerShape.database
  ) {
    throw new Error(
      "BA_TEST_DATABASE_URL must name the same instance and database as BA_TEST_AUTH_WRITER_DATABASE_URL.",
    );
  }

  const { connection } = sqlOptions();
  const client = clientFor(writer, { connection });

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
    secret: "t0105-team-extension-fixed-test-secret-not-a-credential",
    baseURL: baseUrl,
    trustedOrigins: [baseUrl],
    emailAndPassword: { enabled: true },
    plugins: [organization({ teams: { enabled: true } })],
    database: (options: unknown) => {
      resolvedOptions = options;
      return drizzleAdapter(db as never, {
        provider: "pg",
        schema: drizzleTables,
        transaction: true,
      })(options as never);
    },
  });
  const authContext = await auth.$context;

  const bound = createTransactionBoundBa({
    createTxAdapter: (tx: DirectoryTx) =>
      drizzleAdapter(tx as never, {
        provider: "pg",
        schema: drizzleTables,
        transaction: false,
      })(resolvedOptions as never),
  });
  // The private seam: the pinned organization plugin's own add/remove
  // helpers, which resolve their adapter through the executor's ALS store.
  const extension = createScopedTeamExtension({
    // The caller's own resolved organization options are the ones the pinned
    // helpers see; this instance enables teams, which the phase's hard
    // precondition requires.
    commands: createFixedVersionTeamMemberCommands(authContext, {
      teams: { enabled: true },
    }),
  });

  /*
   * Test-only capability registry for the replay negative control: a request
   * that issued a capability can hand the exact same object to a later
   * request's transaction. The capability itself never travels over HTTP —
   * only an opaque command key does — so the control exercises the extension's
   * binding, not a transport.
   */
  const issued = new Map<string, TeamMutationCapability>();
  let sequence = 0;

  const table = (name: string) => dsql.raw(`"${SCHEMA}"."${name}"`);

  function refuse(status: number, code: string, message: string): Response {
    return Response.json({ code, message }, { status });
  }

  async function execute(
    request: Request,
    method: "add" | "remove",
    pathTeamId: string,
    pathUserId?: string,
  ): Promise<Response> {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") ?? "execute";
    const commandKey = url.searchParams.get("command") ?? `cmd-${++sequence}`;
    const headers = new Headers(request.headers);

    const session = await auth.api.getSession({
      headers,
      // A session read must not refresh (write) anything: the command's only
      // writes belong to its executor transaction.
      query: { disableRefresh: true },
    });
    if (!session) return refuse(401, "UNAUTHENTICATED", "no live session");
    const actorUserId = session.user.id;
    const actorSessionId = session.session.id;

    let body: Record<string, unknown> = {};
    if (request.method !== "DELETE") {
      body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
    }
    const requestedTarget =
      method === "add" ? String(body.userId ?? "") : String(pathUserId ?? "");
    if (!requestedTarget) {
      return refuse(400, "TARGET_REQUIRED", "the command names no target user");
    }
    const action: TeamAction =
      method === "add" ? "team.member.add" : "team.member.remove";

    let outerTxid: string | null = null;
    let rejection: Response | null = null;
    let outcome: Record<string, unknown> = {};
    try {
      outcome = (await db.transaction(async (trx) => {
        const typedTx = trx as never as DirectoryTx;
        const identity = firstRow<{ txid: string }>(
          await trx.execute(dsql`select txid_current() as txid`),
        );
        if (!identity) throw new Error("could not read transaction identity");
        outerTxid = String(identity.txid);

        const team = firstRow<TeamRow>(
          await trx.execute(
            dsql`select id, "organizationId" from ${table("team")} where id = ${pathTeamId}`,
          ),
        );
        if (!team) {
          rejection = refuse(404, "TEAM_NOT_FOUND", "no such team");
          return { skipped: true };
        }
        const actorMember = firstRow<MemberRow>(
          await trx.execute(
            dsql`select id, role from ${table("member")} where "organizationId" = ${team.organizationId} and "userId" = ${actorUserId}`,
          ),
        );
        if (!actorMember) {
          throw new TeamExtensionRefusal(
            "TEAM_MANAGEMENT_NOT_AUTHORIZED",
            "the actor is not a member of this company",
          );
        }
        if (actorMember.role !== "member") {
          throw new TeamExtensionRefusal(
            "TEAM_MANAGEMENT_NOT_AUTHORIZED",
            "the scoped-manager branch runs as a plain member; company-role authority is the P09 branch and is not exercised here",
          );
        }
        const targetMember = firstRow<MemberRow>(
          await trx.execute(
            dsql`select id, role from ${table("member")} where "organizationId" = ${team.organizationId} and "userId" = ${requestedTarget}`,
          ),
        );
        if (!targetMember) {
          throw new TeamExtensionRefusal(
            "TEAM_MANAGEMENT_NOT_AUTHORIZED",
            "the target is not a member of this company",
          );
        }
        const grant = firstRow<{
          grantId: string;
          workspaceId: string;
          actions: string[];
          generation: number;
        }>(
          await trx.execute(
            dsql`select "grantId", "workspaceId", actions, generation from ${table(GRANTS_TABLE)} where "teamId" = ${pathTeamId} and "userId" = ${actorUserId} and status = 'active'`,
          ),
        );
        if (!grant || !Array.from(grant.actions).includes(action)) {
          throw new TeamExtensionRefusal(
            "TEAM_MANAGEMENT_NOT_AUTHORIZED",
            "no active team management grant covers this team and action",
          );
        }

        const capabilityRequest = {
          commandId: commandKey,
          tenantId: team.organizationId,
          workspaceId: grant.workspaceId,
          teamId: pathTeamId,
          // The trusted actor is built here from the fixed instance's own
          // verified session; P04 brands/registers it. No session, role or
          // skip-authorization flag is fabricated anywhere below.
          actor: {
            userId: actorUserId,
            principalId: null,
            sessionId: actorSessionId,
            kind: "session" as const,
            bindingId: null,
            provisioning: null,
          },
          targetUserId: requestedTarget,
          action,
          authority: {
            kind: "team-grant" as const,
            grantId: grant.grantId,
            grantGeneration: Number(grant.generation),
          },
        };

        let deferred: TeamMutationCapability | null = null;
        const result = await bound.run(typedTx, async () => {
          if (mode === "forged") {
            // A structurally perfect object that no issuer ever created.
            const forged = Object.freeze({
              ...capabilityRequest,
              actor: Object.freeze({ ...capabilityRequest.actor }),
              authority: Object.freeze({ ...capabilityRequest.authority }),
            }) as TeamMutationCapability;
            await extension.add(typedTx, forged, requestedTarget);
            return { executed: true };
          }
          if (mode === "reuse") {
            // Negative control: hand the capability issued by an earlier
            // request to this request's transaction.
            const stored = issued.get(commandKey);
            if (!stored) {
              throw new TeamExtensionRefusal(
                TEAM_CAPABILITY_NOT_ISSUED,
                "no capability was issued for this command key",
              );
            }
            await extension.add(typedTx, stored, requestedTarget);
            return { executed: true };
          }

          const capability = await issueTeamMutationCapability(
            typedTx,
            capabilityRequest,
          );
          issued.set(commandKey, capability);

          if (mode === "issue-only") return { issued: true };
          if (mode === "txn-drift") {
            // Same executor store, different open transaction: the store
            // fence passes, so this isolates the transaction identity fence.
            await db.transaction(async (second) => {
              await extension.add(
                second as never as DirectoryTx,
                capability,
                requestedTarget,
              );
            });
            return { executed: true };
          }
          if (mode === "unbound-consumption") {
            deferred = capability;
            return { issued: true };
          }
          if (mode === "target-drift") {
            const other = String(body.targetUserId ?? "");
            if (!other) {
              throw new TeamExtensionRefusal(
                "TARGET_REQUIRED",
                "target-drift needs body.targetUserId",
              );
            }
            await extension.add(typedTx, capability, other);
            return { executed: true };
          }
          if (mode === "action-drift") {
            await extension.remove(typedTx, capability, requestedTarget);
            return { executed: true };
          }
          if (mode === "double-consume") {
            await extension.add(typedTx, capability, requestedTarget);
            await extension.add(typedTx, capability, requestedTarget);
            return { executed: true };
          }
          if (method === "add") {
            await extension.add(typedTx, capability, requestedTarget);
          } else {
            await extension.remove(typedTx, capability, requestedTarget);
          }
          return { executed: true };
        });

        if (mode === "unbound-consumption" && deferred) {
          // Outside TransactionBoundBa.run: the ALS store is gone, so the
          // capability must be refused instead of writing on the pool.
          await extension.add(typedTx, deferred, requestedTarget);
        }
        return result;
      })) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof TeamExtensionRefusal) {
        return refuse(error.status, error.code, error.message);
      }
      const state = sqlStateOf(error);
      return refuse(
        500,
        state ?? "COMMAND_FAILED",
        String((error as { message?: unknown }).message ?? error),
      );
    }

    if (rejection) return rejection;
    const responseHeaders = new Headers({ "content-type": "application/json" });
    if (outerTxid) responseHeaders.set("x-harness-outer-txid", outerTxid);
    responseHeaders.set("x-harness-mode", mode);
    return new Response(JSON.stringify({ ok: true, ...outcome }), {
      status: 200,
      headers: responseHeaders,
    });
  }

  app.all("/api/auth/*", (context) => auth.handler(context.req.raw));
  app.post("/teams/:teamId/members", (context) =>
    execute(context.req.raw, "add", context.req.param("teamId")),
  );
  app.delete("/teams/:teamId/members/:userId", (context) =>
    execute(
      context.req.raw,
      "remove",
      context.req.param("teamId"),
      context.req.param("userId"),
    ),
  );

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
        throw new Error(`signUpEmail failed: ${response.status}`);
      }
      const setCookie = response.headers.get("set-cookie");
      if (!setCookie) throw new Error("signUpEmail returned no session cookie");
      const payload = (await response.json()) as {
        token: string;
        user: { id: string };
      };
      return {
        userId: payload.user.id,
        email: email.toLowerCase(),
        cookie: setCookie.split(";")[0],
        sessionToken: payload.token,
      };
    },

    async seedOrganization({ id, name, slug }) {
      await client.unsafe(
        `INSERT INTO "${SCHEMA}".organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
        [id, name, slug],
      );
    },

    async seedMember({ id, organizationId, userId, role }) {
      await client.unsafe(
        `INSERT INTO "${SCHEMA}".member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, now())`,
        [id, organizationId, userId, role],
      );
    },

    async seedTeam({ id, organizationId, name }) {
      await client.unsafe(
        `INSERT INTO "${SCHEMA}".team (id, name, "organizationId", "memberCount", "createdAt") VALUES ($1, $2, $3, 0, now())`,
        [id, name, organizationId],
      );
    },

    async seedGrant({
      grantId,
      tenantId,
      workspaceId,
      teamId,
      userId,
      actions,
      generation,
      status,
    }) {
      await client.unsafe(
        `INSERT INTO "${SCHEMA}"."${GRANTS_TABLE}" ("grantId", "tenantId", "workspaceId", "teamId", "userId", actions, generation, status) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)`,
        [
          grantId,
          tenantId,
          workspaceId,
          teamId,
          userId,
          `{${actions.join(",")}}`,
          generation ?? 1,
          status ?? "active",
        ],
      );
    },

    async memberRole(organizationId, userId) {
      const rows = await client.unsafe(
        `select role from "${SCHEMA}".member where "organizationId" = $1 and "userId" = $2`,
        [organizationId, userId],
      );
      return rowsOf<{ role: string }>(rows)[0]?.role;
    },

    async teamMemberRow(teamId, userId) {
      const rows = await client.unsafe(
        `select id, "teamId", "userId" from "${SCHEMA}"."teamMember" where "teamId" = $1 and "userId" = $2`,
        [teamId, userId],
      );
      return rowsOf<{ id: string; teamId: string; userId: string }>(rows)[0];
    },

    async adminSessionRows(organizationId) {
      const rows = await client.unsafe(
        `select s.id, m.role from "${SCHEMA}".session s join "${SCHEMA}".member m on m."userId" = s."userId" where m."organizationId" = $1 and m.role in ('owner', 'admin')`,
        [organizationId],
      );
      return rowsOf<{ id: string; role: string }>(rows);
    },

    async memberSessionRows(organizationId) {
      const rows = await client.unsafe(
        `select s.id from "${SCHEMA}".session s join "${SCHEMA}".member m on m."userId" = s."userId" where m."organizationId" = $1 and m.role = 'member'`,
        [organizationId],
      );
      return rowsOf<{ id: string }>(rows);
    },

    async sessionCount() {
      const rows = await client.unsafe(
        `select count(*)::int as count from "${SCHEMA}".session`,
      );
      return Number(rowsOf<{ count: number }>(rows)[0]?.count ?? 0);
    },

    async dmlEvents() {
      const rows = await client.unsafe(
        `select id, model, operation, scope_id as "scopeId", txid::text as txid from "${SCHEMA}"."${DML_EVENTS_TABLE}" order by id`,
      );
      return rowsOf<DmlEvent>(rows);
    },

    async resetDmlEvents() {
      await client.unsafe(`DELETE FROM "${SCHEMA}"."${DML_EVENTS_TABLE}"`);
    },

    async leakedResources() {
      const probe = clientFor(setup);
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
        return rowsOf<{ resource: string }>(rows).map((row) =>
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

let harness: Harness;
let sequence = 0;

beforeAll(async () => {
  harness = await createHarness();
}, 180_000);

afterAll(async () => {
  if (!harness) return;
  await harness.close();
  expect(await harness.leakedResources()).toEqual([]);
});

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}@example.test`;
}

interface CompanySetup {
  organizationId: string;
  tenantId: string;
  teamA: string;
  teamB: string;
  workspaceId: string;
  plainMember: HarnessUser;
  target: HarnessUser;
  other: HarnessUser;
}

async function setupCompany(prefix: string): Promise<CompanySetup> {
  const plainMember = await harness.signUp(
    unique(`${prefix}-member`),
    `${prefix} member`,
  );
  const target = await harness.signUp(
    unique(`${prefix}-target`),
    `${prefix} target`,
  );
  const other = await harness.signUp(
    unique(`${prefix}-other`),
    `${prefix} other`,
  );
  const organizationId = `org_${prefix}_${process.pid}_${++sequence}`;
  const tenantId = `tenant_${organizationId}`;
  const teamA = `team_a_${organizationId}`;
  const teamB = `team_b_${organizationId}`;
  const workspaceId = `ws_${organizationId}`;

  await harness.seedOrganization({
    id: organizationId,
    name: `${prefix} Company`,
    slug: `${prefix}-${process.pid}-${sequence}`,
  });
  for (const user of [plainMember, target, other]) {
    await harness.seedMember({
      id: `mem_${organizationId}_${user.userId}`,
      organizationId,
      userId: user.userId,
      // Plain member throughout: no owner/admin member exists in this company.
      role: "member",
    });
  }
  await harness.seedTeam({ id: teamA, organizationId, name: "Team A" });
  await harness.seedTeam({ id: teamB, organizationId, name: "Team B" });
  await harness.seedGrant({
    grantId: `grant_${teamA}_${plainMember.userId}`,
    tenantId,
    workspaceId,
    teamId: teamA,
    userId: plainMember.userId,
    actions: ["team.member.add", "team.member.remove"],
  });
  return {
    organizationId,
    tenantId,
    teamA,
    teamB,
    workspaceId,
    plainMember,
    target,
    other,
  };
}

interface PostOptions {
  cookie?: string;
  body?: unknown;
  query?: string;
  method?: "GET" | "POST" | "DELETE";
}

async function post(path: string, options: PostOptions): Promise<Response> {
  return harness.request(`${path}${options.query ?? ""}`, {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function refusal(
  response: Response,
): Promise<{ code: string; message: string }> {
  expect(response.status).toBe(403);
  return (await response.json()) as { code: string; message: string };
}

test("scoped_team_extension_has_no_admin_session", {
  timeout: 120_000,
}, async () => {
  const setup = await setupCompany("no-admin");
  await harness.resetDmlEvents();

  // The native Better Auth endpoint is the control: a plain member has no
  // member:update permission, so this same command is refused there. The
  // scoped path below is not that endpoint, does not fabricate a session,
  // does not change a role and does not set any skipAuthorization flag.
  const native = await post("/api/auth/organization/add-team-member", {
    cookie: setup.plainMember.cookie,
    body: {
      teamId: setup.teamA,
      organizationId: setup.organizationId,
      userId: setup.target.userId,
    },
  });
  expect(native.status).toBe(403);
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();

  const sessionsBefore = await harness.sessionCount();
  await harness.resetDmlEvents();
  const response = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    body: { userId: setup.target.userId },
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { ok: boolean }).ok).toBe(true);

  // The write exists and belongs to the request's own outer transaction.
  const outerTxid = response.headers.get("x-harness-outer-txid");
  expect(outerTxid).toBeTruthy();
  const teamMember = await harness.teamMemberRow(
    setup.teamA,
    setup.target.userId,
  );
  expect(teamMember).toBeTruthy();

  const events = await harness.dmlEvents();
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.txid === outerTxid)).toBe(true);
  expect(
    events.some(
      (event) => event.model === "teamMember" && event.scopeId === setup.teamA,
    ),
  ).toBe(true);
  // The capability's team is the only team the command could touch.
  expect(events.every((event) => event.scopeId !== setup.teamB)).toBe(true);

  // No admin session exists for this company, and the command created none:
  // the only sessions are the plain member sessions the fixture signed up.
  const adminSessionRows = await harness.adminSessionRows(setup.organizationId);
  expect(adminSessionRows).toHaveLength(0);
  expect(
    (await harness.memberSessionRows(setup.organizationId)).length,
  ).toBeGreaterThan(0);
  expect(await harness.sessionCount()).toBe(sessionsBefore);

  // The remove op is the other fixed command: it deletes the pair and
  // releases the team seat inside the same executor transaction.
  await harness.resetDmlEvents();
  const removed = await post(
    `/teams/${setup.teamA}/members/${setup.target.userId}`,
    {
      method: "DELETE",
      cookie: setup.plainMember.cookie,
    },
  );
  expect(removed.status).toBe(200);
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();
  const removeOuterTxid = removed.headers.get("x-harness-outer-txid");
  expect(removeOuterTxid).toBeTruthy();
  const removeEvents = await harness.dmlEvents();
  expect(
    removeEvents.some(
      (event) =>
        event.model === "teamMember" &&
        event.operation === "DELETE" &&
        event.scopeId === setup.teamA,
    ),
  ).toBe(true);
  expect(removeEvents.every((event) => event.txid === removeOuterTxid)).toBe(
    true,
  );

  // The module that authorized this command carries no escape hatch: no
  // fabricated session, no impersonation and no generic skipAuthorization.
  const moduleCode = readFileSync(
    new URL("../../src/auth/directory/team-extension.ts", import.meta.url),
    "utf8",
  )
    // Prose may say what the code must never do; only the code counts.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const banned of [
    "skipAuthorization",
    "impersonat",
    "createSession",
    "signInAs",
  ]) {
    expect(moduleCode.includes(banned)).toBe(false);
  }

  // The member's role is untouched: the capability did not need, create or
  // borrow an admin role.
  expect(
    await harness.memberRole(setup.organizationId, setup.plainMember.userId),
  ).toBe("member");
  expect(
    await harness.memberRole(setup.organizationId, setup.target.userId),
  ).toBe("member");
});

test("capability_cannot_cross_team_or_request", {
  timeout: 120_000,
}, async () => {
  const setup = await setupCompany("cross");

  // (a) Team B: the plain member holds a grant for team A only, so the
  // request is refused before any capability is issued or any DML happens.
  await harness.resetDmlEvents();
  const crossTeam = await post(`/teams/${setup.teamB}/members`, {
    cookie: setup.plainMember.cookie,
    body: { userId: setup.target.userId },
  });
  const status = crossTeam.status;
  expect(status).toBe(403);
  const crossTeamBody = (await crossTeam.json()) as { code: string };
  expect(crossTeamBody.code).toBe("TEAM_MANAGEMENT_NOT_AUTHORIZED");
  expect(
    await harness.teamMemberRow(setup.teamB, setup.target.userId),
  ).toBeUndefined();
  expect(await harness.dmlEvents()).toEqual([]);

  // (b) Second request: a capability issued in one request/transaction is
  // handed — test-only, through the in-process registry, never over HTTP —
  // to a later request's transaction. It must be refused before DML.
  const issued = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=issue-only&command=cmd-replay",
    body: { userId: setup.target.userId },
  });
  expect(issued.status).toBe(200);
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();

  await harness.resetDmlEvents();
  const replay = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=reuse&command=cmd-replay",
    body: { userId: setup.target.userId },
  });
  const replayStatus = replay.status;
  expect(replayStatus).toBe(403);
  const replayBody = (await replay.json()) as { code: string };
  expect(replayBody.code).toBe(TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING);
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();
  expect(await harness.dmlEvents()).toEqual([]);
});

test("capability_cannot_be_forged_rebound_or_reused", {
  timeout: 120_000,
}, async () => {
  const setup = await setupCompany("binding");

  // A structurally valid object no issuer created is not a capability.
  await harness.resetDmlEvents();
  const forged = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=forged",
    body: { userId: setup.target.userId },
  });
  expect((await refusal(forged)).code).toBe(TEAM_CAPABILITY_NOT_ISSUED);
  expect(await harness.dmlEvents()).toEqual([]);

  // A different target under the same capability is refused.
  await harness.resetDmlEvents();
  const targetDrift = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=target-drift",
    body: { userId: setup.target.userId, targetUserId: setup.other.userId },
  });
  expect((await refusal(targetDrift)).code).toBe(
    TEAM_CAPABILITY_TARGET_MISMATCH,
  );
  expect(
    await harness.teamMemberRow(setup.teamA, setup.other.userId),
  ).toBeUndefined();
  expect(await harness.dmlEvents()).toEqual([]);

  // An add capability cannot drive the remove operation.
  await harness.resetDmlEvents();
  const actionDrift = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=action-drift",
    body: { userId: setup.target.userId },
  });
  expect((await refusal(actionDrift)).code).toBe(
    TEAM_CAPABILITY_ACTION_MISMATCH,
  );
  expect(await harness.dmlEvents()).toEqual([]);

  // The same capability cannot be spent twice, even inside one transaction
  // and even before the first write fails.
  await harness.resetDmlEvents();
  const doubled = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=double-consume",
    body: { userId: setup.target.userId },
  });
  expect((await refusal(doubled)).code).toBe(TEAM_CAPABILITY_ALREADY_CONSUMED);
  // The whole transaction rolled back: the refused replay left no row.
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();

  // Consuming outside the executor's transaction-bound store is refused
  // instead of writing on the pool.
  await harness.resetDmlEvents();
  const unbound = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=unbound-consumption",
    body: { userId: setup.target.userId },
  });
  expect((await refusal(unbound)).code).toBe(
    TEAM_CAPABILITY_WITHOUT_TRANSACTION_BINDING,
  );
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();
  expect(await harness.dmlEvents()).toEqual([]);
});

test("capability_reports_a_transaction_mismatch_for_a_reissued_binding", {
  timeout: 120_000,
}, async () => {
  /*
   * The transaction fence itself, isolated from the store fence: issue the
   * capability, then consume it from the same executor run but with a
   * different open transaction. The ingress's `txn-drift` mode opens a
   * second transaction after the capability was issued in the first one and
   * passes it to the extension, so the ALS store is still the executor's but
   * the transaction identity is not.
   */
  const setup = await setupCompany("txn-drift");
  await harness.resetDmlEvents();
  const response = await post(`/teams/${setup.teamA}/members`, {
    cookie: setup.plainMember.cookie,
    query: "?mode=txn-drift",
    body: { userId: setup.target.userId },
  });
  expect((await refusal(response)).code).toBe(
    TEAM_CAPABILITY_TRANSACTION_MISMATCH,
  );
  expect(
    await harness.teamMemberRow(setup.teamA, setup.target.userId),
  ).toBeUndefined();
  expect(await harness.dmlEvents()).toEqual([]);
});
