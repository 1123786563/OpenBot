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
import routines from "../../locales/en/routines.json";
import settings from "../../locales/en/settings.json";
import skills from "../../locales/en/skills.json";
import nav from "../../locales/en/nav.json";

/**
 * Translation namespaces, split by feature area so a namespace stays reviewable and can be
 * lazy-loaded per surface later. The en bundle is the source of truth for keys; other languages
 * fall back to it key-by-key, so a partial translation is never a missing string.
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
  "errors",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** Languages this build carries a bundle for. `en` is the source; everything else falls back to it. */
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const FALLBACK_LANGUAGE: Language = "en";

const enResources = {
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
  errors,
};

/*
 * Non-source languages load on demand: the static prefix keeps this a Vite-analyzable dynamic
 * import, one small JSON chunk per namespace, added to the instance once loaded. Until a bundle
 * arrives the fallback language answers, so a cold start in zh-CN renders English for a beat
 * rather than keys or blanks.
 */
const loaded = new Set<string>(["en"]);

/**
 * The bundle that carries a requested language: itself when exact, otherwise the supported
 * language sharing its base ("en-US" answers "en", "zh" answers "zh-CN"). A language with no
 * bundle at all answers undefined and nothing is loaded — the fallback language covers it.
 */
function bundleLanguage(language: string): Language | undefined {
  if (SUPPORTED_LANGUAGES.includes(language as Language)) {
    return language as Language;
  }
  const base = language.split("-")[0];
  return SUPPORTED_LANGUAGES.find(
    (supported) => supported.split("-")[0] === base,
  );
}

async function loadLanguage(language: string): Promise<void> {
  const bundle = bundleLanguage(language);
  if (!bundle || loaded.has(bundle)) return;
  const bundles = await Promise.all(
    NAMESPACES.map((ns) => import(`../../locales/${bundle}/${ns}.json`)),
  );
  for (const [i, ns] of NAMESPACES.entries()) {
    i18next.addResourceBundle(bundle, ns, bundles[i].default, true, true);
  }
  loaded.add(bundle);
}

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: enResources },
    fallbackLng: FALLBACK_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    // "zh" from the browser resolves to the zh-CN bundle rather than being refused.
    nonExplicitSupportedLngs: true,
    ns: NAMESPACES,
    defaultNS: "common",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "openbot.language",
    },
    react: { useSuspense: false },
  });

i18next.on("languageChanged", (language) => {
  void loadLanguage(language);
});

// The detector may already have settled on a non-source language before any listener existed.
void loadLanguage(i18next.language);

export default i18next;
