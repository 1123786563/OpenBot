import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bunEnv } from "./support/bun-suite-env";
import { expect, test } from "./support/e2e-compat";

/*
 * Environment routing for bun-driven groups, exercised the way the driver runs
 * it: through a real subprocess whose view of the routed environment is
 * captured, never by trusting the routing function's return value alone
 * (T01.02). The underlying rules live in scripts/lib/e2e-manifest.mjs and are
 * exercised in-process by tests/e2e-manifest-contract.test.ts; what this file
 * adds is the proof that the seam the driver consumes routes exactly those
 * rules — the better-auth island gets its five isolated role URLs and nothing
 * else, a missing URL blocks instead of falling back, and the multitenancy
 * branch keeps its override.
 *
 * Every URL here is fake (non-connectable ports, throwaway logins) and the one
 * fake password is asserted absent from every probe output.
 */

const FAKE_PASSWORD = "probe-fake-password-not-a-secret";
const FAKE = {
  shared: `postgresql://ent_shared_probe:${FAKE_PASSWORD}@127.0.0.1:5433/openbot_test`,
  mt: `postgresql://ent_mt_probe:${FAKE_PASSWORD}@127.0.0.1:5434/openbot_enterprise_mt_test`,
  ba: {
    setup: `postgresql://ent_ba_setup:${FAKE_PASSWORD}@127.0.0.1:55441/openbot_enterprise_fixture_test`,
    directory: `postgresql://ent_ba_directory:${FAKE_PASSWORD}@127.0.0.1:55442/openbot_enterprise_fixture_test`,
    data: `postgresql://ent_ba_data:${FAKE_PASSWORD}@127.0.0.1:55443/openbot_enterprise_fixture_test`,
    operator: `postgresql://ent_ba_operator:${FAKE_PASSWORD}@127.0.0.1:55444/openbot_enterprise_fixture_test`,
    authWriter: `postgresql://ent_ba_auth_writer:${FAKE_PASSWORD}@127.0.0.1:55445/openbot_enterprise_fixture_test?options=-c%20role%3Dob_ent_auth_writer`,
  },
};

/** Shared/MT/job-level decoys plus the five required island URLs, all fake. */
function fakeEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TEST_DATABASE_URL: FAKE.shared,
    DATABASE_URL: FAKE.shared,
    MT_TEST_DATABASE_URL: FAKE.mt,
    MT_TEST_DIRECTORY_DATABASE_URL: FAKE.mt,
    ENTERPRISE_TEST_SETUP_DATABASE_URL: FAKE.shared,
    ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: FAKE.shared,
    ENTERPRISE_TEST_DATA_DATABASE_URL: FAKE.shared,
    ENTERPRISE_TEST_OPERATOR_DATABASE_URL: FAKE.shared,
    BA_TEST_DATABASE_URL: FAKE.ba.setup,
    BA_TEST_DIRECTORY_DATABASE_URL: FAKE.ba.directory,
    BA_TEST_DATA_DATABASE_URL: FAKE.ba.data,
    BA_TEST_OPERATOR_DATABASE_URL: FAKE.ba.operator,
    BA_TEST_AUTH_WRITER_DATABASE_URL: FAKE.ba.authWriter,
  };
}

const BA_GROUP = "server/tests/better-auth:T01.02.01";

/*
 * The probe: a bun subprocess that routes `process.env` through the same
 * `bunEnv` the driver uses and reports (a) every DATABASE_URL-bearing key it
 * ends up with and (b) the distinct login roles those URLs name. Routing
 * failures exit 3 with the message sanitized so no credential can leak through
 * an error path.
 */
