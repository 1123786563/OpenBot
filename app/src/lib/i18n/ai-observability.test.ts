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

/**
 * Two deliberate per-namespace deviations:
 * - evaluations' fourth slot is `unscored` — the sample produced no score (Spec §8), and a
 *   missing score is not a zero. `basic` keeps its capability meaning ("only what OpenBot
 *   itself observed") in every namespace that has it, so the word is never overloaded.
 * - runs additionally carries `tokenUnavailable` (Spec §9 "token 不可用"): usage that could
 *   not be read must not be reported as 0.
 */
const STATES_BY_NS: Record<string, readonly string[]> = {
  "ai-observability-runs": [...STATES, "tokenUnavailable"],
  "ai-observability-datasets": STATES,
  "ai-observability-evaluations": [
    ...STATES.filter((state) => state !== "basic"),
    "unscored",
  ],
  "ai-observability-admin": STATES,
};

type Availability = Record<string, { title: string; description: string }>;

const BUNDLES = [
  { ns: "ai-observability-runs", en: enRuns, zh: zhRuns },
  { ns: "ai-observability-datasets", en: enDatasets, zh: zhDatasets },
  { ns: "ai-observability-evaluations", en: enEvaluations, zh: zhEvaluations },
  { ns: "ai-observability-admin", en: enAdmin, zh: zhAdmin },
] as const;

/**
 * The bundles whose placeholder routes exist today, named separately so TypeScript keeps each
 * entry its own bundle type. The datasets chain (#27) renders its real section at the
 * evaluations route and never carried placeholder copy; the evaluations bundle's placeholder
 * copy stays reserved for the experiment chains (#36 #37) that land beside it.
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

  test("every bundle carries its full availability state set", () => {
    for (const { ns, en, zh } of BUNDLES) {
      const states = STATES_BY_NS[ns];
      expect(Object.keys(en.availability).sort()).toEqual([...states].sort());
      expect(Object.keys(zh.availability).sort()).toEqual([...states].sort());
      const enAvailability = en.availability as Availability;
      const zhAvailability = zh.availability as Availability;
      for (const state of states) {
        expect(
          enAvailability[state].title.trim().length,
          `${ns}/${state} en title`,
        ).toBeGreaterThan(0);
        expect(
          zhAvailability[state].title.trim().length,
          `${ns}/${state} zh title`,
        ).toBeGreaterThan(0);
        expect(
          enAvailability[state].description.trim().length,
          `${ns}/${state} en description`,
        ).toBeGreaterThan(0);
        expect(
          zhAvailability[state].description.trim().length,
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

  test("the availability states are not copy-paste collisions within a namespace", () => {
    for (const { ns, en } of BUNDLES) {
      const availability = en.availability as Availability;
      const titles = STATES_BY_NS[ns].map((state) => availability[state].title);
      expect(new Set(titles).size, `${ns} titles must be distinct`).toBe(
        titles.length,
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
