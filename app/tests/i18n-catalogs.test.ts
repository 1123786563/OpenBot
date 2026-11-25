import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runExtractor, runLinter } from "i18next-cli";
import config from "../i18next.config";

/**
 * The static check of the two bundled catalogs, on the test path CI already runs. The i18next CLI gives the ICU
 * verdict (syntax, arguments against English, plural categories per language); what it leaves out is here:
 * keys, messages still untranslated, approved terms, order, and whether the catalogs are up to date with the
 * source (`bun run i18n:extract`).
 */

type Catalog = Record<string, unknown>;

/**
 * The words OpenBot always uses one way. The English message is matched without case, the Chinese one must
 * show the term. 管理员 is forced when the English says "admins" (people); a lone "admin" can be the
 * navigation label (管理) or the person, so either is accepted — tighten it when a message gets that wrong.
 */
const TERMS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/openbot/i, ["OpenBot"]],
  [/\bbots?\b/i, ["Bot"]],
  [/\bconnections?\b/i, ["连接"]],
  [/\bcapabilit(y|ies)\b/i, ["能力"]],
  [/\bskills?\b/i, ["技能"]],
  [/\bconversations?\b/i, ["对话"]],
  [/\bmemor(y|ies)\b/i, ["记忆"]],
  [/\badmins\b/i, ["管理员"]],
  [/\badmin\b/i, ["管理", "管理员"]],
  [/\bbackends?\b/i, ["后端"]],
];

const CATALOGS = join(import.meta.dir, "../src/i18n/locales");
const written: string[] = [];
afterAll(() => {
  for (const dir of written) rmSync(dir, { recursive: true, force: true });
});

/** Everything wrong with the en and zh-CN catalogs in `dir`, each said once, in words a person can act on. */
async function problemsIn(dir: string): Promise<string[]> {
  const problems: string[] = [];
  const catalog = (language: string) =>
    JSON.parse(readFileSync(join(dir, `${language}.json`), "utf8")) as Catalog;
  const en = catalog("en");
  const zh = catalog("zh-CN");
  const enKeys = Object.keys(en);
  const zhKeys = Object.keys(zh);
  for (const [language, keys] of [
    ["en", enKeys],
    ["zh-CN", zhKeys],
  ] as const) {
    if (!keys.every((key, index) => index === 0 || keys[index - 1] < key))
      problems.push(`${language} catalog keys are not in alphabetical order`);
  }
  for (const [language, catalog, other] of [
    ["en", en, zh],
    ["zh-CN", zh, en],
  ] as const) {
    for (const key of Object.keys(catalog)) {
      const message = catalog[key];
      if (typeof message !== "string")
        problems.push(`${language} "${key}" is not a message`);
      else if (message === "")
        problems.push(
          language === "en"
            ? `en "${key}" has no English message`
            : `zh-CN "${key}" is not translated yet`,
        );
      if (!(key in other))
        problems.push(
          language === "en"
            ? `zh-CN is missing "${key}"`
            : `zh-CN has an extra key "${key}"`,
        );
    }
  }
  for (const key of enKeys) {
    const english = en[key];
    const chinese = zh[key];
    if (typeof english !== "string" || typeof chinese !== "string") continue;
    for (const [word, terms] of TERMS) {
      if (word.test(english) && !terms.some((term) => chinese.includes(term)))
        problems.push(
          `zh-CN "${key}" does not use the approved term ${terms
            .map((term) => `"${term}"`)
            .join(" or ")}`,
        );
    }
  }

  // No source to read: only the catalogs, so untranslated pages elsewhere in the app are not reported here.
  const { files } = await runLinter({
    ...config,
    extract: {
      ...config.extract,
      input: [],
      output: (language) => join(dir, `${language}.json`),
    },
  });
  for (const [file, issues] of Object.entries(files)) {
    const language = basename(file, ".json");
    for (const issue of issues) problems.push(`${language}: ${issue.text}`);
  }
  return problems;
}

/** Two catalogs on disk, as the extractor leaves them, in a directory that leaves with the test. */
function catalogs(en: Catalog, zh: Catalog): string {
  const dir = mkdtempSync(join(tmpdir(), "openbot-catalogs-"));
  written.push(dir);
  writeFileSync(join(dir, "en.json"), JSON.stringify(en));
  writeFileSync(join(dir, "zh-CN.json"), JSON.stringify(zh));
  return dir;
}

