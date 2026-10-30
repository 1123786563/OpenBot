import { expect, test } from "../../../tests/support/e2e-compat";
import { readdirSync, readFileSync } from "node:fs";

const serverRoot = new URL("../..", import.meta.url);
const schemaDir = new URL("src/db/schema/", serverRoot);

type GuardJournal = {
  entries: Array<{
    idx: number;
    tag: string;
    when?: unknown;
    [key: string]: unknown;
  }>;
};

// index.ts is the barrel and json.ts is a customType helper; neither declares a
// table, and the drizzle.config.ts convention lists only table-bearing schema
// files. Every file that declares a pgTable must appear in the config's schema
// list or the next `drizzle-kit generate` treats its tables as deleted.
function schemaFilesDeclaringTables(): string[] {
  return readdirSync(schemaDir)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) =>
      readFileSync(new URL(name, schemaDir), "utf8").includes("pgTable("),
    )
    .sort();
}

test("drizzle schema list covers every schema file that declares a table", () => {
  const config = readFileSync(new URL("drizzle.config.ts", serverRoot), "utf8");
  const declaring = schemaFilesDeclaringTables();
  expect(declaring.length).toBeGreaterThan(0);
  for (const file of declaring) {
    expect(config).toContain(`"./src/db/schema/${file}"`);
  }
});

test("boundary guard passes an ordered journal and the real migration journal", async () => {
  const guard = await import("../../scripts/migration-runner");
  expect(guard.validateMigrationJournalBoundary).toBeFunction();
  const entry = (idx: number, when: number) => ({
    idx,
    tag: `${String(idx).padStart(4, "0")}_test`,
    when,
  });
  const ordered: GuardJournal = {
    entries: [entry(64, 2), entry(65, 3), entry(66, 4), entry(67, 5)],
  };
  expect(() => guard.validateMigrationJournalBoundary(ordered)).not.toThrow();

  const realJournal = JSON.parse(
    readFileSync(new URL("drizzle/meta/_journal.json", serverRoot), "utf8"),
  ) as GuardJournal;
  expect(() =>
    guard.validateMigrationJournalBoundary(realJournal),
  ).not.toThrow();
});

test("boundary guard throws when a prefix entry's when reaches the validation entry's when", async () => {
  const guard = await import("../../scripts/migration-runner");
  expect(guard.validateMigrationJournalBoundary).toBeFunction();
  const entry = (idx: number, when: number) => ({
    idx,
    tag: `${String(idx).padStart(4, "0")}_test`,
    when,
  });
  // Regression shape: a hand-edited prefix 'when' that reaches the index-66
  // timestamp would make drizzle's second pass silently skip 0066+.
  const regressed: GuardJournal = {
    entries: [entry(64, 2), entry(65, 9), entry(66, 4), entry(67, 5)],
  };
  expect(() => guard.validateMigrationJournalBoundary(regressed)).toThrow(
    /skips entries whose 'when' is not newer/,
  );
  const equalAtBoundary: GuardJournal = {
    entries: [entry(65, 4), entry(66, 4)],
  };
  expect(() =>
    guard.validateMigrationJournalBoundary(equalAtBoundary),
  ).toThrow();
});

test("boundary guard still enforces index 65/66 adjacency", async () => {
  const guard = await import("../../scripts/migration-runner");
  expect(guard.validateMigrationJournalBoundary).toBeFunction();
  // Both 65 and 66 exist but an unrelated entry sits between them in the
  // journal array, so the prefix slice would silently omit it.
  const gapped: GuardJournal = {
    entries: [
      { idx: 65, tag: "0065_test", when: 3 },
      { idx: 10, tag: "0010_test", when: 2 },
      { idx: 66, tag: "0066_test", when: 9 },
    ],
  };
  expect(() => guard.validateMigrationJournalBoundary(gapped)).toThrow(
    /must immediately follow/,
  );
});

