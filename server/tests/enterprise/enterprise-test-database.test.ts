import { expect, test } from "../../../tests/support/e2e-compat";
import {
  assertFreshSetupDatabaseIdentity,
  parseRuntimeTestLogin,
} from "../../scripts/enterprise-test-db-guard";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseNameFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const officialSetup =
  "postgres://openbot:unused@127.0.0.1:5435/openbot_enterprise_test";
const reservedCiSetup =
  "postgres://setup:unused@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009";

test("accepts every loopback enterprise test database named by the environment", () => {
  for (const url of [officialSetup, reservedCiSetup]) {
    expect(
      enterpriseTestDatabaseUrlFrom({
        ENTERPRISE_TEST_SETUP_DATABASE_URL: url,
      }),
    ).toBe(url);
  }
  for (const name of ["openbot", "another_db", "company_enterprise_prod_copy"]) {
    expect(() =>
      enterpriseTestDatabaseUrlFrom({
        ENTERPRISE_TEST_SETUP_DATABASE_URL: `postgres://setup:unused@127.0.0.1:5434/${name}`,
      }),
    ).toThrow("must name an openbot_enterprise_* test database");
  }
  expect(() =>
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL:
        "postgres://setup:unused@db.internal:5432/openbot_enterprise_test",
    }),
  ).toThrow(
    "must be a loopback PostgreSQL URL naming an enterprise test database.",
  );
  expect(() => enterpriseTestDatabaseUrlFrom({})).toThrow(
    "ENTERPRISE_TEST_SETUP_DATABASE_URL or TEST_DATABASE_URL is required",
  );
});

test("falls back to the official TEST_DATABASE_URL when no setup URL is pinned", () => {
  expect(
    enterpriseTestDatabaseUrlFrom({ TEST_DATABASE_URL: officialSetup }),
  ).toBe(officialSetup);
  expect(
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL: "",
      TEST_DATABASE_URL: officialSetup,
    }),
  ).toBe(officialSetup);
  expect(
    enterpriseTestDatabaseUrlFrom({
      TEST_DATABASE_URL: `${officialSetup}\n`,
    }),
  ).toBe(officialSetup);
  expect(() =>
    enterpriseTestDatabaseUrlFrom({
      TEST_DATABASE_URL: "postgres://openbot:unused@127.0.0.1:5432/openbot",
    }),
  ).toThrow("TEST_DATABASE_URL must name an openbot_enterprise_* test database");
  expect(() =>
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL: `${officialSetup}#fragment`,
    }),
  ).toThrow(
    "ENTERPRISE_TEST_SETUP_DATABASE_URL must not include a URL fragment",
  );
  expect(() =>
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL: `${officialSetup}/extra`,
    }),
  ).toThrow("must name the database as a single path segment");
});

test("pins the exact session role on every capability login URL", () => {
  expect(
    enterpriseRuntimeDatabaseUrlFrom("data", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_DATA_DATABASE_URL: officialSetup,
    }),
  ).toBe(`${officialSetup}?options=-c%20role%3Dob_ent_data`);

  const explicit =
    "postgres://role:unused@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_directory";
  expect(
    enterpriseRuntimeDatabaseUrlFrom("directory", {
      TEST_DATABASE_URL: reservedCiSetup,
      ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: explicit,
    }),
  ).toBe(explicit);

  expect(() =>
    enterpriseRuntimeDatabaseUrlFrom("operator", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_OPERATOR_DATABASE_URL: `${officialSetup}?options=-c%20role%3Dob_ent_data`,
    }),
  ).toThrow("current_user set to ob_ent_operator");
  expect(() =>
    enterpriseRuntimeDatabaseUrlFrom("operator", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_OPERATOR_DATABASE_URL: reservedCiSetup,
    }),
  ).toThrow("same PostgreSQL instance and database as the setup URL");
  expect(
    enterpriseRuntimeDatabaseUrlFrom("operator", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_OPERATOR_DATABASE_URL: `${officialSetup}\n`,
    }),
  ).toBe(`${officialSetup}?options=-c%20role%3Dob_ent_operator`);
  expect(() =>
    enterpriseRuntimeDatabaseUrlFrom("operator", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_OPERATOR_DATABASE_URL: `${officialSetup}?options=-c%20role%3Dob_ent_operator&options=second`,
    }),
  ).toThrow("current_user set to ob_ent_operator");
  expect(() => enterpriseRuntimeDatabaseUrlFrom("operator", {})).toThrow(
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL is required",
  );
});

test("derives the database name from an enterprise test URL", () => {
  expect(
    enterpriseTestDatabaseNameFrom(
      `${officialSetup}?options=-c%20role%3Dob_ent_data`,
    ),
  ).toBe("openbot_enterprise_test");
});

