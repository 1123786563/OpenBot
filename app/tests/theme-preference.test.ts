import "./preload";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "../../tests/support/e2e-compat";
import {
  applyDarkTheme,
  parseStoredDarkTheme,
  THEME_STORAGE_KEY,
} from "../src/lib/theme";

describe("theme preference", () => {
  test("only the stored dark value enables dark theme", () => {
    expect(parseStoredDarkTheme("dark")).toBe(true);
    expect(parseStoredDarkTheme("light")).toBe(false);
    expect(parseStoredDarkTheme(null)).toBe(false);
  });

  test("persists and applies the selected theme", () => {
    const writes: Array<[string, string]> = [];
    const toggles: Array<[string, boolean]> = [];
    const schemes: Array<string> = [];
    const themes: Array<string> = [];

    const run = (dark: boolean) => {
      writes.length = 0;
      toggles.length = 0;
      schemes.length = 0;
      themes.length = 0;
      applyDarkTheme(dark, {
        setStoredValue: (key, value) => writes.push([key, value]),
        toggleRootClass: (name, force) => toggles.push([name, force]),
        setRootColorScheme: (scheme) => schemes.push(scheme),
        setRootTheme: (theme) => themes.push(theme),
      });
    };

    run(true);
    expect(writes).toEqual([[THEME_STORAGE_KEY, "dark"]]);
    expect(toggles).toEqual([["dark", true]]);
    expect(schemes).toEqual(["dark"]);
    // `data-theme` is written from the same boolean as the class — one state, two expressions.
    expect(themes).toEqual(["dark"]);

    run(false);
    expect(writes).toEqual([[THEME_STORAGE_KEY, "light"]]);
    expect(toggles).toEqual([["dark", false]]);
    expect(schemes).toEqual(["light"]);
    expect(themes).toEqual(["light"]);
  });
});

describe("pre-paint theme boot", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  test("the boot script reads the same storage key the app writes", () => {
    expect(html).toContain(THEME_STORAGE_KEY);
  });

  test("the boot script runs before the first paint", () => {
    const boot = html.match(/<script(?![^>]*\bsrc=)[^>]*>/);

    expect(boot).not.toBeNull();
    expect(boot?.[0]).not.toContain("module");
    expect(boot?.[0]).not.toContain("defer");
  });

  test("the boot script applies the dark class itself", () => {
    expect(html).toContain("documentElement");
    expect(html).toMatch(/classList[\s\S]*dark/);
  });

  test("the boot script writes the data-theme attribute HeroUI's selectors read", () => {
    /*
     * Same `dark` boolean as the class toggle one line above it: `[data-theme]` must never drift
     * from `.dark`, or HeroUI's own dark selectors would disagree with OpenBot's.
     */
    expect(html).toMatch(
      /dataset\.theme\s*=\s*dark\s*\?\s*"dark"\s*:\s*"light"/,
    );
  });

  test("the document declares a color scheme before the stylesheet arrives", () => {
    expect(html).toContain("colorScheme");
  });
});

describe("color scheme", () => {
  const styles = readFileSync(
    new URL("../src/styles.css", import.meta.url),
    "utf8",
  );

  test("both themes tell the browser which one they are", () => {
    expect(styles).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light/);
    /*
     * The dark selector is grouped with HeroUI's `[data-theme="dark"]` alias because both are
     * written from the same boolean. The class itself must still be in the selector list.
     */
    expect(styles).toMatch(
      /(?:\.dark\s*,|\.dark\s*\{)[\s\S]*?color-scheme:\s*dark/,
    );
  });
});
