import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { withStorage } from "./i18n";
import {
  readLocalePreference,
  resolveLocale,
  writeLocalePreference,
} from "@/i18n";

/**
 * Which language the interface opens in. The rules are deliberately narrow: two languages exist,
 * and only Simplified Chinese is one of them.
 */

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => localStorage.clear());

test("a language chosen in Settings wins over what the browser asks for", () => {
  expect(resolveLocale("zh-CN", ["fr-FR", "en-US"])).toBe("zh-CN");
  expect(resolveLocale("en", ["zh-CN"])).toBe("en");
});

test("with no choice made, the first browser language OpenBot speaks wins", () => {
  expect(resolveLocale("browser", ["fr-FR", "zh-CN", "en-GB"])).toBe("zh-CN");
  expect(resolveLocale(null, ["fr-FR", "en-GB"])).toBe("en");
});

test("Traditional Chinese is never shown as Simplified", () => {
  for (const tag of [
    "zh-TW",
    "zh-HK",
    "zh-MO",
    "zh-Hant",
    "zh-Hant-TW",
    "zh-Hant-HK",
    "zh-Hant-CN",
    "zh-yue-Hant-HK",
  ]) {
    expect(resolveLocale("browser", [tag, "fr-FR"])).toBe("en");
  }
  expect(resolveLocale("browser", ["zh-TW", "zh-CN", "en-US"])).toBe("zh-CN");
});

test("Simplified Chinese is recognised in each way a browser spells it", () => {
  for (const tag of [
    "zh-Hans",
    "zh-CN",
    "zh-Hans-CN",
    "zh-Hans-SG",
    "zh-cmn-Hans-CN",
    "ZH-cn",
    "zh-Hans-u-nu-hanidec",
    "zh-CN-x-foo",
  ]) {
    expect(resolveLocale("browser", [tag])).toBe("zh-CN");
  }
});

test("Chinese is taken as ours only where the tag itself says Simplified", () => {
  for (const tag of ["zh", "zh-SG", "zh-Hans-Hant", "zh-Latn-CN"]) {
    expect(resolveLocale("browser", [tag, "fr-FR"])).toBe("en");
  }
});

test("a language OpenBot does not speak, or none at all, leaves the interface in English", () => {
  expect(resolveLocale("browser", ["fr-FR", "de-DE", "ja"])).toBe("en");
  expect(resolveLocale("browser", ["en-AU", "zh-CN"])).toBe("en");
  expect(resolveLocale("browser", [])).toBe("en");
  expect(resolveLocale(null, ["  "])).toBe("en");
});

test("a choice made in Settings is kept by this browser", () => {
  expect(readLocalePreference()).toBeNull();

  writeLocalePreference("zh-CN");
  expect(readLocalePreference()).toBe("zh-CN");

  writeLocalePreference("browser");
  expect(readLocalePreference()).toBe("browser");
});

test("a stored value that is not a language choice reads as no choice made", () => {
  localStorage.setItem("openbot-locale", "klingon");

  expect(readLocalePreference()).toBeNull();
});

test("a browser that will not open its storage neither breaks nor remembers", async () => {
  const refused = (): never => {
    throw new DOMException(
      "Access is denied for this document.",
      "SecurityError",
    );
  };
  await withStorage({ getItem: refused, setItem: refused }, () => {
    expect(readLocalePreference()).toBeNull();
    expect(() => writeLocalePreference("zh-CN")).not.toThrow();
  });

  expect(readLocalePreference()).toBeNull();
});

test("a store with no room left keeps nothing, and nothing breaks", async () => {
  const full = (): never => {
    throw new DOMException(
      "The quota has been exceeded.",
      "QuotaExceededError",
    );
  };
  await withStorage({ getItem: () => null, setItem: full }, () => {
    expect(() => writeLocalePreference("zh-CN")).not.toThrow();
    expect(readLocalePreference()).toBeNull();
  });
});
