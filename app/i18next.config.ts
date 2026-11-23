import { defineConfig } from "i18next-cli";

// Messages are ICU, one flat catalog per language, keys stored whole ("settings.language.title").
// `bun run i18n:extract` from app/ rewrites both: English comes from the defaults in the code
// (`--sync-primary` keeps them in step), and new keys start empty in the other languages for a
// person to translate. The static check in tests/i18n-catalogs.test.ts fails until it is run.
export default defineConfig({
  locales: ["en", "zh-CN"],
  extract: {
    input: ["src/**/*.{js,jsx,mjs,ts,tsx}"],
    output: "src/i18n/locales/{{language}}.json",
    defaultNS: false,
    keySeparator: false,
    messageFormat: "icu",
    // Plain UTF-16 code-unit order, the same order the catalog check asserts.
    sort: "locize",
  },
});
