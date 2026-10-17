import { expect, test } from "bun:test";
import i18next from "i18next";
// Side effect: initializes i18next, so the assertions below run against the real registration.
import "@/lib/i18n";
import { NAMESPACES } from "@/lib/i18n";
import obsAdminEn from "@/locales/en/obs-admin.json";
import obsDatasetsEn from "@/locales/en/obs-datasets.json";
import obsEvaluationsEn from "@/locales/en/obs-evaluations.json";
import obsRunsEn from "@/locales/en/obs-runs.json";
import obsAdminZh from "@/locales/zh-CN/obs-admin.json";
import obsDatasetsZh from "@/locales/zh-CN/obs-datasets.json";
import obsEvaluationsZh from "@/locales/zh-CN/obs-evaluations.json";
import obsRunsZh from "@/locales/zh-CN/obs-runs.json";

/**
 * T02 contract: the observability UI owns four bilingual namespaces (runs, datasets, evaluations,
 * admin), each carrying the eight availability states with distinct copy, so the four frontend
 * chains write their own obs-* files instead of editing shared catalogs.
 */
const OBSERVABILITY_NAMESPACES = [
  "obs-runs",
  "obs-datasets",
  "obs-evaluations",
  "obs-admin",
] as const;

type Bundle = { en: unknown; "zh-CN": unknown };

const BUNDLES: Record<(typeof OBSERVABILITY_NAMESPACES)[number], Bundle> = {
  "obs-runs": { en: obsRunsEn, "zh-CN": obsRunsZh },
  "obs-datasets": { en: obsDatasetsEn, "zh-CN": obsDatasetsZh },
  "obs-evaluations": { en: obsEvaluationsEn, "zh-CN": obsEvaluationsZh },
  "obs-admin": { en: obsAdminEn, "zh-CN": obsAdminZh },
};

const STATE_KEYS = [
  "disabled",
  "empty",
  "forbidden",
  "basic",
  "omitted",
  "truncated",
  "syncing",
  "unavailable",
] as const;

/** Flattened dot-paths of a locale bundle, so en and zh-CN can be compared key-for-key. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyPaths(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

test("registers every observability namespace for both languages", () => {
  for (const ns of OBSERVABILITY_NAMESPACES) {
    expect(NAMESPACES).toContain(ns);
    expect(i18next.hasResourceBundle("en", ns)).toBe(true);
    expect(i18next.hasResourceBundle("zh-CN", ns)).toBe(true);
  }
});

test("every observability namespace keeps en and zh-CN key-for-key identical", () => {
  for (const ns of OBSERVABILITY_NAMESPACES) {
    const en = keyPaths(BUNDLES[ns].en).sort();
    const zh = keyPaths(BUNDLES[ns]["zh-CN"]).sort();
    expect(zh).toEqual(en);
  }
});

test("every observability namespace carries all eight states with title and description", () => {
  for (const ns of OBSERVABILITY_NAMESPACES) {
    for (const language of ["en", "zh-CN"] as const) {
      const states = (
        BUNDLES[ns][language] as { states: Record<string, unknown> }
      ).states;
      expect(Object.keys(states).sort()).toEqual([...STATE_KEYS].sort());
      for (const state of STATE_KEYS) {
        const entry = states[state] as Record<string, string>;
        expect(
          entry.title.length,
          `${ns}/${language}/${state}.title`,
        ).toBeGreaterThan(0);
        expect(
          entry.description.length,
          `${ns}/${language}/${state}.description`,
        ).toBeGreaterThan(0);
      }
    }
  }
});

test("the eight states stay semantically distinct within each namespace", () => {
  for (const ns of OBSERVABILITY_NAMESPACES) {
    for (const language of ["en", "zh-CN"] as const) {
      const titles = Object.entries(
        (BUNDLES[ns][language] as { states: Record<string, { title: string }> })
          .states,
      ).map(([state, copy]) => `${state}: ${copy.title}`);
      expect(new Set(titles).size).toBe(titles.length);
    }
  }
});
