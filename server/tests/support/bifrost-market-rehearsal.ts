import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import postgres from "postgres";
import { loadSkillMarketConfig } from "../../src/skill-market/config";
import { createSkillMarketRoutes } from "../../src/skill-market/routes";

const config = loadSkillMarketConfig(process.env);
assert(config && "kind" in config);
const reader = postgres(config.databaseUrl, { max: 1 });
const routes = createSkillMarketRoutes(async (context, next) => {
  if (context.req.header("cookie") !== "fixture-session")
    return context.body(null, 401);
  await next();
}, config);
const headers = { cookie: "fixture-session" };
const skill = "/bifrost/market-rehearsal";
const historical = `${skill}/versions/1.0.0`;

try {
  for (const path of [
    "/?q=market",
    skill,
    historical,
    `${historical}/download`,
  ])
    assert.equal((await routes.request(path)).status, 401);

  const search = await routes.request("/?q=MARKET-rehearsal", { headers });
  assert.equal(search.status, 200);
  const { items } = await search.json();
  assert.deepEqual(
    items.map((item: { slug: string; latestVersion: string }) => [
      item.slug,
      item.latestVersion,
    ]),
    [["market-rehearsal", "2.0.0"]],
  );
  const detail = await routes.request(skill, { headers });
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).versions, ["2.0.0", "1.0.0"]);
  const preview = await routes.request(historical, { headers });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Cache-Control"), "private, no-store");
  const version = await preview.json();
  assert.equal(version.instructions, "Original instructions.\n");
  assert.equal(version.installable, false);

  const download = await routes.request(`${historical}/download`, { headers });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("Content-Type"), "application/zip");
  const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), [
    "SKILL.md",
    "assets/fixture.bin",
    "references/nested/notes.md",
    "scripts/check.sh",
  ]);
  assert.equal(
    Buffer.from(files["SKILL.md"]).toString(),
    '---\nname: "market-rehearsal"\ndescription: "Historical market rehearsal"\n---\nOriginal instructions.\n',
  );
  assert.deepEqual(
    Buffer.from(files["assets/fixture.bin"]),
    Buffer.from([0, 255, 16]),
  );
  assert.equal(
    Buffer.from(files["references/nested/notes.md"]).toString(),
    "Original reference.\n",
  );
  assert.equal(Buffer.from(files["scripts/check.sh"]).toString(), "echo old\n");

  // The upgrade fixture predates the seal trigger, even though its data is readable.
  assert.equal(
    (
      await routes.request(
        "/bifrost/upgrade-rehearsal/versions/1.0.0/download",
        { headers },
      )
    ).status,
    502,
  );
  for (const slug of [
    "missing-blob",
    "wrong-size",
    "mutable-url",
    "missing-file-row",
    "altered-blob",
  ]) {
    const error = await routes.request(
      `/bifrost/${slug}/versions/1.0.0/download`,
      { headers },
    );
    assert.equal(error.status, 502, slug);
    assert.equal(error.headers.get("Content-Disposition"), null, slug);
    assert.match(
      (await error.json()).error,
      /incomplete or failed an integrity check/,
      slug,
    );
  }
  assert.equal(
    (await routes.request(`${skill}/versions/9.0.0/download`, { headers }))
      .status,
    404,
  );
  assert.equal(
    (await routes.request("/other/market-rehearsal", { headers })).status,
    404,
  );
  await assert.rejects(
    reader`update openbot_skill_market.catalog set description = 'changed'`,
    { code: "42501" },
  );
  await assert.rejects(
    reader`insert into public.skills (name) values ('denied')`,
    { code: "42501" },
  );
  await assert.rejects(reader`delete from openbot_skill_market.package_seals`, {
    code: "42501",
  });
  await assert.rejects(reader`delete from public.skills`, { code: "42501" });
  await assert.rejects(reader`select * from public.skills`, { code: "42501" });
  console.log(
    "OpenBot authenticated browse, exact version ZIP bytes, fail-closed downloads, and SELECT-only grants passed",
  );
} finally {
  await reader.end();
}
