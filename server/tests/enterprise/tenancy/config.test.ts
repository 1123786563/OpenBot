import { describe, expect, test } from "bun:test";
import { loadConfig, loadIdentityConfig } from "../../../src/config";
import {
  APPROVED_AUTH_ROUTES,
  canonicalAuthRoute,
  REQUIRED_AUTH_ROUTES,
} from "../../../src/enterprise/auth-route-profile";
import {
  assertNoDevelopmentIdentity,
  loadEnterpriseConfig,
  selectAuthRoutes,
} from "../../../src/enterprise/config";
import { testEnvironment } from "../../support/environment";

/*
 * The standalone enterprise entry's configuration, per plan 02 §7 T3-B.
 *
 * The load-bearing claim under test is the split itself: an identity configuration can be resolved
 * from verified identity-provider fields ALONE, with no Intelligence, no managed agent and no
 * transcription/voice settings anywhere in the environment — while the legacy `loadConfig` keeps
 * refusing exactly such an environment. The enterprise loader additionally refuses development
 * identities, refuses wildcard or encoded auth routes, requires the three database URLs to name
 * one database through three different logins, and bounds its port and shutdown window.
 *
 * No database is opened by anything here; URL strings are parsed, never dialed.
 */

/*
 * The identity-provider fields from the shared test environment, PICKED ONE BY ONE rather than
 * spread. Spreading would smuggle in INTELLIGENCE_* and MANAGED_AGENT_* — the very variables the
 * enterprise entry must not require — and the test would then prove nothing about independence.
 */
const base = testEnvironment();
const IDENTITY_ONLY = {
  GOOGLE_OAUTH_CLIENT_ID: base.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: base.GOOGLE_OAUTH_CLIENT_SECRET,
  BETTER_AUTH_SECRET: base.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: base.BETTER_AUTH_URL,
  INITIAL_ADMIN_EMAILS: base.INITIAL_ADMIN_EMAILS,
};

/** A real 32-byte key (not the public `.env.example` placeholder), so key checks pass on merit. */
const REAL_KEY = "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=";

/*
 * The three enterprise logins: one database, three distinct restricted roles — the shape
 * loadEnterpriseConfig demands. The usernames and the database name are the parts under test;
 * the passwords are DELIBERATELY NOT the test database's real ones (those live only in the
 * gitignored env file), because this file is committed and a URL nobody can dial is all the
 * assertion needs: no connection is made, loadEnterpriseConfig only parses.
 */
const SAME_DATABASE_URLS = {
  ENTERPRISE_AUTH_DATABASE_URL:
    "postgres://ent_identity:ent-identity-not-a-secret@127.0.0.1:5434/openbot_enterprise_test",
  ENTERPRISE_DIRECTORY_DATABASE_URL:
    "postgres://ent_directory:ent-directory-not-a-secret@127.0.0.1:5434/openbot_enterprise_test",
  ENTERPRISE_DATA_DATABASE_URL:
    "postgres://ent_data:ent-data-not-a-secret@127.0.0.1:5434/openbot_enterprise_test",
};

const ENTERPRISE_BASE = {
  ...IDENTITY_ONLY,
  ...SAME_DATABASE_URLS,
  KEY_ENCRYPTION_KEY: REAL_KEY,
  ENTERPRISE_PORT: "3101",
  ENTERPRISE_HOSTNAME: "127.0.0.1",
  ENTERPRISE_SHUTDOWN_GRACE_MS: "15000",
  ENTERPRISE_ALLOWED_ORIGINS: "http://127.0.0.1:3010",
  ENTERPRISE_AUTH_ROUTES: JSON.stringify([...REQUIRED_AUTH_ROUTES]),
};

describe("the identity configuration split (plan 02 T3-B)", () => {
  test("resolves sign-in from identity fields alone, with no Intelligence configured", () => {
    const auth = loadIdentityConfig(IDENTITY_ONLY);

    expect(auth?.google?.clientId).toBe("google-client-id");
    expect(auth?.baseUrl).toBe("http://localhost:3001");
    expect(auth?.initialAdminEmails).toEqual(["admin@openbot.test"]);
  });

  test("a secret with no provider is the existing configuration error, not a new one", () => {
    // Both halves of the Google pair go away together, or oauthClient refuses the half-configured
    // provider first; the case under test is a session secret with no provider at all.
    expect(() =>
      loadIdentityConfig({
        ...IDENTITY_ONLY,
        GOOGLE_OAUTH_CLIENT_ID: undefined,
        GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      }),
    ).toThrow(
      "BETTER_AUTH_SECRET or BETTER_AUTH_URL is set but no identity provider is",
    );
  });

  test("a provider with no session secret refuses with the existing error", () => {
    expect(() =>
      loadIdentityConfig({ ...IDENTITY_ONLY, BETTER_AUTH_SECRET: undefined }),
    ).toThrow("Sign-in requires BETTER_AUTH_SECRET");
  });

  test("the legacy loadConfig still refuses an identity-only environment", () => {
    // DATABASE_URL and a real key are supplied so the refusal under test is the runtime one, not
    // the database URL's: the legacy entry keeps requiring Intelligence, un-loosened by the split.
    expect(() =>
      loadConfig({
        ...IDENTITY_ONLY,
        DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
        KEY_ENCRYPTION_KEY: REAL_KEY,
      }),
    ).toThrow(/CopilotKit Intelligence is required/);
  });
});

