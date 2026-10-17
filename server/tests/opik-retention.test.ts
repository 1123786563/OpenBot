// Issue #41 / DAG T35 — retention policy resolution and expiry boundaries.
//
// The pure half of retention: which windows a deployment runs with, and when a row
// is expired under one. The database-hitting half (real deletion, query surfaces
// empty afterwards, leases, audit) lives in opik-retention.integration.test.ts.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETENTION_DATASETS_DAYS,
  DEFAULT_RETENTION_RUNS_DAYS,
  isExpired,
  resolveRetentionDefaults,
  scopeFromStoredKey,
} from "../src/ai-observability/retention";
import { resolveObservationScope, scopeKey } from "../src/ai-observability/scope";

describe("retention windows resolve from the environment with the spec defaults", () => {
  test("an unconfigured deployment keeps the spec's proposed defaults (7/30)", () => {
    expect(resolveRetentionDefaults({})).toEqual({
      runsDays: DEFAULT_RETENTION_RUNS_DAYS,
      datasetsDays: DEFAULT_RETENTION_DATASETS_DAYS,
    });
    expect(DEFAULT_RETENTION_RUNS_DAYS).toBe(7);
    expect(DEFAULT_RETENTION_DATASETS_DAYS).toBe(30);
  });

  test("both knobs are env-configurable, including zero meaning keep-forever", () => {
    expect(
      resolveRetentionDefaults({
        OPIK_RETENTION_RUNS_DAYS: "0",
        OPIK_RETENTION_DATASETS_DAYS: "400",
      }),
    ).toEqual({ runsDays: 0, datasetsDays: 400 });
  });

  test("an unparsable or out-of-range value keeps the conservative default, never a guess", () => {
    for (const bad of ["", "nope", "-1", "1.5", "999999"]) {
      expect(resolveRetentionDefaults({ OPIK_RETENTION_RUNS_DAYS: bad }).runsDays).toBe(
        DEFAULT_RETENTION_RUNS_DAYS,
      );
    }
  });
});

describe("expiry is a boundary condition with the inclusive edge", () => {
  const now = new Date("2026-10-16T12:00:00Z");

  test("a row whose window closes exactly now is expired", () => {
    expect(isExpired(new Date("2026-10-09T12:00:00Z"), 7, now)).toBe(true);
  });

  test("a row one millisecond short of its window is not", () => {
    expect(isExpired(new Date("2026-10-09T12:00:00.001Z"), 7, now)).toBe(false);
  });

  test("a zero window keeps forever: the sweep must respect the off answer", () => {
    expect(isExpired(new Date(0), 0, now)).toBe(false);
  });
});

describe("a stored scope key rebuilds the scope object for governance deletion", () => {
  test("the key a workbench scope issued parses back into an equal-key scope", () => {
    const scope = resolveObservationScope({
      actorId: "user-a",
      botId: "agent-1",
      ownership: "owner",
      epoch: 3,
    });
    const rebuilt = scopeFromStoredKey(scope.key);
    // The ownership answer does not participate in the key, so any authorized
    // spelling re-issues the same key: identity is (actor, bot, epoch).
    expect(rebuilt?.key).toBe(scope.key);
    expect(rebuilt?.actorId).toBe("user-a");
    expect(rebuilt?.botId).toBe("agent-1");
    expect(rebuilt?.epoch).toBe(3);
  });

  test("anything that is not a workbench key is refused, never guessed", () => {
    for (const bad of [
      "",
      "wb",
      "wb|user-a|agent-1|1", // missing length prefixes
      "wb|6:user-a|8:agent-1|x:1", // malformed length
      "wb|6:user-a|8:agent-1|2:12", // length disagrees with value
      "ent|6:user-a|8:agent-1|1:1", // a future kind, not this one
    ]) {
      expect(scopeFromStoredKey(bad)).toBeNull();
    }
  });
});
