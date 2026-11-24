import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  canMergeMigrationHistories,
  isIntelligenceMigration,
} from "../src/db/merge-migration-histories";
import {
  migrationsOutOfReach,
  readMigrationFolder,
} from "../src/db/migration-reach";

const folder = await readMigrationFolder(
  fileURLToPath(new URL("../drizzle/", import.meta.url)),
);
const skillMarket = /^009[012]_skill_market/;
const corsair = /^010[5-8]_corsair/;
const bifrost =
  /^011[78]_(?:bifrost_market_reviews|skill_market_equivalences)$/;
const shared = ({ when }: (typeof folder)[number]) => when <= 1795157993281;
const integrations = [
  ["Corsair main", ({ tag }) => skillMarket.test(tag) || corsair.test(tag)],
  [
    "Bifrost main",
    ({ tag }) =>
      skillMarket.test(tag) || corsair.test(tag) || bifrost.test(tag),
  ],
  [
    "main with Bifrost reviews only",
    ({ tag }) =>
      skillMarket.test(tag) ||
      corsair.test(tag) ||
      tag === "0117_bifrost_market_reviews",
  ],
  [
    "early intelligence integration",
    (entry) =>
      entry.when <= 1795228622495 &&
      (isIntelligenceMigration(entry) || skillMarket.test(entry.tag)),
  ],
  [
    "published intelligence integration",
    (entry) =>
      isIntelligenceMigration(entry) ||
      skillMarket.test(entry.tag) ||
      corsair.test(entry.tag) ||
      bifrost.test(entry.tag),
  ],
  [
    "published main",
    (entry) =>
      entry.when <= 1795443105536 &&
      !(entry.when >= 1795441880621 && entry.when <= 1795441880623) &&
      !isIntelligenceMigration(entry),
  ],
] satisfies [string, (entry: (typeof folder)[number]) => boolean][];

describe("reconciling the published intelligence and main journals", () => {
  for (const [name, accepts] of integrations) {
    const applied = folder
      .filter((entry) => shared(entry) || accepts(entry))
      .map(({ hash, when }) => ({ hash, createdAt: when }));

    test(`fills verified migration gaps from ${name}`, () => {
      const skipped = migrationsOutOfReach(folder, applied);
      expect(skipped.length).toBeGreaterThan(0);
      expect(canMergeMigrationHistories(folder, applied, skipped)).toBe(true);
    });

    test(`refuses a missing shared migration from ${name}`, () => {
      const incomplete = applied.slice(1);
      expect(
        canMergeMigrationHistories(
          folder,
          incomplete,
          migrationsOutOfReach(folder, incomplete),
        ),
      ).toBe(false);
    });
  }
});