test("journal without the validation boundary is a no-op", async () => {
  const guard = await import("../../scripts/migration-runner");
  expect(guard.validateMigrationJournalBoundary).toBeFunction();
  expect(
    guard.validateMigrationJournalBoundary({
      entries: [{ idx: 10, tag: "0010_test", when: 1 }],
    }),
  ).toBeUndefined();
  // Index 65 present without 66 means the boundary is absent entirely; the
  // original runner treated that as "no prefix pass needed" and must keep
  // doing so.
  expect(
    guard.validateMigrationJournalBoundary({
      entries: [
        { idx: 64, tag: "0064_test", when: 2 },
        { idx: 65, tag: "0065_test", when: 3 },
        { idx: 67, tag: "0067_test", when: 5 },
      ],
    }),
  ).toBeUndefined();
});

test("pinning helper rejects a reserve() object that already exposes options or begin", async () => {
  const guard = await import("../../scripts/migration-runner");
  expect(guard.assertReserveOmitsTransactionApi).toBeFunction();
  expect(() => guard.assertReserveOmitsTransactionApi({ options: {} })).toThrow(
    /no longer omits options\/begin/,
  );
  expect(() =>
    guard.assertReserveOmitsTransactionApi({ begin: () => {} }),
  ).toThrow(/no longer omits options\/begin/);
  expect(() =>
    guard.assertReserveOmitsTransactionApi({
      unsafe: () => {},
      release: () => {},
    }),
  ).not.toThrow();
});

// --- OCR R6: postgres identifier limits, FK name consistency, REVOKE parity ---

const drizzleDir = new URL("../../drizzle/", import.meta.url);

function migrationSqlNames(sql: string): string[] {
  const names: string[] = [];
  for (const match of sql.matchAll(
    /(?:ADD CONSTRAINT|CONSTRAINT|CREATE UNIQUE INDEX|CREATE INDEX|CREATE POLICY)\s+"([^"]+)"/g,
  )) {
    names.push(match[1]);
  }
  return names;
}

test("migration_sql_identifier_names_fit_the_postgres_limit", () => {
  // Only migrations no database has applied yet (journal idx >= 237):
  // committed migrations may already be applied, where a rename would
  // break name-keyed operations against live catalogs.
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8"),
  );
  const unapplied = new Set(
    journal.entries
      .filter((entry: { idx: number }) => entry.idx >= 237)
      .map((entry: { tag: string }) => `${entry.tag}.sql`),
  );
  for (const file of readdirSync(drizzleDir)) {
    if (!file.endsWith(".sql") || !unapplied.has(file)) continue;
    const sql = readFileSync(new URL(file, drizzleDir), "utf8");
    for (const name of migrationSqlNames(sql)) {
      // Postgres silently truncates identifiers past 63 bytes; a name this
      // long can never be referenced by its written form.
      expect(
        name.length,
        `${file}: ${name} is ${name.length} bytes`,
      ).toBeLessThanOrEqual(63);
    }
  }
});

