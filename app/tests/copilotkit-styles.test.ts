import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("app source does not load CopilotKit's global UI stylesheet", () => {
  const source = fileURLToPath(new URL("../src/", import.meta.url));
  const imports = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(
      (file) => file.isFile() && /\.(?:[cm]?[jt]sx?|css)$/.test(file.name),
    )
    .map((file) => join(file.parentPath, file.name))
    .filter((file) =>
      readFileSync(file, "utf8").includes(
        "@copilotkit/react-core/v2/styles.css",
      ),
    );
  expect(imports).toEqual([]);
});
