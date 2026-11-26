export const LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

/** What a Person chose in Settings: follow the browser, or one language for good. */
export type LocalePreference = "browser" | Locale;

const LOCALE_STORAGE_KEY = "openbot-locale";

/** The language the interface opens in, from a choice (or none) and the browser's languages in order. */
export function resolveLocale(
  preference: LocalePreference | null,
  browserLanguages: readonly string[],
): Locale {
  if (preference && preference !== "browser") return preference;
  for (const tag of browserLanguages) {
    const locale = localeFor(tag);
    if (locale) return locale;
  }
  return "en";
}

/** The interface language for one browser language tag, or null when OpenBot does not speak it. */
function localeFor(tag: string): Locale | null {
  const [language, ...subtags] = tag.trim().toLowerCase().split("-");
  if (language === "en") return "en";
  if (language !== "zh") return null;
  // An extension (-u-nu-hanidec, -x-…) says nothing about the script: drop it and all that follows.
  const extension = subtags.findIndex((subtag) => subtag.length === 1);
  const [first = "", ...rest] =
    extension === -1 ? subtags : subtags.slice(0, extension);
  const scripts = [first, ...rest].filter((subtag) => subtag.length === 4);
  // Chinese is ours only where the tag says Simplified: the Hans script (zh-Hans-CN), or else the China
  // region where no script is named (zh-CN). Bare zh, zh-SG, zh-Hant, zh-TW and zh-HK are not.
  if (scripts.length > 0)
    return scripts.length === 1 && scripts[0] === "hans" ? "zh-CN" : null;
  return first === "cn" ? "zh-CN" : null;
}

/** The choice this browser kept, or null when there is none, it cannot be read, or it is not a choice. */
export function readLocalePreference(): LocalePreference | null {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
  return isPreference(stored) ? stored : null;
}

/** Whether `value` is a language choice, as opposed to nothing or something this browser never wrote. */
export function isPreference(value: string | null): value is LocalePreference {
  return value === "browser" || LOCALES.some((locale) => locale === value);
}

/** Keeps the choice in this browser. A browser that refuses it still obeys the choice for this visit. */
export function writeLocalePreference(preference: LocalePreference): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, preference);
  } catch {
    // Private mode or a full store: the choice holds for this visit only.
  }
}