test("decodes the database name before enforcing the single-segment rule", () => {
  expect(() =>
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL:
        "postgres://setup:unused@127.0.0.1:5434/openbot_enterprise_r2%2Fx",
    }),
  ).toThrow("must name the database as a single path segment");
  expect(() =>
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL:
        "postgres://setup:unused@127.0.0.1:5434/openbot_enterprise_%E0%A4%A",
    }),
  ).toThrow("invalid percent-encoding");
});

test("rejects a plus-spelled options parameter that libpq would read literally", () => {
  expect(() =>
    enterpriseRuntimeDatabaseUrlFrom("operator", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_OPERATOR_DATABASE_URL: `${officialSetup}?options=-c+role%3Dob_ent_operator`,
    }),
  ).toThrow('spells its options with a literal "+"');
});

test("normalizes a trailing empty query instead of emitting a bare separator", () => {
  expect(
    enterpriseRuntimeDatabaseUrlFrom("data", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_DATA_DATABASE_URL: `${officialSetup}?`,
    }),
  ).toBe(`${officialSetup}?options=-c%20role%3Dob_ent_data`);
});

test("matches portless role and setup URLs through the default port", () => {
  const portlessSetup =
    "postgres://openbot:unused@127.0.0.1/openbot_enterprise_test";
  expect(
    enterpriseRuntimeDatabaseUrlFrom("data", {
      TEST_DATABASE_URL: portlessSetup,
      ENTERPRISE_TEST_DATA_DATABASE_URL: portlessSetup,
    }),
  ).toBe(`${portlessSetup}?options=-c%20role%3Dob_ent_data`);
});

test("treats every loopback spelling as the same instance", () => {
  const ipv6Setup = "postgres://openbot:unused@[::1]:5435/openbot_enterprise_test";
  expect(
    enterpriseRuntimeDatabaseUrlFrom("data", {
      TEST_DATABASE_URL: officialSetup,
      ENTERPRISE_TEST_DATA_DATABASE_URL: ipv6Setup,
    }),
  ).toBe(`${ipv6Setup}?options=-c%20role%3Dob_ent_data`);
});

test("parses CI and developer test logins and rejects unsafe ones", () => {
  const parse = (url: string, seen = new Set<string>()) =>
    parseRuntimeTestLogin(
      "data",
      "ENTERPRISE_TEST_DATA_DATABASE_URL",
      { ENTERPRISE_TEST_DATA_DATABASE_URL: url },
      seen,
    );
  expect(
    parse(
      "postgres://enterprise_data_login:s3cret@127.0.0.1:5435/openbot_enterprise_test",
    ),
  ).toMatchObject({ name: "enterprise_data_login", capability: "ob_ent_data" });
  expect(
    parse("postgres://ent_data:pw@127.0.0.1:5435/openbot_enterprise_test"),
  ).toMatchObject({ name: "ent_data" });
  expect(() =>
    parse("postgres://openbot:pw@127.0.0.1:5435/openbot_enterprise_test"),
  ).toThrow("must name an ent*-prefixed test login");
  expect(() =>
    parse(
      "postgres://ent_data:p w@127.0.0.1:5435/openbot_enterprise_test",
    ),
  ).toThrow("printable ASCII password");
  const seen = new Set(["ent_shared"]);
  expect(() =>
    parse(
      "postgres://ent_shared:pw@127.0.0.1:5435/openbot_enterprise_test",
      seen,
    ),
  ).toThrow("reuses login");
  expect(() => parse("postgres://ent_data:@127.0.0.1:5435/openbot_enterprise_test")).toThrow(
    "must carry the test login's password",
  );
});

test("validates setup identity without assuming the container's internal port", () => {
  const identity = {
    database_name: "openbot_enterprise_test",
    current_user: "enterprise_test_setup",
    session_user: "enterprise_test_setup",
    setup_has_bypass: true,
    setup_is_superuser: true,
    public_schema_is_empty: true,
  };

  // The URL guard accepts any loopback host port. PostgreSQL may report its
  // container-internal listener as 5432, so this identity check ignores it.
  expect(() =>
    assertFreshSetupDatabaseIdentity(
      { ...identity, server_port: 5432 } as typeof identity,
      "openbot_enterprise_test",
    ),
  ).not.toThrow();
});

test("rejects an unsafe setup database identity", () => {
  const identity = {
    database_name: "openbot_enterprise_test",
    current_user: "enterprise_test_setup",
    session_user: "enterprise_test_setup",
    setup_has_bypass: true,
    setup_is_superuser: true,
    public_schema_is_empty: true,
  };
  for (const unsafe of [
    { ...identity, database_name: "openbot_enterprise_r2_codex_20261009" },
    { ...identity, session_user: "login_parent" },
    { ...identity, current_user: "ob_ent_data" },
    { ...identity, setup_has_bypass: false },
    { ...identity, public_schema_is_empty: false },
  ]) {
    expect(() =>
      assertFreshSetupDatabaseIdentity(unsafe, "openbot_enterprise_test"),
    ).toThrow("Refusing migration:");
  }
});
