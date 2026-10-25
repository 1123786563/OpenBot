import { Hono } from "hono";
import postgres from "postgres";
import {
  BA_FIXTURE_MARKERS_TABLE,
  BA_FIXTURE_NOTES_TABLE,
  BA_FIXTURE_SCHEMA,
  BA_FIXTURE_SNAPSHOT_SQL,
  CREATE_BA_FIXTURE_SCHEMA_SQL,
  CREATE_BA_FIXTURE_TABLES_SQL,
  DROP_BA_FIXTURE_SCHEMA_SQL,
  LEAKED_BA_FIXTURE_RESOURCES_SQL,
} from "./schema";

/*
 * createBaFixture — the better-auth suite fixture (T01.02, acceptance V-B):
 * a real database reached through the five restricted BA_TEST_* role URLs, a
 * real HTTP plane (Hono on Bun's server, exercised with fetch), fault
 * injection, snapshots, and cleanup that removes only what the fixture itself
 * created.
 *
 * All five URL variables are required: a missing one is a blocked fixture
 * (thrown before anything dials), never a quiet downgrade to the shared, MT,
 * or job-level URLs. The URLs must name one loopback openbot_enterprise_*
 * database — the same-database check compares endpoints and decoded database
 * names, so an escaped-spelling sibling cannot pass for isolation. No DSN is
 * ever printed: refusals name the variable and the sanitized endpoint only.
 */

const BA_SETUP_VARIABLE = "BA_TEST_DATABASE_URL";
const BA_ROLE_VARIABLES = [
  "BA_TEST_DIRECTORY_DATABASE_URL",
  "BA_TEST_DATA_DATABASE_URL",
  "BA_TEST_OPERATOR_DATABASE_URL",
  "BA_TEST_AUTH_WRITER_DATABASE_URL",
] as const;

export interface BaFixtureRole {
  /** The BA_TEST_* variable the role URL came from. */
  variable: string;
  /** The LOGIN role the URL dials as (session_user once connected). */
  login: string;
  /** The NOLOGIN capability role the session is pinned to (current_user). */
  capability: string;
  sessionUser: string;
  actualRole: string;
}

export interface BaFixtureSnapshot {
  notes: number;
  markers: number;
}

