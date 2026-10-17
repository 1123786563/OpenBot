import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { readFileSync } from "node:fs";

const configSrc = readFileSync("./drizzle.config.ts", "utf8");
const files = [...new Set([...configSrc.matchAll(/"\.\/src\/db\/schema\/([a-z0-9-]+)\.ts"/g)].map(m => `./src/db/schema/${m[1]}.ts`))];
for (const f of files) { if (!existsSync(f)) throw new Error(`config lists missing file: ${f}`); }
const imports: Record<string, unknown> = {};
for (const f of files) Object.assign(imports, await import(f));

const cur = generateDrizzleJson(imports, "chain-head");
const prevPath = process.argv[2];
const prev = JSON.parse(readFileSync(prevPath, "utf8"));

// A: full migration diff (what generate would emit)
const statements = await generateMigration(prev as any, cur);
console.log(`[A] generateMigration(${prevPath} -> schema): ${statements.length} statements`);
for (const s of statements) console.log("   |", s.slice(0, 160).replace(/\n/g, " "));

// B: structural equality of tables section
const eq = JSON.stringify(prev.tables) === JSON.stringify(cur.tables);
console.log(`[B] prev.tables deep-equals serialized schema.tables: ${eq}`);
if (!eq) {
  const allKeys = [...new Set([...Object.keys(prev.tables), ...Object.keys(cur.tables)])];
  for (const k of allKeys) {
    const a = JSON.stringify((prev.tables as any)[k] ?? null);
    const b = JSON.stringify((cur.tables as any)[k] ?? null);
    if (a !== b) console.log(`   DIFF at ${k}`);
  }
}
function existsSync(p: string) { try { readFileSync(p); return true; } catch { return false; } }
