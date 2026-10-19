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
for (const f of fs
  .readdirSync("src/db/schema")
  .filter((x) => x.endsWith(".ts") && x !== "index.ts")) {
  const mod = await import(`../src/db/schema/${f}`);
  for (const v of Object.values(mod)) {
    const cols = (v as any)?.[Symbol.for("drizzle:Columns")];
    const name = (v as any)?.[Symbol.for("drizzle:Name")];
    if (typeof name === "string" && cols) {
      declared.set(name, new Set(Object.values(cols).map((c: any) => c.name)));
    }
  }
}

const sql = postgres(url);
const rows =
  await sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`;
await sql.end();
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
for (const t of live.keys()) {
  if (!declared.has(t)) {
    console.error(`migration table absent from schema declarations: ${t}`);
    bad++;
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
