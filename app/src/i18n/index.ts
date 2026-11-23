import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next, Trans, useTranslation } from "react-i18next";

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

export { Trans, useTranslation };

export type LocalePreference = "en" | "zh-CN";

/** Applies a language choice now, and settles once the interface has redrawn for it. */
export function setLocalePreference(locale: LocalePreference) {
  return i18n.changeLanguage(locale);
}

/** Translates outside React, in the language current at the call. Never keep the result. */
export const t: typeof i18n.t = (key, options, ...rest) =>
  i18n.t(key, options, ...rest);
