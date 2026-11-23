import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import postgres from "postgres";
import { z } from "zod";
import { packageManifest } from "../../scripts/skill-migration/source";
import { createBifrostMarket } from "../../src/skill-market/bifrost";

const sourceUrl = "postgres://bifrost:fixture@db/skillhub_fixture";
const targetUrl =
  "postgres://openbot_skill_reader:fixture-market-reader@db/restored_upgrade";
const gateway = "http://gateway:8080";
const sql = postgres(sourceUrl);
const market = createBifrostMarket({
  kind: "bifrost",
  namespace: "bifrost",
  databaseUrl: targetUrl,
});
const storage = await mkdtemp(join(tmpdir(), "skillhub-migration-fixture-"));
const reportSchema = z.object({
  ready: z.boolean(),
  entries: z.array(
    z.object({
      status: z.string(),
      source: z.object({ version: z.string() }),
      target: z.unknown().optional(),
      kind: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
const original = Buffer.from(
  "---\r\n# Publisher comment\r\nname: migrated-fixture\r\ndescription: 'Fixture skill'\r\nmetadata:\r\n  openbot-compatibility: {scripts: false, supportingFiles: false, dedicatedRuntime: false}\r\n---\r\n\r\nExact original instructions.\r\n",
);
const mainV2 = Buffer.from(original.toString().replace("original", "second"));
const asset = Buffer.from([0, 255, 16]);

try {
  await sql`create table namespace (id bigint primary key, slug text)`;
  await sql`create table skill (
    id bigint primary key, namespace_id bigint, slug text, owner_id text,
    status text, hidden boolean, visibility text, latest_version_id bigint
  )`;
  await sql`create table skill_version (
    id bigint primary key, skill_id bigint, version text, status text, created_by text,
    published_at timestamptz, yanked_at timestamptz, yank_reason text, file_count integer,
    total_size bigint, download_ready boolean
  )`;
  await sql`create table skill_file (
    version_id bigint, file_path text, file_size bigint, sha256 text, storage_key text
  )`;
  await sql`create table review_task (
    id bigint primary key, skill_version_id bigint, subject_type text, status text,
    submitted_by text, reviewed_by text, reviewed_at timestamptz, review_comment text,
    decision_method text
  )`;
  await sql`insert into namespace values (1, 'catalog')`;
  await sql`insert into skill values (10, 1, 'migrated-fixture', 'publisher', 'ACTIVE', false, 'NAMESPACE_ONLY', 22)`;
  await sql`insert into skill_version values
    (21, 10, '1.0.0', 'PUBLISHED', 'publisher', now(), null, null, 2, ${original.length + asset.length}, true),
    (22, 10, '2.0.0', 'PUBLISHED', 'publisher', now(), null, null, 1, ${mainV2.length}, true),
    (23, 10, '0.9.0', 'YANKED', 'publisher', now(), now(), 'withdrawn fixture', 1, ${original.length}, false),
    (24, 10, '3.0.0', 'DRAFT', 'publisher', null, null, null, 0, 0, false)`;
  await sql`insert into review_task values (31, 22, 'SKILL_VERSION', 'APPROVED', 'publisher', 'reviewer', now(), 'OpenBot compatibility confirmed.', 'HUMAN')`;
  for (const file of [
    { version: 21, path: "SKILL.md", key: "one", bytes: original },
    {
      version: 21,
      path: "assets/nested/data.bin",
      key: "binary",
      bytes: asset,
    },
    { version: 22, path: "SKILL.md", key: "two", bytes: mainV2 },
    { version: 23, path: "SKILL.md", key: "withdrawn", bytes: original },
  ]) {
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    await sql`insert into skill_file values (${file.version}, ${file.path}, ${file.bytes.length}, ${digest}, ${file.key})`;
    if (file.key !== "one")
      await writeFile(join(storage, file.key), file.bytes);
  }

  const login = await fetch(`${gateway}/api/session/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "fixture-admin",
      password: "fixture-admin-password",
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .join("; ");
  assert(cookie);
  await login.body?.cancel();

  async function migrate(mode: "import" | "verify", expectedStatus: number) {
    const proc = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "server/scripts/migrate-skill-market.ts",
        mode,
      ],
      {
        env: {
          ...process.env,
          SKILLHUB_URL: "https://skillhub.fixture.test",
          SKILLHUB_CATALOG_NAMESPACE: "catalog",
          SKILLHUB_MIGRATION_SNAPSHOT_ID: "rehearsal",
          SKILLHUB_MIGRATION_DATABASE_URL: sourceUrl,
          SKILLHUB_MIGRATION_STORAGE_ROOT: storage,
          SKILLHUB_COMPATIBILITY_CONFIRMATIONS: JSON.stringify([
            {
              slug: "migrated-fixture",
              version: "2.0.0",
              versionId: 22,
              fingerprint: packageManifest(new Map([["SKILL.md", mainV2]]))
                .fingerprint,
              reviewTaskId: 31,
              reviewerId: "reviewer",
            },
          ]),
          BIFROST_SKILL_MARKET_DATABASE_URL: targetUrl,
          BIFROST_MIGRATION_URL: gateway,
          BIFROST_MIGRATION_REGISTRY_ID: "fixture-bifrost",
          ...(mode === "import" ? { BIFROST_MIGRATION_COOKIE: cookie } : {}),
        },
        stdout: "pipe",
        stderr: "inherit",
      },
    );
    const output = await new Response(proc.stdout).text();
    const parsed: unknown = JSON.parse(output);
    assert.equal(await proc.exited, expectedStatus, output);
    return { report: reportSchema.parse(parsed), raw: parsed };
  }

  const blocked = (await migrate("import", 1)).report;
  assert.equal(
    blocked.entries.filter(({ status }) => status === "failed").length,
    2,
  );
  assert.match(
    blocked.entries.find(({ source }) => source.version === "2.0.0")?.error ??
      "",
    /Import deferred/,
  );
  await rm(join(storage, "two"));
  await writeFile(join(storage, "one"), original);
  const partial = (await migrate("import", 1)).report;
  assert.equal(partial.ready, false);
  assert.match(
    partial.entries.find(({ status }) => status === "failed")?.error ?? "",
    /Missing or unreadable source object/,
  );
  const saved = partial.entries.find(
    ({ source }) => source.version === "1.0.0",
  )?.target;
  assert(saved);

  await writeFile(join(storage, "two"), mainV2);
  const imported = await migrate("import", 0);
  const rerun = await migrate("import", 0);
  assert.deepEqual(rerun.raw, imported.raw);
  const verified = (await migrate("verify", 0)).report;
  assert.deepEqual(verified.entries.map(({ status }) => status).sort(), [
    "verified",
    "verified",
    "withdrawn",
  ]);
  assert.deepEqual(
    verified.entries.find(({ source }) => source.version === "1.0.0")?.target,
    saved,
  );
  assert.deepEqual(
    (await market.detail("bifrost", "migrated-fixture", 0)).versions.sort(),
    ["1.0.0", "2.0.0"],
  );
  const response = await market.download(
    "bifrost",
    "migrated-fixture",
    "1.0.0",
  );
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  assert.deepEqual(Buffer.from(files["SKILL.md"]), original);
  assert.deepEqual(Buffer.from(files["assets/nested/data.bin"]), asset);

  const changed = Buffer.from([1, 255, 16]);
  await writeFile(join(storage, "binary"), changed);
  const digest = createHash("sha256").update(changed).digest("hex");
  await sql`update skill_file set sha256 = ${digest} where storage_key = 'binary'`;
  const conflicting = (await migrate("import", 1)).report;
  assert.equal(
    conflicting.entries.find(({ status }) => status === "failed")?.kind,
    "conflict",
  );
  const current = await market.readExactPackage(
    "bifrost",
    "migrated-fixture",
    "1.0.0",
  );
  assert.deepEqual(current.files.get("assets/nested/data.bin"), asset);

  await sql`update skill_version set status = 'YANKED', yanked_at = now() where id = 21`;
  const withdrawn = (await migrate("verify", 1)).report;
  assert.match(
    withdrawn.entries.find(({ status }) => status === "failed")?.error ?? "",
    /withdrawn coordinate already exists/,
  );
  console.log(
    "SkillHub migration passed exact bytes, interrupted retry, stable IDs, conflicts, and withdrawal checks",
  );
} finally {
  await Promise.all([
    sql.end(),
    market.close(),
    rm(storage, { recursive: true, force: true }),
  ]);
}
