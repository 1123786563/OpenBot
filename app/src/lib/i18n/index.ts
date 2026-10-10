import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import approvals from "../../locales/en/approvals.json";
import admin from "../../locales/en/admin.json";
import agents from "../../locales/en/agents.json";
import channels from "../../locales/en/channels.json";
import common from "../../locales/en/common.json";
import computer from "../../locales/en/computer.json";
import errors from "../../locales/en/errors.json";
import market from "../../locales/en/market.json";
import routines from "../../locales/en/routines.json";
import settings from "../../locales/en/settings.json";
import skills from "../../locales/en/skills.json";
import nav from "../../locales/en/nav.json";
import tenant from "../../locales/en/tenant.json";
import workshop from "../../locales/en/workshop.json";
import zhApprovals from "../../locales/zh-CN/approvals.json";
import zhAdmin from "../../locales/zh-CN/admin.json";
import zhAgents from "../../locales/zh-CN/agents.json";
import zhChannels from "../../locales/zh-CN/channels.json";
import zhCommon from "../../locales/zh-CN/common.json";
import zhComputer from "../../locales/zh-CN/computer.json";
import zhErrors from "../../locales/zh-CN/errors.json";
import zhMarket from "../../locales/zh-CN/market.json";
import zhRoutines from "../../locales/zh-CN/routines.json";
import zhSettings from "../../locales/zh-CN/settings.json";
import zhSkills from "../../locales/zh-CN/skills.json";
import zhNav from "../../locales/zh-CN/nav.json";
import zhTenant from "../../locales/zh-CN/tenant.json";
import zhWorkshop from "../../locales/zh-CN/workshop.json";

/**
 * Translation namespaces, split by feature area so a namespace stays reviewable and can be
 * split into lazy chunks later if the catalog grows. The en bundle is the source of truth for
 * keys; other languages fall back to it key-by-key, so a partial translation is never a missing
 * string.
 */
export const NAMESPACES = [
  "common",
  "nav",
  "channels",
  "agents",
  "computer",
  "settings",
  "admin",
  "approvals",
  "routines",
  "skills",
  "market",
  "errors",
  "tenant",
  "workshop",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** Languages this build carries a bundle for. `en` is the source; everything else falls back to it. */
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const FALLBACK_LANGUAGE: Language = "en";

/**
 * Maps a detected language code onto the bundle this build carries: exact match wins, otherwise
 * the supported language sharing its base ("en-US" answers "en", "zh" answers "zh-CN"), and
 * anything unmatched keeps its base so it falls through to the fallback language.
 *
 * Replaces `nonExplicitSupportedLngs`, which in i18next 26 breaks resolution for the explicit
 * language itself — with it set, `changeLanguage("zh-CN")` against `supportedLngs` resolves the
 * whole chain to the fallback and every translation reads English.
 */
export function normalizeDetectedLanguage(detected: string): string {
  if (SUPPORTED_LANGUAGES.includes(detected as Language)) return detected;
  const base = detected.split("-")[0];
  return (
    SUPPORTED_LANGUAGES.find(
      (supported) => supported.split("-")[0] === base,
    ) ?? base
  );
}

/**
 * Every language bundle is imported statically, on purpose.
 *
 * A lazy loader loses a race it cannot win: `changeLanguage` resolves the new language against
 * the resources that exist AT THAT MOMENT, locks the fallback chain to en when the bundle is not
 * there yet, and neither `addResourceBundle` nor a repeated `changeLanguage` to the same language
 * ever recomputes it — the interface stays in English whatever the events say. Bundled up front,
 * detection on a cold start and a switch from Settings both resolve against resources that are
 * already present, and react-i18next re-renders on the languageChanged event as usual.
 */
void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common,
        nav,
        channels,
        agents,
        computer,
        settings,
        admin,
        approvals,
        routines,
        skills,
        market,
        workshop,
        errors,
        tenant,
      },
      "zh-CN": {
        common: zhCommon,
        nav: zhNav,
        channels: zhChannels,
        agents: zhAgents,
        computer: zhComputer,
        settings: zhSettings,
        admin: zhAdmin,
        approvals: zhApprovals,
        routines: zhRoutines,
        skills: zhSkills,
        market: zhMarket,
        workshop: zhWorkshop,
        errors: zhErrors,
        tenant: zhTenant,
      },
    },
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    ns: NAMESPACES,
    defaultNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "openbot.language",
      convertDetectedLanguage: normalizeDetectedLanguage,
    },
    react: { useSuspense: false },
  });

export default i18next;