const ENGLISH: Catalog = {
  "bots.count": "{count, plural, one {# Bot} other {# Bots}}",
  "notice.pick":
    "{name, select, bot {{count, plural, one {One Bot called {name}.} other {# Bots called {name}.}}} other {Bots.}}",
  "notice.read": "Read the <0>notes</0> for {product}.",
  "settings.language.title": "Language",
};
const CHINESE: Catalog = {
  "bots.count": "{count, plural, other {# 个 Bot}}",
  "notice.pick":
    "{name, select, bot {{count, plural, other {一个叫 {name} 的 Bot，或 # 个。}}} other {Bot。}}",
  "notice.read": "阅读 {product} 的<0>说明</0>。",
  "settings.language.title": "语言",
};

test("the two bundled catalogs are in step, translated and speak ICU", async () => {
  expect(await problemsIn(CATALOGS)).toEqual([]);
});

test("two languages that pluralize differently are in step", async () => {
  expect(await problemsIn(catalogs(ENGLISH, CHINESE))).toEqual([]);
});

test("each way a catalog can break is caught, not waved through", async () => {
  const without = (catalog: Catalog, key: string): Catalog => {
    const copy = { ...catalog };
    delete copy[key];
    return copy;
  };
  const cases: readonly [string, Catalog, Catalog][] = [
    ["zh-CN is missing", ENGLISH, without(CHINESE, "settings.language.title")],
    ["has an extra key", ENGLISH, { ...CHINESE, "zz.extra": "多余" }],
    [
      "is not translated yet",
      ENGLISH,
      { ...CHINESE, "settings.language.title": "" },
    ],
    [
      "has no English message",
      { ...ENGLISH, "settings.language.title": "" },
      CHINESE,
    ],
    [
      "is not a message",
      ENGLISH,
      { ...CHINESE, "settings.language.title": 12 },
    ],
    [
      "ICU syntax error",
      { ...ENGLISH, "settings.language.title": "{name" },
      CHINESE,
    ],
    [
      'arguments differ from "en": missing {count}, unexpected {amount}',
      ENGLISH,
      { ...CHINESE, "bots.count": "{amount, plural, other {# 个 Bot}}" },
    ],
    [
      'arguments differ from "en": missing {count}, unexpected {total}',
      ENGLISH,
      {
        ...CHINESE,
        "notice.pick":
          "{name, select, bot {{total, plural, other {一个叫 {name} 的 Bot，或 # 个。}}} other {Bot。}}",
      },
    ],
    [
      "MISSING_OTHER_CLAUSE",
      {
        ...ENGLISH,
        "notice.pick":
          "{name, select, bot {{count, plural, one {# Bot}}} other {Bots.}}",
      },
      CHINESE,
    ],
    [
      'has categories "zh-CN" does not use: one',
      ENGLISH,
      {
        ...CHINESE,
        "bots.count": "{count, plural, one {# 个 Bot} other {# 个 Bot}}",
      },
    ],
    [
      'does not use the approved term "Bot"',
      ENGLISH,
      { ...CHINESE, "bots.count": "{count, plural, other {# 个机器人}}" },
    ],
    [
      "alphabetical order",
      { ...ENGLISH, "aaa.first": "First" },
      { ...CHINESE, "aaa.first": "第一" },
    ],
  ];
  for (const [expected, en, zh] of cases) {
    const problems = (await problemsIn(catalogs(en, zh))).join(" ");
    expect(problems).toContain(expected);
  }
});

// The extractor reads every source file, and a busy machine can take it past the default 5 seconds.
test("the bundled catalogs are what the extractor would write for the source as it stands", async () => {
  const { anyFileUpdated, hasErrors } = await runExtractor(
    {
      ...config,
      extract: {
        ...config.extract,
        input: [join(import.meta.dir, "../src/**/*.{js,jsx,mjs,ts,tsx}")],
        output: join(import.meta.dir, "../src/i18n/locales/{{language}}.json"),
      },
    },
    { isDryRun: true, syncPrimaryWithDefaults: true, quiet: true },
  );
  expect(hasErrors).toBe(false);
  expect(anyFileUpdated).toBe(false);
}, 60_000);
