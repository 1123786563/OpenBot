import { describe, expect, test } from "bun:test";
import enAdmin from "../../locales/en/ai-observability-admin.json";
import enDatasets from "../../locales/en/ai-observability-datasets.json";
import enEvaluations from "../../locales/en/ai-observability-evaluations.json";
import enRuns from "../../locales/en/ai-observability-runs.json";
import zhAdmin from "../../locales/zh-CN/ai-observability-admin.json";
import zhDatasets from "../../locales/zh-CN/ai-observability-datasets.json";
import zhEvaluations from "../../locales/zh-CN/ai-observability-evaluations.json";
import zhRuns from "../../locales/zh-CN/ai-observability-runs.json";
import { NAMESPACES } from "./index";

/**
 * The eight states the parent Spec requires the UI to distinguish. They are asserted as a set
 * here so a later ticket cannot quietly drop one, or reuse `empty` for `omitted` — the Spec's
 * point is that "no data", "withheld on purpose" and "the store did not answer" are three
 * different facts about the product.
 */
const STATES = [
  "disabled",
  "empty",
  "forbidden",
  "basic",
  "omitted",
  "truncated",
  "syncing",
  "unavailable",
] as const;

const BUNDLES = [
  { ns: "ai-observability-runs", en: enRuns, zh: zhRuns },
  { ns: "ai-observability-datasets", en: enDatasets, zh: zhDatasets },
  { ns: "ai-observability-evaluations", en: enEvaluations, zh: zhEvaluations },
  { ns: "ai-observability-admin", en: enAdmin, zh: zhAdmin },
] as const;

/**
 * The bundles whose placeholder routes exist today, named separately so TypeScript keeps each
 * entry its own bundle type. The datasets chain (#27) builds its section inside the evaluations
 * page, so it has no route — and no placeholder copy — yet.
 */
const PLACEHOLDER_BUNDLES = [
  { ns: "ai-observability-runs", en: enRuns, zh: zhRuns },
  { ns: "ai-observability-evaluations", en: enEvaluations, zh: zhEvaluations },
  { ns: "ai-observability-admin", en: enAdmin, zh: zhAdmin },
] as const;

function flatKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => flatKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("observation i18n sub-namespaces", () => {
  test("all four are registered, so a lazy fallback chain cannot strand them in English", () => {
    for (const { ns } of BUNDLES) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  test("each bundle declares which ticket chain owns it", () => {
    for (const { ns, en } of BUNDLES) {
      expect(en.meta.namespace).toBe(ns);
      expect(en.meta.ownedBy.length).toBeGreaterThan(0);
    }
  });

  test("every bundle carries all eight availability states", () => {
    for (const { ns, en, zh } of BUNDLES) {
      expect(Object.keys(en.availability).sort()).toEqual([...STATES].sort());
      expect(Object.keys(zh.availability).sort()).toEqual([...STATES].sort());
      for (const state of STATES) {
        expect(
          en.availability[state].title.trim().length,
          `${ns}/${state} en title`,
        ).toBeGreaterThan(0);
        expect(
          zh.availability[state].title.trim().length,
          `${ns}/${state} zh title`,
        ).toBeGreaterThan(0);
        expect(
          en.availability[state].description.trim().length,
          `${ns}/${state} en description`,
        ).toBeGreaterThan(0);
        expect(
          zh.availability[state].description.trim().length,
          `${ns}/${state} zh description`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("every routed namespace carries non-empty placeholder copy in both languages", () => {
    for (const { ns, en, zh } of PLACEHOLDER_BUNDLES) {
      expect(
        en.placeholder.title.trim().length,
        `${ns} en title`,
      ).toBeGreaterThan(0);
      expect(
        zh.placeholder.title.trim().length,
        `${ns} zh title`,
      ).toBeGreaterThan(0);
      expect(
        en.placeholder.description.trim().length,
        `${ns} en description`,
      ).toBeGreaterThan(0);
      expect(
        zh.placeholder.description.trim().length,
        `${ns} zh description`,
      ).toBeGreaterThan(0);
    }
  });

  test("en and zh-CN key sets are identical per namespace", () => {
    for (const { ns, en, zh } of BUNDLES) {
      expect(flatKeys(zh).sort(), `${ns} key parity`).toEqual(
        flatKeys(en).sort(),
      );
    }
  });

  test("the eight states are not copy-paste collisions within a namespace", () => {
    for (const { ns, en } of BUNDLES) {
      const titles = STATES.map((state) => en.availability[state].title);
      expect(new Set(titles).size, `${ns} titles must be distinct`).toBe(
        STATES.length,
      );
    }
  });

  test("omitted, empty and unavailable stay three different facts", () => {
    for (const { ns, en } of BUNDLES) {
      const { empty, omitted, unavailable, syncing } = en.availability;
      expect(omitted.title).not.toBe(empty.title);
      expect(unavailable.title).not.toBe(empty.title);
      expect(syncing.title).not.toBe(unavailable.title);
      expect(omitted.description).not.toBe(unavailable.description);
      expect(ns.length).toBeGreaterThan(0);
    }
  });
});