test("runner_event_foreign_keys_use_explicit_short_names_consistently", () => {
  const sql68 = readFileSync(
    new URL("0069_runner_event_log.sql", drizzleDir),
    "utf8",
  );
  const sql69 = readFileSync(
    new URL("0070_runner_event_attribution.sql", drizzleDir),
    "utf8",
  );
  const snapshot68 = JSON.parse(
    readFileSync(new URL("meta/0069_snapshot.json", drizzleDir), "utf8"),
  );
  const snapshot69 = JSON.parse(
    readFileSync(new URL("meta/0070_snapshot.json", drizzleDir), "utf8"),
  );

  const added_0070_old = [...sql68.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map(
    (m) => m[1],
  );
  const dropped69 = [...sql69.matchAll(/DROP CONSTRAINT "([^"]+)"/g)].map(
    (m) => m[1],
  );
  const added_0070 = [...sql69.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map(
    (m) => m[1],
  );
  // 0069 must drop exactly the run-scoped FK 0068 created — by name, not by
  // shared truncation.
  expect(dropped69).toEqual(["enterprise_runner_events_runs_fk"]);
  expect(added_0070_old).toContain("enterprise_runner_events_runs_fk");
  expect(added_0070_old).toContain("enterprise_runner_events_attempts_fk");
  expect(added_0070).toContain("enterprise_runner_events_conversations_fk");
  expect(added_0070).toContain("enterprise_runner_events_runs_owner_fk");

  const snapshotFkNames = (snapshot: {
    tables: Record<string, { foreignKeys?: Record<string, unknown> }>;
  }) =>
    Object.keys(
      snapshot.tables["public.enterprise_runner_events"]?.foreignKeys ?? {},
    );
  const names_0070_new = snapshotFkNames(snapshot68);
  const names_0070 = snapshotFkNames(snapshot69);
  for (const name of [...added_0070_old, ...added_0070]) {
    // Every FK the migrations create is recorded under the same explicit
    // name in the snapshot that owns it, so future drizzle-kit diffs see
    // no phantom constraint churn.
    if (name === "enterprise_runner_events_runs_fk")
      expect(names_0070_new).toContain(name);
    else if (name === "enterprise_runner_events_attempts_fk") {
      expect(names_0070_new).toContain(name);
      expect(names_0070).toContain(name);
    } else expect(names_0070).toContain(name);
  }
  // The dropped FK is absent from 0069's snapshot.
  expect(names_0070).not.toContain("enterprise_runner_events_runs_fk");
});

test("enterprise_table_revokes_cover_all_four_roles_plus_public", () => {
  for (const file of [
    "0069_runner_event_log.sql",
    "0071_enterprise_model_route_catalog.sql",
    "0072_enterprise_expert_versions.sql",
  ]) {
    const sql = readFileSync(new URL(file, drizzleDir), "utf8");
    for (const tableMatch of sql.matchAll(/REVOKE[^\n]*ON TABLE "([^"]+)"/g)) {
      const table = tableMatch[1];
      const revokes = [
        ...sql.matchAll(
          new RegExp(`REVOKE[^\\n]*ON TABLE "${table}"[^;]*;`, "g"),
        ),
      ].map((m) => m[0]);
      // The house pattern (0055/0056/0057/0059/0068): one revoke covering
      // PUBLIC and all four enterprise roles, clearing any legacy draft
      // grants. Per-role partial revokes that skip roles are the gap.
      const combined = revokes.find(
        (statement) =>
          statement.includes("PUBLIC") &&
          statement.includes("ob_ent_directory") &&
          statement.includes("ob_ent_data") &&
          statement.includes("ob_ent_operator") &&
          statement.includes("ob_ent_identity_operator"),
      );
      expect(combined, `${file} table ${table}`).toBeDefined();
      expect(revokes).toHaveLength(1);
    }
  }
});

// --- OCR R7: post-boundary watermark guard, malformed when, grant style, checks ---

const orderedJournal = () => ({
  entries: [
    { idx: 65, tag: "0065_a", when: 1791710000000 },
    { idx: 66, tag: "0066_b", when: 1791729521432 },
    { idx: 67, tag: "0067_c", when: 1791800000000 },
    { idx: 68, tag: "0068_d", when: 1791900000000 },
  ],
});

test("boundary_guard_rejects_when_regression_after_the_boundary", async () => {
  const guard = await import("../../scripts/migration-runner");
  // The second full-folder pass applies 66+ against the last-applied
  // watermark: any regression there is silently skipped, not applied.
  for (const regression of [
    { idx: 67, tag: "0067_c", when: 1791729521432 },
    { idx: 67, tag: "0067_c", when: 1791500000000 },
    { idx: 68, tag: "0068_d", when: 1791800000000 },
  ]) {
    const journal = orderedJournal();
    journal.entries[2] =
      regression.idx === 67 ? regression : journal.entries[2];
    if (regression.idx === 68) journal.entries[3] = regression;
    expect(() =>
      guard.validateMigrationJournalBoundary(journal as never),
    ).toThrow(/strictly increase|regression|skip/i);
  }
  // Sanity: the ordered journal and the real journal still pass.
  expect(() =>
    guard.validateMigrationJournalBoundary(orderedJournal() as never),
  ).not.toThrow();
  const real = JSON.parse(
    readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8"),
  );
  expect(() => guard.validateMigrationJournalBoundary(real)).not.toThrow();
});

test("boundary_guard_rejects_malformed_when_shapes", async () => {
  const guard = await import("../../scripts/migration-runner");
  for (const bad of [
    { idx: 65, tag: "0065_a", when: "1791710000000" },
    { idx: 65, tag: "0065_a" },
  ]) {
    const journal = orderedJournal();
    journal.entries[0] = bad as never;
    expect(() =>
      guard.validateMigrationJournalBoundary(journal as never),
    ).toThrow();
  }
  const journal = orderedJournal();
  journal.entries[3] = { idx: 68, tag: "0068_d", when: null } as never;
  expect(() =>
    guard.validateMigrationJournalBoundary(journal as never),
  ).toThrow();
});

