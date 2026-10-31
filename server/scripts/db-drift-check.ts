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
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "TEST_DATABASE_URL or DATABASE_URL must point at a freshly migrated database",
  );
}

// 声明侧：表 → 列（DB 名），来自运行时 drizzle:Columns
const declared = new Map<string, Set<string>>();
// #675: 声明侧的主键约束名（只有显式命名的主键才登记——列级 .primaryKey() 用的是
// Postgres 默认 <table>_pkey，没有可比的声明值）。匿名 PRIMARY KEY 在 0211 落地成
// <table>_pkey，镜像却写着命名约束，结构比对看不见这类分叉。
const declaredPk = new Map<string, string>();
/**
 * #675: PostgreSQL truncates identifiers at 63 bytes, silently — a declared constraint name
 * longer than that lands shortened, so the comparison must ask what PG would actually store
 * rather than flagging the declaration's tail as drift.
 */
const pgIdentifier = (name: string) => name.slice(0, 63);
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
      const pkName = getTableConfig(v as PgTable).primaryKeys[0]?.getName();
      if (pkName) declaredPk.set(name, pkName);
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
`;
const live = new Map<string, Set<string>>();
for (const r of rows) {
  live.set(
    r.table_name,
    (live.get(r.table_name) ?? new Set()).add(r.column_name),
  );
}
// #675: what the migration chain actually NAMED each primary key. `contype = 'p'`
// is the primary-key constraint; an anonymous `PRIMARY KEY (...)` clause lands as
// `<table>_pkey`, so a declaration that names it differently is drift the column
// comparison could never see.
const pkRows = await sql`
  select cl.relname as table_name, c.conname
  from pg_constraint c
  join pg_class cl on cl.oid = c.conrelid
  join pg_namespace n on n.oid = cl.relnamespace
  where n.nspname = 'public' and c.contype = 'p'
`;
await sql.end({ timeout: 5 }).catch(() => undefined);
const livePk = new Map<string, string>();
for (const r of pkRows) livePk.set(r.table_name, r.conname);

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
for (const [t, expected] of declaredPk) {
  const actual = livePk.get(t);
  if (actual === undefined) {
    console.error(
      `declared primary key missing from migrations: ${t} (${expected})`,
    );
    bad++;
  } else if (actual !== pgIdentifier(expected)) {
    console.error(
      `primary key name drift: ${t} declares "${pgIdentifier(expected)}", migrations created "${actual}"`,
    );
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