describe("the enterprise entry configuration", () => {
  test("loads from an environment with no Intelligence, model or managed-agent variables", () => {
    const config = loadEnterpriseConfig(ENTERPRISE_BASE);

    expect(config.port).toBe(3101);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.shutdownGraceMs).toBe(15000);
    expect(config.auth.google?.clientId).toBe("google-client-id");
    expect(config.keyEncryptionKey).toBe(REAL_KEY);
    expect(config.authDatabaseUrl).toBe(
      SAME_DATABASE_URLS.ENTERPRISE_AUTH_DATABASE_URL,
    );
    expect(config.directoryDatabaseUrl).toBe(
      SAME_DATABASE_URLS.ENTERPRISE_DIRECTORY_DATABASE_URL,
    );
    expect(config.dataDatabaseUrl).toBe(
      SAME_DATABASE_URLS.ENTERPRISE_DATA_DATABASE_URL,
    );
    expect([...config.allowedOrigins]).toEqual(["http://127.0.0.1:3010"]);
    expect([...config.authRoutes].sort()).toEqual(
      [...REQUIRED_AUTH_ROUTES].sort(),
    );
  });

  test("a missing identity provider stops the enterprise entry", () => {
    const environment = { ...ENTERPRISE_BASE };
    delete environment.GOOGLE_OAUTH_CLIENT_ID;
    delete environment.GOOGLE_OAUTH_CLIENT_SECRET;
    delete environment.BETTER_AUTH_SECRET;
    delete environment.BETTER_AUTH_URL;

    expect(() => loadEnterpriseConfig(environment)).toThrow(
      /identity provider/,
    );
  });

  test.each([
    ["OPENBOT_SINGLE_USER", "true"],
    ["OPENBOT_SINGLE_USER", "1"],
    ["OPENBOT_DEV_NO_AUTH", "yes"],
  ])("refuses the development identity %s=%s", (name, value) => {
    expect(() =>
      loadEnterpriseConfig({ ...ENTERPRISE_BASE, [name]: value }),
    ).toThrow(new RegExp(`${name} forbidden in enterprise entry`));
    expect(() => assertNoDevelopmentIdentity({ [name]: value })).toThrow(
      `${name} forbidden in enterprise entry`,
    );
  });

  test.each([
    ["OPENBOT_SINGLE_USER", "0"],
    ["OPENBOT_SINGLE_USER", "false"],
    ["OPENBOT_DEV_NO_AUTH", "FALSE"],
  ])("accepts an explicit off (%s=%s)", (name, value) => {
    expect(() => assertNoDevelopmentIdentity({ [name]: value })).not.toThrow();
    expect(() =>
      loadEnterpriseConfig({ ...ENTERPRISE_BASE, [name]: value }),
    ).not.toThrow();
  });

  test("reuses the existing key format validation: a non-empty string is not a key", () => {
    expect(() =>
      loadEnterpriseConfig({
        ...ENTERPRISE_BASE,
        KEY_ENCRYPTION_KEY: "definitely-not-base64-32",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });

  test.each([
    ["0", /ENTERPRISE_PORT/],
    ["65536", /ENTERPRISE_PORT/],
    ["30o1", /ENTERPRISE_PORT/],
  ])(
    "the port is a bounded whole number (ENTERPRISE_PORT=%s)",
    (raw, pattern) => {
      expect(() =>
        loadEnterpriseConfig({ ...ENTERPRISE_BASE, ENTERPRISE_PORT: raw }),
      ).toThrow(pattern);
    },
  );

  test.each([["0"], ["-1"], ["999999999"], ["soon"]])(
    "the shutdown window is a bounded whole number (ENTERPRISE_SHUTDOWN_GRACE_MS=%s)",
    (raw) => {
      expect(() =>
        loadEnterpriseConfig({
          ...ENTERPRISE_BASE,
          ENTERPRISE_SHUTDOWN_GRACE_MS: raw,
        }),
      ).toThrow(/ENTERPRISE_SHUTDOWN_GRACE_MS/);
    },
  );

  test("three database URLs must name one database", () => {
    expect(() =>
      loadEnterpriseConfig({
        ...ENTERPRISE_BASE,
        ENTERPRISE_DATA_DATABASE_URL:
          "postgres://ent_data:ent-data-not-a-secret@127.0.0.1:5434/openbot_other_test",
      }),
    ).toThrow(/one approved database/);
  });

  test("three database URLs must use three different login roles", () => {
    expect(() =>
      loadEnterpriseConfig({
        ...ENTERPRISE_BASE,
        ENTERPRISE_DATA_DATABASE_URL:
          "postgres://ent_directory:ent-directory-not-a-secret@127.0.0.1:5434/openbot_enterprise_test",
      }),
    ).toThrow(/distinct login roles/);
  });

  test.each([
    ["a path is not an origin", "http://127.0.0.1:3010/app"],
    ["a wildcard is not an origin", "*"],
    ["a wildcard subdomain is not an origin", "https://*.example.test"],
    ["a bare host is not an origin", "127.0.0.1:3010"],
  ])("allowedOrigins refuses %s", (_reason, raw) => {
    expect(() =>
      loadEnterpriseConfig({
        ...ENTERPRISE_BASE,
        ENTERPRISE_ALLOWED_ORIGINS: raw,
      }),
    ).toThrow(/ENTERPRISE_ALLOWED_ORIGINS/);
  });
});

describe("the compiled auth route profile", () => {
  test("every approved entry is canonical, method uppercase, no wildcard", () => {
    for (const entry of APPROVED_AUTH_ROUTES) {
      expect(canonicalAuthRoute(entry)).toBe(entry);
      expect(entry).not.toMatch(/\*/);
    }
  });

  test("SCIM, SSO registration, organization and desktop endpoints are absent", () => {
    for (const forbidden of [
      "/api/auth/scim/v2/Users",
      "/api/auth/sso/register",
      "/api/auth/sso/update-provider",
      "/api/auth/electron/token",
      "/api/auth/electron/init-oauth-proxy",
      "/api/auth/electron/transfer-user",
      "/api/auth/organization",
    ]) {
      for (const entry of APPROVED_AUTH_ROUTES) {
        expect(entry.endsWith(forbidden)).toBe(false);
      }
    }
  });

  test("the required routes are a subset of the approved set", () => {
    for (const required of REQUIRED_AUTH_ROUTES) {
      expect(APPROVED_AUTH_ROUTES.has(required)).toBe(true);
    }
  });

  test.each([
    "GET /api/auth//get-session",
    "GET /api/auth/get-session/",
    "POST /api/auth/callback/%2Fgoogle",
    "get /api/auth/get-session",
    "GET api/auth/get-session",
    "GET /api/auth/../get-session",
    "GET /api/auth/./get-session",
    "GET /api/auth/get-session?x=1",
    "GET /api/auth/get-session#frag",
    "GET\\ /api/auth/get-session",
  ])("non-canonical route %s is rejected", (entry) => {
    expect(canonicalAuthRoute(entry)).toBeNull();
  });
});

describe("selectAuthRoutes fails closed", () => {
  test("an approved subset is returned exactly", () => {
    const chosen = selectAuthRoutes(
      ["GET /api/auth/get-session", "POST /api/auth/sign-out"],
      APPROVED_AUTH_ROUTES,
    );
    expect([...chosen].sort()).toEqual([
      "GET /api/auth/get-session",
      "POST /api/auth/sign-out",
    ]);
  });

  test.each([
    ["not an array", "GET /api/auth/get-session"],
    ["empty", []],
    ["a non-string entry", [42]],
    ["an unapproved route", ["GET /api/auth/scim/v2/Users"]],
    ["a wildcard", ["* /api/auth/*"]],
    ["SSO registration", ["POST /api/auth/sso/register"]],
    ["a desktop endpoint", ["POST /api/auth/electron/token"]],
    ["an encoded separator", ["GET /api/auth/callback/%2Fgoogle"]],
    ["a duplicate slash", ["GET /api/auth//get-session"]],
    ["a dot segment", ["GET /api/auth/../get-session"]],
  ])("rejects %s", (_reason, selected) => {
    expect(() => selectAuthRoutes(selected, APPROVED_AUTH_ROUTES)).toThrow(
      "INVALID_AUTH_ROUTE_SELECTION",
    );
  });

  test("selection cannot extend the compiled set from the environment", () => {
    expect(() =>
      selectAuthRoutes(["POST /api/auth/ok"], APPROVED_AUTH_ROUTES),
    ).toThrow("INVALID_AUTH_ROUTE_SELECTION");
  });

  test("an enterprise config missing a required auth route refuses to start", () => {
    expect(() =>
      loadEnterpriseConfig({
        ...ENTERPRISE_BASE,
        ENTERPRISE_AUTH_ROUTES: JSON.stringify(["GET /api/auth/get-session"]),
      }),
    ).toThrow(/ENTERPRISE_AUTH_ROUTES/);
  });
});
