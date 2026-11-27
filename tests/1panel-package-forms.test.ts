import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const apps = join(import.meta.dir, "../deploy/1panel/apps");
// 1Panel loads the card from <app>/data.yml and each version from <app>/<version>/data.yml.
const forms = readdirSync(apps, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((app) => [
    join(apps, app.name, "data.yml"),
    ...readdirSync(join(apps, app.name), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((version) => join(apps, app.name, version.name, "data.yml")),
  ]);

type Form = {
  additionalProperties?: { formFields?: Array<Record<string, unknown>> };
};

// yaml.parse rejects duplicate keys, as does the parser in 1Panel: a version it cannot parse is
// dropped from the app list, and once no instance is installed the app card disappears with it.
test.each(forms)("1Panel can load %s", (file) => {
  const form = parse(readFileSync(file, "utf8")) as Form;
  const fields = form.additionalProperties?.formFields ?? [];
  for (const field of fields) {
    // Every field must name the variable it sets. A field body folded into its neighbour keeps
    // that neighbour's envKey, so parse() above is what catches a fold, not this assertion.
    expect(field.envKey, `${file}: form field without envKey`).toBeString();
  }
});