test("catalog_grants_use_bare_role_names_and_schema_version_checks", () => {
  for (const file of [
    "0071_enterprise_model_route_catalog.sql",
    "0072_enterprise_expert_versions.sql",
  ]) {
    const sql = readFileSync(new URL(file, drizzleDir), "utf8");
    // House style (0055-0068): bare role names in GRANT as well as REVOKE.
    const grants = [...sql.matchAll(/GRANT[^\n]*TO "ob_ent_[a-z_]+"[^\n]*;/g)];
    expect(grants, `${file} quoted role in GRANT`).toHaveLength(0);
    // The snapshot-table guard symmetry: schema_version carries a > 0 check
    // like the event table's cursor check.
    expect(sql).toMatch(
      /"schema_version" integer NOT NULL CHECK \([^)]*"schema_version" > 0\)/,
    );
  }
});

// --- OCR R8: prefix-internal ordering, NOT VALID/VALIDATE pairing, rename ---

test("boundary_guard_rejects_when_regression_inside_the_prefix", async () => {
  const guard = await import("../../scripts/migration-runner");
  // The FIRST migrate pass is watermark-driven too: equal or regressed
  // prefix whens are silently skipped there (R8-M1).
  for (const prefix of [
    [
      { idx: 63, tag: "0063_a", when: 1791700000000 },
      { idx: 64, tag: "0064_b", when: 1791700000000 },
      { idx: 65, tag: "0065_c", when: 1791710000000 },
    ],
    [
      { idx: 63, tag: "0063_a", when: 1791700000000 },
      { idx: 64, tag: "0064_b", when: 1791715000000 },
      { idx: 65, tag: "0065_c", when: 1791710000000 },
    ],
  ]) {
    expect(() =>
      guard.validateMigrationJournalBoundary({
        entries: [
          ...prefix,
          { idx: 66, tag: "0066_d", when: 1791729521432 },
          { idx: 67, tag: "0067_e", when: 1791800000000 },
        ],
      } as never),
    ).toThrow(/strictly increase/i);
  }
  // Strictly increasing prefix still passes.
  expect(() =>
    guard.validateMigrationJournalBoundary({
      entries: [
        { idx: 63, tag: "0063_a", when: 1791600000000 },
        { idx: 64, tag: "0064_b", when: 1791700000000 },
        { idx: 65, tag: "0065_c", when: 1791710000000 },
        { idx: 66, tag: "0066_d", when: 1791729521432 },
        { idx: 67, tag: "0067_e", when: 1791800000000 },
      ],
    } as never),
  ).not.toThrow();
});

test("reserve_sentinel_catches_inherited_transaction_api", async () => {
  const guard = await import("../../scripts/migration-runner");
  // A future postgres.js that hangs options/begin off the prototype must
  // still stop the pinning, not silently shadow it (R8-L3).
  const inherited = Object.create({ begin: () => {} }) as object;
  expect(() => guard.assertReserveOmitsTransactionApi(inherited)).toThrow(
    /no longer omits options\/begin/,
  );
});

test("attempt_owner_check_is_not_valid_then_validated_after_creation", () => {
  const sql67 = readFileSync(
    new URL("0068_run_attempt_request_owner.sql", drizzleDir),
    "utf8",
  );
  const sql68 = readFileSync(
    new URL("0069_runner_event_log.sql", drizzleDir),
    "utf8",
  );
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8"),
  );
  // Added NOT VALID: the validation scan must not run under the DDL lock.
  expect(sql67).toMatch(
    /ADD CONSTRAINT "enterprise_run_attempts_request_owner_check"[\s\S]*NOT VALID;/,
  );
  // The companion VALIDATE runs in a LATER migration only (never in 0066 or
  // 0067 itself: the constraint must exist first, and one migration is one
  // transaction).
  expect(sql67).not.toContain("VALIDATE CONSTRAINT");
  expect(
    readFileSync(
      new URL(
        "0067_validate_enterprise_schema_invariant_guards.sql",
        drizzleDir,
      ),
      "utf8",
    ),
  ).not.toContain(
    'VALIDATE CONSTRAINT "enterprise_run_attempts_request_owner_check"',
  );
  expect(sql68).toContain(
    'ALTER TABLE "enterprise_run_attempts" VALIDATE CONSTRAINT "enterprise_run_attempts_request_owner_check";',
  );
  // The rename: journal tag matches the new file name.
  const tag67 = journal.entries.find(
    (entry: { idx: number }) => entry.idx === 68,
  );
  expect(tag67?.tag).toBe("0068_run_attempt_request_owner");
});

