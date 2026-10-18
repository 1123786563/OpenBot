import { generateDrizzleJson } from "drizzle-kit/api";
import { readFileSync, writeFileSync } from "node:fs";

const configSrc = readFileSync("./drizzle.config.ts", "utf8");
const files = [...new Set([...configSrc.matchAll(/"\.\/src\/db\/schema\/([a-z0-9-]+)\.ts"/g)].map(m => `./src/db/schema/${m[1]}.ts`))];
const imports: Record<string, unknown> = {};
for (const f of files) Object.assign(imports, await import(f));
const cur = generateDrizzleJson(imports, "chain-head") as any;

// normalize ai_observation entries in a snapshot file to the drizzle-kit serialization
const path = process.argv[2];
const prev = JSON.parse(readFileSync(path, "utf8"));
let fixes = 0;
for (const [key, t] of Object.entries(prev.tables as Record<string, any>)) {
  if (!key.startsWith("public.ai_observation")) continue;
  const ref = cur.tables[key];
  if (!ref) { console.log(`${key}: NOT IN TS SCHEMA (unexpected)`); continue; }
  // check constraints: replace value with canonical serialization
  for (const [ck, cv] of Object.entries(t.checkConstraints ?? {})) {
    const refVal = (ref.checkConstraints as any)?.[ck]?.value;
    if (refVal !== undefined && (cv as any).value !== refVal) {
      console.log(`${key}.${ck}.value:\n  snap: ${(cv as any).value.slice(0, 80)}\n  ts:   ${refVal.slice(0, 80)}`);
      (cv as any).value = refVal; fixes++;
    }
  }
  // column defaults: match JSON type of reference
  for (const [col, cv] of Object.entries(t.columns ?? {})) {
    const refCol = (ref.columns as any)?.[col];
    if (!refCol) continue;
    if ("default" in cv && JSON.stringify(cv.default) !== JSON.stringify(refCol.default)) {
      console.log(`${key}.${col}.default: ${JSON.stringify(cv.default)} -> ${JSON.stringify(refCol.default)}`);
      cv.default = refCol.default; fixes++;
    }
  }
}
writeFileSync(path, JSON.stringify(prev, null, 2) + "\n");
console.log(`${path}: ${fixes} fixes applied`);
