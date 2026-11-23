import { useSyncExternalStore } from "react";
import i18next, { type TFunction } from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import {
  readLocalePreference,
  resolveLocale,
  writeLocalePreference,
  type LocalePreference,
} from "./locale";

/**
 * The one instance every interface string goes through. Importing it is enough to render English,
 * which is what a test that never mentions a language expects.
 */
export const i18n = i18next.createInstance();

void i18n.use(ICU).use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: {},
  initAsync: false,
});

// The document says what language it is written in, for screen readers, fonts and spell-checking.
i18n.on("languageChanged", () => {
  if (typeof document !== "undefined")
    document.documentElement.lang = i18n.language;
});

export { Trans, useTranslation } from "react-i18next";
export { I18nProvider } from "./provider";
export {
  LOCALES,
  readLocalePreference,
  resolveLocale,
  writeLocalePreference,
  type Locale,
  type LocalePreference,
} from "./locale";

/** The choice in force this visit, kept in memory so a refused storage still changes the language. */
let chosen: LocalePreference | null = null;
const chosenListeners = new Set<() => void>();

/** Speaks the language this visit opens in, before anything is drawn. Call it once, before rendering. */
export function initI18n(): void {
  void speak(readLocalePreference() ?? "browser");
}

/** Applies a language choice now, and settles once the interface has redrawn for it. */
export function setLocalePreference(preference: LocalePreference) {
  writeLocalePreference(preference);
  return speak(preference);
}

/** What is chosen now, kept up to date: "browser" until the Person picks a language. */
export function useLocalePreference(): LocalePreference | null {
  return useSyncExternalStore(subscribe, () => chosen);
}

function subscribe(listener: () => void): () => void {
  chosenListeners.add(listener);
  return () => chosenListeners.delete(listener);
}

function speak(preference: LocalePreference) {
  chosen = preference;
  for (const listener of chosenListeners) listener();
  return i18n.changeLanguage(resolveLocale(preference, browserLanguages()));
}

/** Translates outside React, in the language current at the call. Never keep the result. */
export const t: TFunction = i18n.t.bind(i18n);

/** The languages the browser asks for, most preferred first; none where there is no browser. */
function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
}

/**
 * Date, number and relative-time formatting for the interface, in the language current at the call.
 * Each call makes its own formatter, so nothing is kept past a language change.
 */
export function formatDate(
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(i18n.language, options).format(value);
}

export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(i18n.language, options).format(value);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
): string {
  return new Intl.RelativeTimeFormat(i18n.language).format(value, unit);
}
