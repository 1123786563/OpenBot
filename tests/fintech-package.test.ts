import { fileURLToPath } from "node:url";
import { expect, test } from "./support/e2e-compat";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const herePath = fileURLToPath(import.meta.url);
const hereDir = dirname(herePath);

const fintechDirectory = join(hereDir, "..", "examples", "fintech");

test("includes the complete fintech deployment package example", () => {
  for (const fileName of [
    "brand.yaml",
    "agents.yaml",
    "channels.yaml",
    "model.yaml",
  ]) {
    expect(existsSync(join(fintechDirectory, fileName))).toBe(true);
  }

  expect(readFileSync(join(fintechDirectory, "brand.yaml"), "utf8")).toContain(
    "id: openbot",
  );
});
