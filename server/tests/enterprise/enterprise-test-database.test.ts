import { expect, test } from "bun:test";
import { assertFreshSetupDatabaseIdentity } from "../../scripts/enterprise-test-db-guard";
import {
  enterpriseRuntimeDatabaseUrlFrom,
  enterpriseTestDatabaseUrlFrom,
} from "../support/enterprise-database";

const setup =
  "postgres://setup:unused@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009";

test("accepts only the controller-reserved isolated database for setup", () => {
  expect(
    enterpriseTestDatabaseUrlFrom({
      ENTERPRISE_TEST_SETUP_DATABASE_URL: setup,
    }),
  ).toBe(setup);
  for (const name of ["openbot", "openbot_enterprise_test", "another_db"]) {
    expect(() =>
      enterpriseTestDatabaseUrlFrom({
        ENTERPRISE_TEST_SETUP_DATABASE_URL: `postgres://setup:unused@127.0.0.1:5434/${name}`,
      }),
    ).toThrow("controller-reserved PostgreSQL test database");
  }
  expect(() =>
    enterpriseTestDatabaseUrlFrom({ TEST_DATABASE_URL: setup }),
  ).toThrow("ENTERPRISE_TEST_SETUP_DATABASE_URL is required");
});

test("requires per-capability login URLs to set the exact session role", () => {
  const roleUrl =
    "postgres://role:unused@127.0.0.1:5434/openbot_enterprise_r2_codex_20261009?options=-c%20role%3Dob_ent_data";
  expect(
    enterpriseRuntimeDatabaseUrlFrom("data", {
      ENTERPRISE_TEST_DATA_DATABASE_URL: roleUrl,
    }),
  ).toBe(roleUrl);
  expect(() =>
    enterpriseRuntimeDatabaseUrlFrom("data", {
      ENTERPRISE_TEST_DATA_DATABASE_URL: setup,
    }),
  ).toThrow("current_user set to ob_ent_data");
});

test("fails closed when a required test URL is missing", () => {
  expect(() => enterpriseTestDatabaseUrlFrom({})).toThrow(
    "ENTERPRISE_TEST_SETUP_DATABASE_URL is required",
  );
  expect(() => enterpriseRuntimeDatabaseUrlFrom("directory", {})).toThrow(
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL is required",
  );
});

test("validates setup identity without assuming the container's internal port", () => {
  const identity = {
    database_name: "openbot_enterprise_r2_codex_20261009",
    current_user: "enterprise_test_setup",
    session_user: "enterprise_test_setup",
    setup_has_bypass: true,
    public_schema_is_empty: true,
  };

  // The URL guard pins the host-side port (5434). PostgreSQL may report its
  // container-internal listener as 5432, so this identity check ignores it.
  expect(() =>
    assertFreshSetupDatabaseIdentity(
      { ...identity, server_port: 5432 } as typeof identity,
      "openbot_enterprise_r2_codex_20261009",
    ),
  ).not.toThrow();
});

test("rejects an unsafe setup database identity", () => {
  const identity = {
    database_name: "openbot_enterprise_r2_codex_20261009",
    current_user: "enterprise_test_setup",
    session_user: "enterprise_test_setup",
    setup_has_bypass: true,
    public_schema_is_empty: true,
  };
  for (const unsafe of [
    { ...identity, database_name: "openbot_enterprise_test" },
    { ...identity, session_user: "login_parent" },
    { ...identity, current_user: "ob_ent_data" },
    { ...identity, setup_has_bypass: false },
    { ...identity, public_schema_is_empty: false },
  ]) {
    expect(() =>
      assertFreshSetupDatabaseIdentity(
        unsafe,
        "openbot_enterprise_r2_codex_20261009",
      ),
    ).toThrow("Refusing migration:");
  }
});
