import { describe, expect, test } from "bun:test";
import {
  createJudgeEntranceCall,
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

describe("the judge entrance dispatch (OCR R4-23)", () => {
  /** Two approved entrances sharing one model name, each with its own credential. */
  const sharedName = () =>
    new Map([
      [
        "judge-a",
        { modelName: "shared-model", apiKeyEnv: "R423_KEY_A_DEFINITELY_UNSET" },
      ],
      [
        "judge-b",
        { modelName: "shared-model", apiKeyEnv: "R423_KEY_B_DEFINITELY_UNSET" },
      ],
    ]);
  const request = {
    modelName: "shared-model",
    modelParameters: {},
    system: "s",
    user: "u",
  };
  const dialed = (call: unknown, entranceId?: string) =>
    (call as (r: typeof request & { entranceId?: string }) => Promise<unknown>)(
      { ...request, ...(entranceId === undefined ? {} : { entranceId }) },
    ).then(
      () => "dialed",
      (error: unknown) => String(error),
    );

  test("a request is dialed through the entrance it names, never the first entrance that loaded its model name", async () => {
    const call = createJudgeEntranceCall(sharedName());

    // The spec names entrance-b: entrance-b's credential environment is the one that
    // answers — provenance recorded on the judge record matches the entrance dialed.
    expect(await dialed(call, "judge-b")).toContain(
      "R423_KEY_B_DEFINITELY_UNSET",
    );
    expect(await dialed(call, "judge-a")).toContain(
      "R423_KEY_A_DEFINITELY_UNSET",
    );
  });

  test("a request without an entrance id keeps the legacy modelName dispatch (map order)", async () => {
    const call = createJudgeEntranceCall(sharedName());

    expect(await dialed(call)).toContain("R423_KEY_A_DEFINITELY_UNSET");
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
