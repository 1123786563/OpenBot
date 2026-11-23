import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { canMergeMigrationHistories } from "../src/db/merge-migration-histories";
import {
  migrationsOutOfReach,
  readMigrationFolder,
} from "../src/db/migration-reach";

const folder = await readMigrationFolder(
  fileURLToPath(new URL("../drizzle/", import.meta.url)),
);
const mainTags = /^(?:009[012]_skill_market|009[3456]_corsair)/;
const integrations = [
  ["Corsair main", (tag: string) => mainTags.test(tag)],
  ["intelligence integration", (tag: string) => !tag.includes("_corsair")],
] as const;

describe("reconciling the published intelligence and Corsair journals", () => {
  for (const [name, accepts] of integrations) {
    const applied = folder
      .filter(({ tag, when }) => when <= 1795157993281 || accepts(tag))
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
