import { describe, expect, test } from "bun:test";
import {
  evaluationToolClassifier,
  judgeAdmissionFromEnv,
} from "../src/ai-observability/execution-boot";

/**
 * The production experiment execution assembly's own units (T-routes closure ticket):
 * the judge admission list is deployment configuration loaded from env, and it fails
 * closed — a malformed list is an inert judge, never a half-approved one; the approved
 * scorer versions default to exactly the version this build implements; and the
 * production tool classifier refuses every call, because nothing in this assembly can
 * attest a name is a read (the catalogue-backed wiring stays the T24-named leftover).
 */

describe("judgeAdmissionFromEnv", () => {
  test("a valid entrance object loads the approved list verbatim", () => {
    const { entrances, approvedVersions } = judgeAdmissionFromEnv({
      OPIK_JUDGE_ENTRANCES: JSON.stringify({
        "judge-main": {
          modelName: "judge-model",
          apiKeyEnv: "JUDGE_MAIN_API_KEY",
          baseURL: "http://gateway.internal/v1",
        },
        "judge-fallback": { modelName: "other-model" },
      }),
    });
    expect(entrances.get("judge-main")).toEqual({
      modelName: "judge-model",
      apiKeyEnv: "JUDGE_MAIN_API_KEY",
      baseURL: "http://gateway.internal/v1",
    });
    expect(entrances.get("judge-fallback")).toEqual({
      modelName: "other-model",
    });
    expect(entrances.size).toBe(2);
    expect(approvedVersions).toEqual(new Set(["judge/1"]));
  });

  test("an absent list is an inert judge — no entrances, no guessing", () => {
    const { entrances, approvedVersions } = judgeAdmissionFromEnv({});
    expect(entrances.size).toBe(0);
    expect(approvedVersions).toEqual(new Set(["judge/1"]));
  });

  test("a malformed list answers empty and stays silent rather than half-approving", () => {
    for (const raw of [
      "not json",
      '["an array, not an object"]',
      JSON.stringify({ broken: { rubric: "no model name" } }),
      JSON.stringify({ broken: "not an object" }),
      "42",
    ]) {
      const { entrances } = judgeAdmissionFromEnv({
        OPIK_JUDGE_ENTRANCES: raw,
      });
      expect(entrances.size).toBe(0);
    }
  });

  test("an invalid entry is skipped, its valid siblings still load", () => {
    const { entrances } = judgeAdmissionFromEnv({
      OPIK_JUDGE_ENTRANCES: JSON.stringify({
        good: { modelName: "judge-model" },
        bad: { modelName: 42 },
      }),
    });
    expect([...entrances.keys()]).toEqual(["good"]);
  });

  test("the approved scorer versions come from env, comma-separated", () => {
    const { approvedVersions } = judgeAdmissionFromEnv({
      OPIK_JUDGE_APPROVED_VERSIONS: " judge/1 , judge/0 ",
    });
    expect(approvedVersions).toEqual(new Set(["judge/1", "judge/0"]));
    const empty = judgeAdmissionFromEnv({
      OPIK_JUDGE_APPROVED_VERSIONS: " , ",
    });
    expect(empty.approvedVersions).toEqual(new Set(["judge/1"]));
  });
});

describe("evaluationToolClassifier", () => {
  test("the production answer is fail-closed write for every name", () => {
    // Nothing in this assembly can attest an evaluation tool name is a read: the
    // catalogue-backed wiring stays the T24-named leftover, and until it lands the
    // gate's second key refuses — the whitelist may narrow, never widen.
    expect(evaluationToolClassifier("search")).toBe("write");
    expect(evaluationToolClassifier("kb_search")).toBe("write");
    expect(evaluationToolClassifier("")).toBe("write");
  });
});
