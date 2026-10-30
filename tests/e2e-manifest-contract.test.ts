/*
 * The contract between the driven manifest (tests/config/e2e-bun-suites.json) and the tools that
 * read it, as named counterexamples (T01.01 / #513):
 *
 *   existing_group_names_and_members_do_not_move — writeManifest preserves the groups a previous
 *     write established; a new file joins through its own increment and never re-partitions the old
 *     groups (a renamed or re-sliced group breaks every E2E_BUN_ONLY filter and every task's
 *     registered batch).
 *   manifest_files_only_is_refused — appending to `files` without the matching groups is refused by
 *     the audit with a non-zero exit, because a files-only increment schedules work the driver can
 *     never find a group for.
 *   committed_manifest_files_equals_flatten_groups — in the committed manifest every file is a member
 *     of exactly one group and groups list nothing outside `files`; anything else and the audit's
 *     accounting and the driver's schedule disagree about what "driven" means.
 *
 * Everything runs against throwaway manifests in the OS temp dir, so a failing assertion can never
 * mutate the committed config.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test, afterEach } from "./support/e2e-compat";
import {
  BA_ISLAND_DIR,
  GROUP_SIZE,
  bunSuiteEnv,
  bunSuiteSkipReason,
  manifestGaps,
  writeManifest,
} from "../scripts/lib/e2e-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const committedManifestPath = join(
  import.meta.dirname,
  "../tests/config/e2e-bun-suites.json",
);

const scratch: string[] = [];
function tempManifest(): string {
  const directory = mkdtempSync(join(tmpdir(), "e2e-manifest-contract-"));
  scratch.push(directory);
  return join(directory, "e2e-bun-suites.json");
}

afterEach(() => {
  for (const directory of scratch.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("e2e manifest contract", () => {
  test("existing_group_names_and_members_do_not_move", {
    timeout: 60_000,
  }, () => {
    const target = tempManifest();
    const seed = [
      "app/tests/alpha.test.tsx",
      "app/tests/beta.test.tsx",
      "server/tests/gamma.test.ts",
    ];
    writeManifest(
      { files: seed, artifacts: [], causes: {} },
      "e2e-manifest-contract seed",
      target,
    );
    const before = JSON.parse(readFileSync(target, "utf8")).groups;
    expect(before.length).toBeGreaterThan(0);

    writeManifest(
      {
        files: [...seed, "app/tests/delta.test.tsx"],
        artifacts: [],
        causes: {},
      },
      "e2e-manifest-contract increment",
      target,
    );
    const after = JSON.parse(readFileSync(target, "utf8")).groups;

    /*
     * The seeded groups keep their names and members verbatim, in order; the increment can only add
     * groups after them. Renaming or re-slicing an existing group is how a registered batch drifts.
     */
    expect(after.slice(0, before.length)).toEqual(before);
    const memberCount = after
      .flatMap((group: { files: string[] }) => group.files)
      .filter((file: string) => file === "app/tests/delta.test.tsx").length;
    expect(
      memberCount,
      "the inserted file must be scheduled by exactly one group",
    ).toBe(1);
  });

  test("manifest_files_only_is_refused", { timeout: 120_000 }, () => {
    const target = tempManifest();
    writeFileSync(
      target,
      `${JSON.stringify(
        {
          generatedBy: "e2e-manifest-contract",
          files: ["server/tests/auth-session.test.ts"],
          artifacts: [],
          causes: {},
        },
        null,
        2,
      )}\n`,
    );
    const child = spawnSync(
      "node",
      ["scripts/e2e-coverage-audit.mjs", `--manifest=${target}`],
      { cwd: root, encoding: "utf8", timeout: 90_000 },
    );
    /*
     * The exit code alone cannot carry this: this tree's corpus walk has pre-existing tier gaps, so
     * a full-audit crash would also read as "refused". The refusal has to be named, and the
     * invariant-only mode must not run the corpus walk at all.
     */
    expect(
      child.status,
      `audit said: ${(child.stdout + child.stderr).slice(-600)}`,
    ).not.toBe(0);
    expect(child.stdout).toMatch(/files-only/i);
    expect(child.stdout).not.toMatch(/suite files in the/);
  });

  test("committed_manifest_files_equals_flatten_groups", {
    timeout: 60_000,
  }, () => {
    const manifest = JSON.parse(readFileSync(committedManifestPath, "utf8"));
    const files: string[] = manifest.files ?? [];
    const groups: { name: string; files: string[] }[] = manifest.groups ?? [];
    const owner = new Map<string, string>();
    const listed = new Set(files);
    const problems: string[] = [];
    for (const group of groups) {
      for (const file of group.files ?? []) {
        if (owner.has(file))
          problems.push(
            `${file} is a member of both "${owner.get(file)}" and "${group.name}"`,
          );
        else owner.set(file, group.name);
        if (!listed.has(file))
          problems.push(
            `group "${group.name}" lists ${file}, which is not in files`,
          );
      }
    }
    for (const file of files)
      if (!owner.has(file))
        problems.push(`${file} is in files but in no group`);
    expect(
      problems,
      `${problems.length} manifest accounting violation(s):\n  ${problems.slice(0, 10).join("\n  ")}`,
    ).toEqual([]);
  });

  test("better_auth_batches_are_named_by_task_and_stable", {
    timeout: 60_000,
  }, () => {
    const target = tempManifest();
    const seed = ["app/tests/alpha.test.tsx"];
    writeManifest({ files: seed, artifacts: [], causes: {} }, "seed", target);
    const seedGroups = JSON.parse(readFileSync(target, "utf8")).groups;

    const first = [
      "server/tests/better-auth/session.test.ts",
      "server/tests/better-auth/identity.test.ts",
      "server/tests/better-auth/invite.test.ts",
    ];
    writeManifest(
      { files: [...seed, ...first], artifacts: [], causes: {}, task: "T01.05" },
      "T01.05",
      target,
    );
    let groups = JSON.parse(readFileSync(target, "utf8")).groups;
    const batch1 = groups.find(
      (group: { name: string }) => group.name === `${BA_ISLAND_DIR}:T01.05.01`,
    );
    expect(
      batch1?.files,
      "the task's first registration becomes its .01 batch, under its TaskId",
    ).toEqual([...first].sort());
    expect(groups.slice(0, seedGroups.length)).toEqual(seedGroups);

    // A later increment of the same task is a new batch; the earlier batch keeps name and members.
    const second = ["server/tests/better-auth/sso.test.ts"];
    writeManifest(
      {
        files: [...seed, ...first, ...second],
        artifacts: [],
        causes: {},
        task: "T01.05",
      },
      "T01.05",
      target,
    );
    groups = JSON.parse(readFileSync(target, "utf8")).groups;
    expect(
      groups.find(
        (group: { name: string }) =>
          group.name === `${BA_ISLAND_DIR}:T01.05.01`,
      )?.files,
    ).toEqual([...first].sort());
    expect(
      groups.find(
        (group: { name: string }) =>
          group.name === `${BA_ISLAND_DIR}:T01.05.02`,
      )?.files,
    ).toEqual(second);

    // Another task gets its own numbering, unaffected by the first task's batches.
    const other = ["server/tests/better-auth/other.test.ts"];
    writeManifest(
      {
        files: [...seed, ...first, ...second, ...other],
        artifacts: [],
        causes: {},
        task: "T01.06",
      },
      "T01.06",
      target,
    );
    groups = JSON.parse(readFileSync(target, "utf8")).groups;
    expect(
      groups.find(
        (group: { name: string }) =>
          group.name === `${BA_ISLAND_DIR}:T01.06.01`,
      )?.files,
    ).toEqual(other);

    // A better-auth file with no owning TaskId cannot be named, so the registration is refused.
    expect(() =>
      writeManifest(
        {
          files: [...seed, `${BA_ISLAND_DIR}/orphan.test.ts`],
          artifacts: [],
          causes: {},
        },
        "no-task",
        tempManifest(),
      ),
    ).toThrow(/owning TaskId/);
  });

  test("better_auth_batch_never_exceeds_group_size", {
    timeout: 60_000,
  }, () => {
    const many = Array.from(
      { length: GROUP_SIZE + 1 },
      (_, index) =>
        `${BA_ISLAND_DIR}/file-${String(index).padStart(2, "0")}.test.ts`,
    );
    expect(() =>
      writeManifest(
        { files: many, artifacts: [], causes: {}, task: "T01.09" },
        "T01.09",
        tempManifest(),
      ),
    ).toThrow(/split the Issue/);

    // The bound is per Issue, not per registration: 20 + 5 is over it even across two batches.
    const target = tempManifest();
    const twenty = many.slice(0, 20);
    writeManifest(
      { files: twenty, artifacts: [], causes: {}, task: "T01.09" },
      "T01.09",
      target,
    );
    const fiveMore = Array.from(
      { length: 5 },
      (_, index) => `${BA_ISLAND_DIR}/more-${index}.test.ts`,
    );
    expect(() =>
      writeManifest(
        {
          files: [...twenty, ...fiveMore],
          artifacts: [],
          causes: {},
          task: "T01.09",
        },
        "T01.09",
        target,
      ),
    ).toThrow(/split the Issue/);
  });

  test("manifest_gaps_refuse_files_only_duplicates_and_out_of_group_files", {
    timeout: 60_000,
  }, () => {
    const file = "server/tests/alpha.test.ts";
    expect(
      manifestGaps({ files: [file], groups: [] }).join("\n"),
      "files-only registration has no group to schedule it",
    ).toMatch(/files-only/);
    expect(
      manifestGaps({
        files: [file],
        groups: [
          { name: "server/tests", files: [file] },
          { name: "server/tests part 2", files: [file] },
        ],
      }).join("\n"),
      "one file in two groups runs twice and is counted once",
    ).toMatch(/member of both/);
    expect(
      manifestGaps({
        files: [file],
        groups: [
          { name: "server/tests", files: [file, "server/tests/ghost.test.ts"] },
        ],
      }).join("\n"),
      "a group may not schedule a file the manifest does not own",
    ).toMatch(/not in files/);
    const oversize = Array.from(
      { length: GROUP_SIZE + 1 },
      (_, index) => `server/tests/file-${index}.test.ts`,
    );
    expect(
      manifestGaps({
        files: oversize,
        groups: [{ name: "server/tests", files: oversize }],
      }).join("\n"),
    ).toMatch(new RegExp(`max ${GROUP_SIZE}`));
    expect(
      manifestGaps({
        files: [`${BA_ISLAND_DIR}/x.test.ts`],
        groups: [
          { name: BA_ISLAND_DIR, files: [`${BA_ISLAND_DIR}/x.test.ts`] },
        ],
      }).join("\n"),
      "a better-auth file in a shared slice would run without its role URLs",
    ).toMatch(/instead of a .*:Txx\.nn batch/);
    expect(
      manifestGaps({
        files: [`${BA_ISLAND_DIR}/x.test.ts`],
        groups: [
          {
            name: `${BA_ISLAND_DIR}:01.05.01`,
            files: [`${BA_ISLAND_DIR}/x.test.ts`],
          },
        ],
      }).join("\n"),
      "the batch name carries the TaskId, not a bare counter",
    ).toMatch(/not a TaskId batch/);
  });

  test("better_auth_groups_do_not_inherit_shared_or_mt_urls", {
    timeout: 60_000,
  }, () => {
    const islands = ["server/tests/multitenancy", "app/tests/multitenancy"];
    const env: Record<string, string> = {
      BA_TEST_DATABASE_URL: "postgres://ba/journal",
      BA_TEST_DIRECTORY_DATABASE_URL: "postgres://ba/directory",
      BA_TEST_DATA_DATABASE_URL: "postgres://ba/data",
      BA_TEST_OPERATOR_DATABASE_URL: "postgres://ba/operator",
      BA_TEST_AUTH_WRITER_DATABASE_URL: "postgres://ba/writer",
      TEST_DATABASE_URL: "postgres://shared/journal",
      DATABASE_URL: "postgres://shared/journal",
      MT_TEST_DATABASE_URL: "postgres://mt/journal",
      MT_TEST_DATA_DATABASE_URL: "postgres://mt/data",
      // Job-level leftovers with the fixture's own names: these must never reach a BA subprocess.
      ENTERPRISE_TEST_SETUP_DATABASE_URL: "postgres://enterprise/setup",
      ENTERPRISE_TEST_DIRECTORY_DATABASE_URL: "postgres://enterprise/directory",
      ENTERPRISE_TEST_DATA_DATABASE_URL: "postgres://enterprise/data",
      ENTERPRISE_TEST_OPERATOR_DATABASE_URL: "postgres://enterprise/operator",
    };
    const ba = bunSuiteEnv(`${BA_ISLAND_DIR}:T01.05.01`, {
      env,
      directoryIslands: islands,
    });
    // The fixed injection map: every role URL a BA subprocess sees comes from the BA_TEST_* five.
    expect(ba.TEST_DATABASE_URL).toBe("postgres://ba/journal");
    expect(ba.DATABASE_URL).toBe("postgres://ba/journal");
    expect(ba.ENTERPRISE_TEST_SETUP_DATABASE_URL).toBe("postgres://ba/journal");
    expect(ba.ENTERPRISE_TEST_DIRECTORY_DATABASE_URL).toBe(
      "postgres://ba/directory",
    );
    expect(ba.ENTERPRISE_TEST_DATA_DATABASE_URL).toBe("postgres://ba/data");
    expect(ba.ENTERPRISE_TEST_OPERATOR_DATABASE_URL).toBe(
      "postgres://ba/operator",
    );
    expect(ba.BA_TEST_AUTH_WRITER_DATABASE_URL).toBe("postgres://ba/writer");
    // And nothing survives that was not injected from a BA_TEST_* source: none of the parent
    // environment's own URL values may appear in the scoped environment.
    for (const leftover of [
      "postgres://enterprise/setup",
      "postgres://enterprise/directory",
      "postgres://enterprise/data",
      "postgres://enterprise/operator",
      "postgres://shared/journal",
      "postgres://mt/journal",
      "postgres://mt/data",
    ]) {
      expect(
        Object.values(ba),
        `the job-level URL ${leftover} must not reach a better-auth subprocess`,
      ).not.toContain(leftover);
    }

    // Every one of the five is required, and each missing one is named.
    expect(() =>
      bunSuiteEnv(`${BA_ISLAND_DIR}:T01.05.01`, {
        env: { TEST_DATABASE_URL: "postgres://shared/journal" },
        directoryIslands: islands,
      }),
    ).toThrow(
      /5 required BA_TEST_\* URL\(s\) not set: BA_TEST_DATABASE_URL, BA_TEST_DIRECTORY_DATABASE_URL, BA_TEST_DATA_DATABASE_URL, BA_TEST_OPERATOR_DATABASE_URL, BA_TEST_AUTH_WRITER_DATABASE_URL/,
    );
    expect(
      () =>
        bunSuiteEnv(`${BA_ISLAND_DIR}:T01.05.01`, {
          env: {
            BA_TEST_DATABASE_URL: "postgres://ba/journal",
            ENTERPRISE_TEST_DATA_DATABASE_URL: "postgres://enterprise/data",
          },
          directoryIslands: islands,
        }),
      "a job-level role URL cannot stand in for the missing BA_TEST_* one",
    ).toThrow(
      /BA_TEST_DIRECTORY_DATABASE_URL, BA_TEST_DATA_DATABASE_URL, BA_TEST_OPERATOR_DATABASE_URL, BA_TEST_AUTH_WRITER_DATABASE_URL/,
    );

    // The multitenancy routing this replaced keeps behaving exactly as before.
    const mt = bunSuiteEnv("server/tests/multitenancy part 1", {
      env,
      directoryIslands: islands,
    });
    expect(mt.TEST_DATABASE_URL).toBe("postgres://mt/journal");
    expect(mt.DATABASE_URL).toBe("postgres://mt/journal");
    expect(mt.ENTERPRISE_TEST_DATA_DATABASE_URL).toBe("postgres://mt/data");
    // Every other group still gets the environment it always got.
    expect(
      bunSuiteEnv("app/tests part 1", { env, directoryIslands: islands })
        .TEST_DATABASE_URL,
    ).toBe("postgres://shared/journal");
  });

  test("billing_island_carries_its_own_database_and_no_one_else_does", () => {
    const env: Record<string, string> = {
      TEST_DATABASE_URL: "postgres://shared/journal",
      DATABASE_URL: "postgres://shared/journal",
      BILLING_TEST_DATABASE_URL: "postgres://billing/island",
      MT_TEST_DATABASE_URL: "postgres://mt/journal",
    };
    // The island group runs on its own database, inherited nowhere else.
    const island = bunSuiteEnv("server/tests/billing island", { env });
    expect(island.TEST_DATABASE_URL).toBe("postgres://billing/island");
    expect(island.DATABASE_URL).toBe("postgres://billing/island");
    // A shared-slice group never sees the island's URL…
    expect(
      bunSuiteEnv("server/tests part 14", { env }).TEST_DATABASE_URL,
    ).toBe("postgres://shared/journal");
    // …and without the override the island keeps the job's environment.
    expect(
      bunSuiteEnv("server/tests/billing island", {
        env: { TEST_DATABASE_URL: "postgres://shared/journal" },
      }).TEST_DATABASE_URL,
    ).toBe("postgres://shared/journal");
  });

  test("explicit_groups_claim_their_members_out_of_the_directory_parts", () => {
    // An explicit-group member never lands in its directory part: fresh, it is
    // claimed by the island before any slicing; a non-member beside it still
    // takes the ordinary part.
    const member = "server/tests/payment-store.integration.test.ts";
    const neighbour = "server/tests/plan-credits-personal.integration.test.ts";
    const stranger = "server/tests/gateway-admin-routes.test.ts";
    const target = tempManifest();
    writeManifest(
      { files: [member, neighbour, stranger], artifacts: [], causes: {} },
      "explicit-group register",
      target,
    );
    const groups = JSON.parse(readFileSync(target, "utf8")).groups;
    const byName = new Map(
      groups.map((group: { name: string; files: string[] }) => [
        group.name,
        group.files,
      ]),
    );
    expect(byName.get("server/tests/billing island")).toEqual([
      member,
      neighbour,
    ]);
    // The stranger shares no explicit group, so its directory slice takes it.
    expect(
      [...byName.values()].some((files: string[]) => files.includes(stranger)),
    ).toBe(true);
    expect(
      [...byName.values()].some((files: string[]) =>
        files.includes(member),
      ),
      "an explicit member is scheduled exactly once",
    ).toBe(true);
  });

  test("bunSuiteSkipReason names an absent island, never a partial one", () => {
    // An environment with none of the five role URLs has no island: the reason to skip.
    expect(
      bunSuiteSkipReason(`${BA_ISLAND_DIR}:T02.01.01`, { env: {} }),
    ).toMatch(/no better-auth island/);
    // Job-level URLs alone do not count as an island either.
    expect(
      bunSuiteSkipReason(`${BA_ISLAND_DIR}:T02.01.01`, {
        env: { TEST_DATABASE_URL: "postgres://shared/journal" },
      }),
    ).toMatch(/no better-auth island/);
    // A partial set is a misconfiguration, not an absence: bunSuiteEnv's throw stands there.
    expect(
      bunSuiteSkipReason(`${BA_ISLAND_DIR}:T02.01.01`, {
        env: { BA_TEST_DATABASE_URL: "postgres://ba/journal" },
      }),
    ).toBeNull();
    // Only better-auth groups are ever skipped this way.
    expect(
      bunSuiteSkipReason("server/tests/multitenancy part 1", { env: {} }),
    ).toBeNull();
  });
});
