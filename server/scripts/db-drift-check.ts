/**
 * #436 gate: every column `server/src/db/schema/*.ts` declares must exist in a database
 * built by the migration chain alone (fresh `bun scripts/migrate.ts`), and vice versa.
 *
 * The old `drizzle-kit generate` probe only compared schema ↔ snapshot, which is blind to a
 * snapshot that has drifted from the SQL — the exact failure that shipped 38 tables / 292
 * columns with no migration (#436). This check asks the database itself.
 *
 * Exit 0 only when both directions are empty.
 */
import * as fs from "node:fs";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL must point at a freshly migrated database",
  );
}

// 声明侧：表 → 列（DB 名），来自运行时 drizzle:Columns
const declared = new Map<string, Set<string>>();
// Same base as the import below: a CWD-relative read entered a different
// schema set than the one actually imported (and threw a bare ENOENT).
const schemaDir = new URL("../src/db/schema/", import.meta.url);
for (const f of fs
  .readdirSync(schemaDir)
  .filter((x) => x.endsWith(".ts") && x !== "index.ts")) {
  const mod = await import(`../src/db/schema/${f}`);
  for (const v of Object.values(mod)) {
    // drizzle-orm runtime internals (not public API): the Columns/Name symbols
    // are how a pgTable carries its SQL name and column map at runtime. Pinned
    // by bun.lock; re-check both symbols if drizzle-orm is ever upgraded.
    const table = v as Record<symbol, unknown> | undefined;
    const cols = table?.[Symbol.for("drizzle:Columns")] as
      | Record<string, { name: string }>
      | undefined;
    const name = table?.[Symbol.for("drizzle:Name")];
    if (typeof name === "string" && cols) {
      if (declared.has(name)) {
        throw new Error(
          `duplicate declared table "${name}" in ${f}; a copied schema file must not silently shadow the earlier one`,
        );
      }
      declared.set(name, new Set(Object.values(cols).map((c) => c.name)));
    }
  }
}

const sql = postgres(url);
// information_schema.columns also lists plain views; join the table inventory
// so only base tables take part in the comparison.
const rows = await sql`
  select c.table_name, c.column_name
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
`.finally(() => sql.end({ timeout: 5 }).catch(() => undefined));
const live = new Map<string, Set<string>>();
for (const r of rows) {
  live.set(
    r.table_name,
    (live.get(r.table_name) ?? new Set()).add(r.column_name),
  );
}

let bad = 0;
for (const [t, cols] of declared) {
  const l = live.get(t);
  if (!l) {
    console.error(
      `declared table missing from migrations: ${t} (${cols.size} columns)`,
    );
    bad += cols.size;
    continue;
  }
  for (const c of cols) {
    if (!l.has(c)) {
      console.error(`declared column missing from migrations: ${t}.${c}`);
      bad++;
    }
  }
}
for (const [t, cols] of live) {
  const declaredCols = declared.get(t);
  if (!declaredCols) {
    console.error(`migration table absent from schema declarations: ${t}`);
    bad++;
    continue;
  }
  for (const c of cols) {
    if (!declaredCols.has(c)) {
      console.error(
        `migration column absent from schema declarations: ${t}.${c}`,
      );
      bad++;
    }
  }
}
if (bad > 0) {
  console.error(
    `schema/migration drift: ${bad} problem(s). Run migrations, or update the schema.`,
  );
  process.exit(1);
}
console.log(
  `no drift: ${declared.size} declared tables, all columns present both ways`,
);