// --- OCR R8: error-classification pure functions ---

test("migration_error_classification_helpers", async () => {
  const guard = await import("../../scripts/migration-runner");
  const leaf = Object.assign(new Error("db said no"), { code: "55P03" });
  const middle = new Error("wrapper", { cause: leaf });
  const root = new Error("outer", { cause: middle });

  // sqlStateFromError walks the cause chain and can target a code.
  expect(guard.sqlStateFromError(root)).toBe("55P03");
  expect(guard.sqlStateFromError(root, "08000")).toBeUndefined();
  expect(guard.sqlStateFromError(new Error("bare"))).toBeUndefined();

  // Lock-timeout conversion only for 55P03, carrying the cause.
  const converted = guard.createMigrationLockTimeoutError(root, 5_000);
  expect(converted?.message).toContain("5000ms");
  expect((converted as { cause?: unknown }).cause).toBe(root);
  expect(
    guard.createMigrationLockTimeoutError(
      Object.assign(new Error("other"), { code: "08006" }),
      5_000,
    ),
  ).toBeUndefined();

  // errorChainContains is identity-based over the chain, cycle-safe.
  expect(guard.errorChainContains(root, leaf)).toBe(true);
  expect(guard.errorChainContains(root, new Error("lookalike"))).toBe(false);
  const cyclic = new Error("cyclic");
  (cyclic as { cause?: unknown }).cause = cyclic;
  expect(guard.errorChainContains(cyclic, cyclic)).toBe(true);

  // Connection failure: 08xxx class, named codes, through causes.
  expect(
    guard.isConnectionFailure(
      new Error("wrapped", {
        cause: Object.assign(new Error("gone"), { code: "08001" }),
      }),
    ),
  ).toBe(true);
  expect(
    guard.isConnectionFailure(
      Object.assign(new Error(), { code: "ECONNREFUSED" }),
    ),
  ).toBe(true);
  // 55P03 is lock contention, not a dead connection: it belongs to the
  // lock-timeout conversion path, not this classifier.
  expect(
    guard.isConnectionFailure(Object.assign(new Error(), { code: "55P03" })),
  ).toBe(false);
  expect(guard.isConnectionFailure(new Error("plain"))).toBe(false);
  expect(
    guard.isConnectionFailure(Object.assign(new Error(), { code: "12345" })),
  ).toBe(false);
});

// --- OCR R9: snapshot-chain FK-name consistency (R6 regression fix) ---

test("every_snapshot_records_the_same_explicit_event_fk_names", () => {
  const expected = [
    "enterprise_runner_events_attempts_fk",
    "enterprise_runner_events_conversations_fk",
    "enterprise_runner_events_runs_owner_fk",
  ];
  for (const file of readdirSync(new URL("meta/", drizzleDir))) {
    if (!/^00(6[5-9]|7[0-9])_snapshot\.json$/.test(file)) continue;
    const snapshot = JSON.parse(
      readFileSync(new URL(`meta/${file}`, drizzleDir), "utf8"),
    );
    const table = snapshot.tables?.["public.enterprise_runner_events"];
    if (!table) continue;
    // A snapshot that records the table must record the same explicit FK
    // names as every other one, or the next generate diffs a phantom
    // constraint rename against names no real database carries.
    expect(Object.keys(table.foreignKeys ?? {}).sort(), file).toEqual(
      file.startsWith("0069")
        ? [
            "enterprise_runner_events_attempts_fk",
            "enterprise_runner_events_runs_fk",
          ].sort()
        : expected,
    );
  }
  // And the journal keeps its trailing newline for clean future appends.
  const journal = readFileSync(
    new URL("meta/_journal.json", drizzleDir),
    "utf8",
  );
  expect(journal.endsWith("}\n")).toBe(true);
});