function runProbe(
  groupName: string,
  env: Record<string, string>,
  directoryIslands: string[] = [],
): { status: number; stdout: string; stderr: string } {
  const directory = mkdtempSync(join(tmpdir(), "openbot-ba-env-probe-"));
  const wrapper = fileURLToPath(
    new URL("./support/bun-suite-env.ts", import.meta.url),
  );
  try {
    const probe = join(directory, "probe.ts");
    writeFileSync(
      probe,
      [
        `import { pathToFileURL } from "node:url";`,
        `const [, , wrapperPath, groupName, islandsJson] = process.argv;`,
        `try {`,
        `  const { bunEnv } = await import(pathToFileURL(wrapperPath).href);`,
        `  const routed = bunEnv(groupName, { env: process.env, directoryIslands: JSON.parse(islandsJson) });`,
        `  const entries = Object.entries(routed).filter(([key, value]) => key.includes("DATABASE_URL") && typeof value === "string" && value);`,
        `  const roleNames = [...new Set(entries.map(([, value]) => new URL(value).username))].sort();`,
        `  const keys = entries.map(([key]) => key).sort();`,
        `  console.log(JSON.stringify({ roleNames, keys }));`,
        `} catch (error) {`,
        `  console.error(String((error as { message?: string }).message ?? error).replace(/\\/\\/[^@/]*@/, "//***@"));`,
        `  process.exit(3);`,
        `}`,
        "",
      ].join("\n"),
    );
    const spawned = spawnSync(
      "bun",
      [
        "--no-env-file",
        probe,
        wrapper,
        groupName,
        JSON.stringify(directoryIslands),
      ],
      { env, encoding: "utf8" },
    );
    return {
      status: spawned.status ?? 1,
      stdout: spawned.stdout ?? "",
      stderr: spawned.stderr ?? "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("ba_island_receives_all_isolated_role_urls", () => {
  // bunEnv must route the same way the driver will: check the seam directly
  // first, then capture an actual subprocess's view of it.
  const routed = bunEnv(BA_GROUP, {
    env: fakeEnvironment(),
    directoryIslands: [],
  });
  const probe = runProbe(BA_GROUP, fakeEnvironment());
  expect(probe.stdout + probe.stderr).not.toContain(FAKE_PASSWORD);
  const captured = JSON.parse(probe.stdout.trim()) as {
    roleNames: string[];
    keys: string[];
  };
  // The five role URLs are all present and each names its own login role; the
  // shared/MT/job decoys are gone. Five roles, not five keys: setup and the
  // generic TEST_DATABASE_URL/DATABASE_URL legitimately share ent_ba_setup.
  expect(captured.roleNames).toEqual([
    "ent_ba_auth_writer",
    "ent_ba_data",
    "ent_ba_directory",
    "ent_ba_operator",
    "ent_ba_setup",
  ]);
  expect(captured.keys).toEqual([
    "BA_TEST_AUTH_WRITER_DATABASE_URL",
    "BA_TEST_DATABASE_URL",
    "BA_TEST_DATA_DATABASE_URL",
    "BA_TEST_DIRECTORY_DATABASE_URL",
    "BA_TEST_OPERATOR_DATABASE_URL",
    "DATABASE_URL",
    "ENTERPRISE_TEST_DATA_DATABASE_URL",
    "ENTERPRISE_TEST_DIRECTORY_DATABASE_URL",
    "ENTERPRISE_TEST_OPERATOR_DATABASE_URL",
    "ENTERPRISE_TEST_SETUP_DATABASE_URL",
    "TEST_DATABASE_URL",
  ]);
  // The in-process seam agrees with the subprocess: same five roles.
  const inProcessRoleNames = [
    ...new Set(
      Object.entries(routed)
        .filter(
          ([key, value]) =>
            key.includes("DATABASE_URL") && typeof value === "string" && value,
        )
        .map(([, value]) => new URL(value).username),
    ),
  ].sort();
  expect(inProcessRoleNames).toEqual(captured.roleNames);
});

test("missing_ba_url_never_uses_mt_or_shared_database", () => {
  for (const missing of [
    "BA_TEST_DATABASE_URL",
    "BA_TEST_DIRECTORY_DATABASE_URL",
    "BA_TEST_DATA_DATABASE_URL",
    "BA_TEST_OPERATOR_DATABASE_URL",
    "BA_TEST_AUTH_WRITER_DATABASE_URL",
  ]) {
    const env = fakeEnvironment();
    delete env[missing];
    // The MT override and the shared URLs stay in the environment: the island
    // must block, not silently fall back to any of them.
    const probe = runProbe(BA_GROUP, env);
    expect(probe.status, `${missing} missing must block the island`).not.toBe(
      0,
    );
    expect(
      probe.stderr,
      `${missing} missing must be named by the refusal`,
    ).toContain(missing);
    expect(probe.stdout + probe.stderr).not.toContain(FAKE_PASSWORD);
  }
});

test("ba_island_branch_wins_over_mt_override", () => {
  // BA branch precedence is decided by the group name: even with the whole MT
  // override family available, a missing BA URL blocks the island.
  const env = fakeEnvironment();
  delete env.BA_TEST_DATA_DATABASE_URL;
  const probe = runProbe(BA_GROUP, env, ["server/tests/multitenancy"]);
  expect(probe.status).not.toBe(0);
  expect(probe.stderr).toContain("BA_TEST_DATA_DATABASE_URL");
  expect(probe.stdout + probe.stderr).not.toContain(FAKE_PASSWORD);
});

test("mt_directory_island_keeps_its_override_branch", () => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TEST_DATABASE_URL: FAKE.shared,
    DATABASE_URL: FAKE.shared,
    MT_TEST_DATABASE_URL: FAKE.mt,
    MT_TEST_DIRECTORY_DATABASE_URL: FAKE.mt,
    ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: FAKE.shared,
  };
  const probe = runProbe("server/tests/multitenancy", env, [
    "server/tests/multitenancy",
  ]);
  expect(probe.status).toBe(0);
  const captured = JSON.parse(probe.stdout.trim()) as { roleNames: string[] };
  // The override wins for the island's database and its directory role; no BA
  // URL was offered, and none is required or injected on this branch.
  expect(captured.roleNames).toEqual(["ent_mt_probe"]);
});
