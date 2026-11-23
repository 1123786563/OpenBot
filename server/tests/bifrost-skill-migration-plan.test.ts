import { expect, test } from "bun:test";
import { verifySourceFiles } from "../scripts/skill-migration/source";

test("blocks missing source objects and altered bytes even when the length matches", async () => {
  const file = {
    path: "SKILL.md",
    size: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    storageKey: "object",
  };
  await expect(
    verifySourceFiles([file], { count: 2, size: 3 }, async () =>
      Buffer.from("abc"),
    ),
  ).rejects.toThrow("manifest");
  await expect(
    verifySourceFiles([file], { count: 1, size: 3 }, async () =>
      Buffer.from("bad"),
    ),
  ).rejects.toThrow("SKILL.md");
  await expect(
    verifySourceFiles([file], { count: 1, size: 3 }, async () =>
      Buffer.from("abc"),
    ),
  ).resolves.toEqual(new Map([["SKILL.md", Buffer.from("abc")]]));
});

test("Bifrost backfill order is numeric and preserves exact suffixes", async () => {
  const { compareVersionCores, versionCore } = await import(
    "../scripts/skill-migration/target"
  );
  const versions = ["10.0.0", "2.10.0", "2.2.0", "2.2.0-rc.1"];
  expect(
    versions.sort((a, b) =>
      compareVersionCores(versionCore(a), versionCore(b)),
    ),
  ).toEqual(["2.2.0", "2.2.0-rc.1", "2.10.0", "10.0.0"]);
  expect(versionCore("2.0.0+build")).toBeUndefined();
});