export interface BaFixture {
  /** Loopback origin the HTTP plane is served on (port assigned at start). */
  baseUrl: string;
  /** A real fetch against the fixture's own Hono app. */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** One dial per restricted role URL, reporting the roles the session lands in. */
  roles(): Promise<BaFixtureRole[]>;
  /** Row counts of the fixture's plugin tables. */
  snapshot(): Promise<BaFixtureSnapshot>;
  /** Fails the HTTP handler on demand, without killing the fixture. */
  injectFault(mode: "none" | "handler"): void;
  /** Fixture-owned namespaces/relations still present, probed via the setup URL. */
  leakedResources(): Promise<string[]>;
  /** Stops the server and drops the fixture's schema. Idempotent. */
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

interface BaEndpoint {
  endpoint: string;
  database: string;
}

function requireBaUrl(variable: string): string {
  const raw = process.env[variable]?.trim();
  if (!raw) {
    throw new Error(
      `${variable} is required: a better-auth fixture runs only on its five BA_TEST_* role URLs and does not inherit TEST_DATABASE_URL/DATABASE_URL/MT_TEST_*/ENTERPRISE_TEST_*; missing URL means blocked, not shared-database fallback.`,
    );
  }
  return raw;
}

/** Loopback + enterprise-database-name shape, with no credential in the error. */
function validateBaUrlShape(variable: string, raw: string): BaEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a PostgreSQL URL.`);
  }
  const databaseName = (candidate: URL) => {
    try {
      return decodeURIComponent(
        candidate.pathname.replace(/^\//, "").replace(/\/+$/, ""),
      );
    } catch {
      return "";
    }
  };
  if (
    !/^postgres(?:ql)?:$/.test(url.protocol) ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    !databaseName(url)
  ) {
    throw new Error(
      `${variable} must be a loopback PostgreSQL URL naming an enterprise test database.`,
    );
  }
  const database = databaseName(url);
  if (!/^openbot_enterprise_/.test(database)) {
    throw new Error(
      `${variable} must name an openbot_enterprise_* database, not "${database}".`,
    );
  }
  if (url.hash) {
    throw new Error(`${variable} must not include a URL fragment.`);
  }
  const host =
    url.hostname === "localhost" || url.hostname === "[::1]"
      ? "127.0.0.1"
      : url.hostname;
  return { endpoint: `${host}:${url.port || "5432"}`, database };
}

/*
 * The restricted-role URL contract: the login is `ent_ba_<role>`, pinned at
 * dial time to the `ob_ent_<role>` capability through the PostgreSQL startup
 * option. The auth-writer URL must already carry exactly that option; the
 * other role URLs carry none and get theirs appended here, mirroring
 * server/tests/support/enterprise-database.ts without inheriting its job-level
 * variable names.
 */
function restrictedRoleOf(
  variable: string,
  raw: string,
): {
  url: string;
  login: string;
  capability: string;
} {
  const url = new URL(raw);
  let login: string;
  try {
    login = decodeURIComponent(url.username);
  } catch {
    throw new Error(
      `${variable} carries invalid percent-encoding in its userinfo.`,
    );
  }
  const role = /^ent_ba_([a-z0-9_]+)$/.exec(login)?.[1];
  if (!role) {
    throw new Error(
      `${variable} must dial an ent_ba_* restricted test login, not "${login}".`,
    );
  }
  const capability = `ob_ent_${role}`;
  const expectedOption = `-c role=${capability}`;
  const options = url.searchParams.getAll("options");
  if (
    options.length > 1 ||
    (options.length === 1 && options[0] !== expectedOption)
  ) {
    throw new Error(
      `${variable} must pin its session to ${capability} via "${expectedOption}".`,
    );
  }
  if (options.length === 1) {
    // searchParams decodes "+" as a space, but libpq reads a literal "+": a
    // plus-spelled option would dial the login role un-pinned.
    const rawOptions = url.search.match(/[?&]options=([^&]*)/)?.[1] ?? "";
    if (rawOptions.includes("+")) {
      throw new Error(
        `${variable} spells its options with a literal "+", which libpq reads literally; percent-encode the space as %20.`,
      );
    }
    return { url: raw, login, capability };
  }
  let separator = "?";
  if (/[?&]$/.test(raw)) separator = "";
  else if (raw.includes("?")) separator = "&";
  return {
    url: `${raw}${separator}options=${encodeURIComponent(expectedOption)}`,
    login,
    capability,
  };
}

function readBaFixtureUrls(): {
  setup: string;
  roles: { variable: string; url: string; login: string; capability: string }[];
} {
  const setup = requireBaUrl(BA_SETUP_VARIABLE);
  const setupShape = validateBaUrlShape(BA_SETUP_VARIABLE, setup);
  const roles = BA_ROLE_VARIABLES.map((variable) => {
    const { url, login, capability } = restrictedRoleOf(
      variable,
      requireBaUrl(variable),
    );
    return { variable, url, login, capability };
  });
  // All five URLs must be the same instance and the same database: that is
  // what makes the role split isolation instead of a second database.
  for (const role of roles) {
    const shape = validateBaUrlShape(role.variable, role.url);
    if (
      shape.endpoint !== setupShape.endpoint ||
      shape.database !== setupShape.database
    ) {
      throw new Error(
        `${role.variable} must point at the same PostgreSQL instance and database as ${BA_SETUP_VARIABLE} (${setupShape.endpoint}/${setupShape.database}); it names ${shape.endpoint}/${shape.database}.`,
      );
    }
  }
  return { setup, roles };
}

export async function createBaFixture(): Promise<BaFixture> {
  const { setup: setupUrl, roles: roleUrls } = readBaFixtureUrls();

  // Setup connection: leak probing only. Every write the fixture performs goes
  // through the restricted auth-writer capability below. The fixture's own DDL
  // NOTICEs (IF NOT EXISTS, DROP ... CASCADE) are postgres-server chatter, not
  // suite output, so they do not belong in the test log.
  const setup = postgres(setupUrl, {
    max: 1,
    idle_timeout: 5,
    onnotice: () => {},
  });
  const writerUrl = roleUrls.find(
    (role) => role.capability === "ob_ent_auth_writer",
  );
  if (!writerUrl) {
    await setup.end({ timeout: 5 }).catch(() => {});
    throw new Error(
      "BA_TEST_AUTH_WRITER_DATABASE_URL must dial the ob_ent_auth_writer capability.",
    );
  }
  const writer = postgres(writerUrl.url, {
    max: 2,
    idle_timeout: 5,
    onnotice: () => {},
  });

  // The plugin schema is created by the restricted capability itself: that is
  // what proves the grant, not a superuser creating it on the role's behalf.
  await writer.unsafe(CREATE_BA_FIXTURE_SCHEMA_SQL);
  for (const ddl of CREATE_BA_FIXTURE_TABLES_SQL) {
    await writer.unsafe(ddl);
  }

  // HTTP plane: a Hono app on Bun's server, bound to loopback on an
  // ephemeral port, so suite requests are real fetches over TCP.
  let fault: "none" | "handler" = "none";
  const app = new Hono();
  app.onError((error, context) => context.json({ error: error.message }, 500));
  app.get("/ba-fixture/whoami", async (context) => {
    const [row] =
      await writer`SELECT current_user AS role, session_user AS session`;
    return context.json({ role: row?.role, session: row?.session });
  });
  app.post("/ba-fixture/notes", async (context) => {
    if (fault === "handler") {
      throw new Error("injected handler fault (ba fixture)");
    }
    const body = await context.req.json().catch(() => ({}));
    if (typeof body?.note !== "string" || !body.note) {
      return context.json({ error: "note is required" }, 400);
    }
    const [row] = await writer`
      INSERT INTO ${writer(BA_FIXTURE_SCHEMA)}.${writer(BA_FIXTURE_NOTES_TABLE)} (note)
      VALUES (${body.note})
      RETURNING id
    `;
    return context.json({ id: row?.id }, 201);
  });
  app.post("/ba-fixture/markers", async (context) => {
    if (fault === "handler") {
      throw new Error("injected handler fault (ba fixture)");
    }
    const body = await context.req.json().catch(() => ({}));
    if (typeof body?.marker !== "string" || !body.marker) {
      return context.json({ error: "marker is required" }, 400);
    }
    await writer`
      INSERT INTO ${writer(BA_FIXTURE_SCHEMA)}.${writer(BA_FIXTURE_MARKERS_TABLE)} (marker)
      VALUES (${body.marker})
    `;
    return context.json({}, 201);
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    server.stop(true);
    try {
      // Only the fixture's own schema: nothing the corpus or another suite
      // created is ever touched by this teardown.
      await writer.unsafe(DROP_BA_FIXTURE_SCHEMA_SQL);
    } finally {
      await writer.end({ timeout: 5 }).catch(() => {});
      await setup.end({ timeout: 5 }).catch(() => {});
    }
  };

  return {
    baseUrl,
    request: (path, init) => fetch(new URL(path, `${baseUrl}/`).href, init),
    roles: async () => {
      const reports: BaFixtureRole[] = [];
      for (const role of roleUrls) {
        const dial = postgres(role.url, { max: 1 });
        try {
          const [row] =
            await dial`SELECT current_user AS actual_role, session_user AS session_user`;
          reports.push({
            variable: role.variable,
            login: role.login,
            capability: role.capability,
            sessionUser: row?.session_user ?? "",
            actualRole: row?.actual_role ?? "",
          });
        } finally {
          await dial.end({ timeout: 5 }).catch(() => {});
        }
      }
      return reports;
    },
    snapshot: async () => {
      const [row] = await writer.unsafe(BA_FIXTURE_SNAPSHOT_SQL);
      return {
        notes: Number(row?.notes ?? 0),
        markers: Number(row?.markers ?? 0),
      };
    },
    injectFault: (mode) => {
      fault = mode;
    },
    leakedResources: async () => {
      // A fresh short-lived setup connection, so the probe works after close()
      // has already released the fixture's own pools.
      const probe = postgres(setupUrl, { max: 1 });
      try {
        const rows = await probe.unsafe(LEAKED_BA_FIXTURE_RESOURCES_SQL);
        return rows.map((row) =>
          String((row as { resource: string }).resource),
        );
      } finally {
        await probe.end({ timeout: 5 }).catch(() => {});
      }
    },
    close,
  };
}
