import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import {
  countExperimentCanaryFindings,
  createExperimentSubmitService,
  createObservationExperimentStore,
  ExperimentStoreError,
  experimentConfigHash,
  freezeExperimentConfig,
  MAX_EXPERIMENT_NAME_BYTES,
} from "../src/ai-observability/experiments";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { AuditEventInput } from "../src/audit";
import type { Database } from "../src/db/client";
import { aiObservationExperiments } from "../src/db/schema/ai-observability-experiments";

/**
 * Unit contract of the experiment configuration freeze (Issue #28 / DAG T22): fail-closed scope
 * handling, input refusal, the freeze pipeline that projects configuration before it is ever
 * hashed or stored, the hash discipline that makes "submit the same configuration again" the
 * same experiment, and the audit row the submit action leaves behind. The behavioral proofs
 * (immutability at the database, idempotent replays, scope isolation, the guarded state
 * machine, the delete trigger) live in opik-experiments.integration.test.ts against a
 * dedicated database.
 */

const trusted = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

/** A store that must never reach its database: every assertion here refuses before any query. */
const store = createObservationExperimentStore({} as Database);

const config = {
  botConfig: { toolChoice: "auto" },
  prompt: "Answer the support question from the outage report.",
  modelName: "claude-sonnet-5",
  modelParameters: { temperature: 0, maxTokens: 1024 },
  toolFixtures: { search: { query: "outage", results: 0 } },
  judgeConfig: { type: "llm-judge", threshold: 0.8 },
  judgeVersion: "judge/1",
};

const input = {
  name: "outage-eval",
  datasetVersionId: "version-1",
  config,
};

describe("the experiment store refuses what is not a trusted scope", () => {
  test("a spread copy of a real scope is forged, not trusted", () => {
    const forged = { ...trusted };

    expect(() => store.saveDraft(forged, input)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(() => store.submit(forged, input)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(() => store.getExperiment(forged, "experiment-id")).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
  });
});

describe("the experiment store validates its own inputs", () => {
  test("refuses an empty or blank experiment name", () => {
    for (const name of ["", " "]) {
      expect(() => store.saveDraft(trusted, { ...input, name })).toThrow(
        new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400),
      );
      expect(() => store.submit(trusted, { ...input, name })).toThrow(
        new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400),
      );
    }
  });

  test("refuses an experiment name longer than 128 bytes", () => {
    expect(() =>
      store.submit(trusted, { ...input, name: "n".repeat(129) }),
    ).toThrow(new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400));
    expect(MAX_EXPERIMENT_NAME_BYTES).toBe(128);
  });

  test("refuses a credential-shaped name before anything is stored (OCR h5)", () => {
    // The id-links precedent: a name that matches a credential class is a refusal,
    // not a projection — the row is frozen forever (no UPDATE), the audit trail is
    // append-only forever, and the name rides both. Deny at the one entry.
    for (const name of [
      "sk-live-abcdefghijklmnopqrst",
      "AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
      "postgres://user:hunter2@host/db",
    ]) {
      expect(() => store.submit(trusted, { ...input, name })).toThrow(
        new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400),
      );
      expect(() => store.saveDraft(trusted, { ...input, name })).toThrow(
        new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400),
      );
    }
  });

  test("refuses a blank dataset version id before any query", () => {
    expect(() =>
      store.submit(trusted, { ...input, datasetVersionId: "" }),
    ).toThrow(new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400));
  });

  test("refuses a configuration without its text anchors or with array-shaped records", () => {
    for (const bad of [
      { ...config, prompt: "" },
      { ...config, modelName: " " },
      { ...config, judgeVersion: "" },
      { ...config, botConfig: [] as unknown as Record<string, unknown> },
      {
        ...config,
        modelParameters: null as unknown as Record<string, unknown>,
      },
      { ...config, toolFixtures: "none" as unknown as Record<string, unknown> },
      { ...config, judgeConfig: [] as unknown as Record<string, unknown> },
    ]) {
      expect(() => store.submit(trusted, { ...input, config: bad })).toThrow(
        new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400),
      );
    }
  });

  test("refuses references that are not non-empty strings before any query", () => {
    expect(() => store.getExperiment(trusted, "")).toThrow(
      new ExperimentStoreError("EXPERIMENT_INPUT_INVALID", 400),
    );
  });
});

describe("the freeze pipeline projects configuration before it is hashed", () => {
  test("every field is projected into its safe form", () => {
    const frozen = freezeExperimentConfig(config);
    expect(frozen.prompt).toEqual({
      state: "projected",
      text: config.prompt,
    });
    expect(frozen.modelName).toEqual({
      state: "projected",
      text: config.modelName,
    });
    expect(frozen.judgeVersion).toEqual({
      state: "projected",
      text: config.judgeVersion,
    });
    expect(frozen.judgeConfig).toEqual({
      state: "projected",
      value: {
        type: { state: "projected", value: "llm-judge" },
        threshold: { state: "projected", value: 0.8 },
      },
    });
    expect(frozen.toolFixtures).toEqual({
      state: "projected",
      value: {
        search: {
          state: "projected",
          value: {
            query: { state: "projected", value: "outage" },
            results: { state: "projected", value: 0 },
          },
        },
      },
    });
  });

  test("a credential in any corner is refused, not echoed — the canary counts every one", () => {
    const frozen = freezeExperimentConfig({
      ...config,
      prompt: "sk-live-abc123def456ghi789jkl012 is not a prompt",
      modelName: "postgres://u:p@h/db",
      judgeConfig: { threshold: 0.8, apiKey: "Bearer abcdefghijklmnop" },
      toolFixtures: {
        search: { query: "outage", token: "Bearer abcdefghijklmnop" },
      },
    });
    expect(frozen.prompt).toEqual({ state: "omitted", reason: "credential" });
    expect(frozen.modelName.state).toBe("omitted");
    expect(
      (
        (frozen.judgeConfig as { value: Record<string, unknown> }).value
          .apiKey as { state: string }
      ).state,
    ).toBe("omitted");
    expect(countExperimentCanaryFindings(frozen)).toBe(4);
    // A clean configuration counts zero findings.
    expect(countExperimentCanaryFindings(freezeExperimentConfig(config))).toBe(
      0,
    );
  });

  test("a refused readOnlyTools name narrows the evaluation and is counted (OCR m136)", () => {
    // The whitelist name matches a credential class: projectSafeName drops it to
    // omitted, silently narrowing what the evaluation may call — exactly what the
    // canary count exists to surface.
    const frozen = freezeExperimentConfig({
      ...config,
      readOnlyTools: ["web_search", "sk-live-abc123def456ghi789jkl012"],
    });
    expect(frozen.readOnlyTools).toHaveLength(2);
    const refused = frozen.readOnlyTools.filter((one) => one.state === "omitted");
    expect(refused).toHaveLength(1);
    expect(countExperimentCanaryFindings(frozen)).toBe(1);
  });
});

describe("the configuration hash is stable, canonical and policy-bound", () => {
  const frozen = freezeExperimentConfig(config);

  test("is sha-256 hex and identical across key orders", () => {
    const hash = experimentConfigHash(
      "version-1",
      frozen,
      REDACTION_POLICY_VERSION,
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Same content, different key insertion order — including inside the projected records,
    // where canonical JSON is what makes the order irrelevant.
    const reordered = freezeExperimentConfig({
      judgeVersion: config.judgeVersion,
      judgeConfig: { threshold: 0.8, type: "llm-judge" },
      toolFixtures: { search: { results: 0, query: "outage" } },
      modelParameters: { maxTokens: 1024, temperature: 0 },
      modelName: config.modelName,
      prompt: config.prompt,
      botConfig: { toolChoice: "auto" },
    });
    expect(
      experimentConfigHash("version-1", reordered, REDACTION_POLICY_VERSION),
    ).toBe(hash);
  });

  test("the dataset version participates: another version is another experiment", () => {
    expect(
      experimentConfigHash("version-2", frozen, REDACTION_POLICY_VERSION),
    ).not.toBe(
      experimentConfigHash("version-1", frozen, REDACTION_POLICY_VERSION),
    );
  });

  test("the redaction policy version participates: a policy bump is a different experiment", () => {
    expect(
      experimentConfigHash("version-1", frozen, "opik-redaction/6"),
    ).not.toBe(
      experimentConfigHash("version-1", frozen, REDACTION_POLICY_VERSION),
    );
  });

  test("different configuration is a different experiment", () => {
    const other = freezeExperimentConfig({
      ...config,
      judgeConfig: { type: "llm-judge", threshold: 0.9 },
    });
    expect(
      experimentConfigHash("version-1", other, REDACTION_POLICY_VERSION),
    ).not.toBe(
      experimentConfigHash("version-1", frozen, REDACTION_POLICY_VERSION),
    );
  });

  test("golden hash: the algorithm is pinned, not merely self-consistent", () => {
    // Computed once and frozen here so a future refactor cannot silently rehash every
    // submitted experiment into "new" ones. If this breaks on purpose, the policy/migration
    // story must say so loudly — bumping the algorithm re-keys every experiment.
    //
    // Re-keyed ON PURPOSE by Issue #29 / T23: the frozen configuration gained the
    // `readOnlyTools` field (an empty list here), so every configuration hashes differently
    // than the T22 golden `77d39ab5...`. Opik is pre-production; no frozen row predates
    // the field. The new golden pins the shape that carries the whitelist.
    expect(
      experimentConfigHash("version-1", frozen, REDACTION_POLICY_VERSION),
    ).toBe("444df837fa18ca89265c35224acbf58d107b197ca01e1709af3d95423a1d8967");
  });
});

describe("the experiment table holds frozen configuration and keys, not secrets", () => {
  test("no column names a credential, secret or contact surface", () => {
    // The configuration envelope is one projected jsonb; what must never exist anywhere is a
    // column that sounds like a credential, secret or contact channel.
    const forbidden =
      /credential|secret|password|token|email|attachment|url|api_key/i;
    for (const column of getTableConfig(aiObservationExperiments).columns) {
      expect(column.name).not.toMatch(forbidden);
    }
  });

  test("subject identity and frozen idempotency are database keys", () => {
    const unique = getTableConfig(aiObservationExperiments).indexes.filter(
      (index) => index.config.unique,
    );
    const byName = unique.find(
      (index) =>
        index.config.name === "ai_observation_experiments_scope_name_uq",
    );
    const byHash = unique.find(
      (index) =>
        index.config.name ===
        "ai_observation_experiments_scope_config_hash_frozen_uq",
    );
    expect(byName?.config.columns.map((column) => column.name)).toEqual([
      "scope_key",
      "name",
    ]);
    // The idempotency key covers frozen rows only: drafts carry an empty hash while their
    // configuration is still being composed.
    expect(byHash?.config.columns.map((column) => column.name)).toEqual([
      "scope_key",
      "config_hash",
    ]);
  });
});

describe("the experiment migration touches only its own objects", () => {
  const drizzle = new URL("../drizzle/", import.meta.url);

  const migrationOf = async () => {
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", drizzle), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((entry) =>
      entry.tag.includes("opik_experiments"),
    );
    if (!entry) throw new Error("no opik_experiments journal entry");
    return {
      sql: await readFile(new URL(`${entry.tag}.sql`, drizzle), "utf8"),
      snapshot: JSON.parse(
        await readFile(
          new URL(
            `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`,
            drizzle,
          ),
          "utf8",
        ),
      ) as {
        tables: Record<
          string,
          { name: string; indexes: Record<string, unknown> }
        >;
      },
    };
  };

  test("creates the table, keys, FK and both guards, and nothing else", async () => {
    const { sql } = await migrationOf();
    const own = new Set([
      "ai_observation_experiments",
      "ai_observation_experiments_state_check",
      "ai_observation_experiments_frozen_coherence_check",
      "ai_observation_experiments_scope_name_uq",
      "ai_observation_experiments_scope_config_hash_frozen_uq",
      "ai_observation_experiments_dataset_version_id_ai_observation_dataset_versions_id_fk",
      "ai_observation_experiments_reject_update",
      "ai_observation_experiments_immutable",
      "ai_observation_experiments_reject_delete",
      "ai_observation_experiments_cleanup_only",
    ]);

    const named = [
      ...sql.matchAll(
        /(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|DROP TABLE|DROP INDEX|CREATE TRIGGER|CREATE FUNCTION)(?: IF NOT EXISTS | IF EXISTS | )?"([^"]+)"|ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/g,
      ),
    ].flatMap((match) => [match[1], match[3]].filter(Boolean) as string[]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !own.has(name))).toEqual([]);

    // Immutability and the cleanup-only delete are database facts, not disciplines.
    expect(sql).toContain(
      'CREATE TRIGGER "ai_observation_experiments_immutable"',
    );
    expect(sql).toContain(
      'CREATE TRIGGER "ai_observation_experiments_cleanup_only"',
    );
    // The delete guard reads its flag fail-closed: IS DISTINCT FROM, never <>.
    expect(sql).toContain("IS DISTINCT FROM 'on'");
  });

  test("the snapshot the next migration will diff against describes the table", async () => {
    const { snapshot } = await migrationOf();
    const table = Object.values(snapshot.tables).find(
      (one) => one.name === "ai_observation_experiments",
    );
    expect(table).toBeDefined();
    expect(Object.keys(table?.indexes ?? {}).sort()).toEqual([
      "ai_observation_experiments_scope_config_hash_frozen_uq",
      "ai_observation_experiments_scope_name_uq",
    ]);
  });
});

describe("the submit service leaves one audit row per submit action", () => {
  /** Records every row the service wanted written. */
  const fakeAudit = () => {
    const events: AuditEventInput[] = [];
    return {
      events,
      store: {
        insert: async (event: AuditEventInput) => {
          events.push(event);
        },
      },
    };
  };

  const experimentRow = {
    id: "experiment-1",
    scopeKey: trusted.key,
    actorId: trusted.actorId,
    botId: trusted.botId,
    name: "outage-eval",
    datasetVersionId: "version-1",
    datasetContentHash: "a".repeat(64),
    config: freezeExperimentConfig(config),
    configHash: "b".repeat(64),
    state: "frozen",
    frozenAt: new Date("2026-10-16T00:00:00.000Z"),
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
  };

  test("a submit records references and counts, never configuration content", async () => {
    const audit = fakeAudit();
    const service = createExperimentSubmitService({
      experiments: {
        submit: async () => ({
          experiment: experimentRow as never,
          replayed: false,
          canaryFindings: 2,
        }),
      },
      audit: audit.store,
    });

    const result = await service.submit(trusted, input);
    expect(result.replayed).toBe(false);
    expect(audit.events).toHaveLength(1);
    const [event] = audit.events;
    expect(event?.eventType).toBe("opik.experiment_submitted");
    expect(event?.targetType).toBe("ai_observation_experiment");
    expect(event?.targetId).toBe("experiment-1");
    expect(event?.actorUserId).toBe(trusted.actorId);
    expect(event?.payload).toEqual({
      experimentId: "experiment-1",
      name: "outage-eval",
      datasetVersionId: "version-1",
      datasetContentHash: "a".repeat(64),
      configHash: "b".repeat(64),
      canaryFindings: 2,
      replayed: false,
    });
    // The canary travels with the trail: the count says the projection refused, and the
    // content itself never does.
    expect(JSON.stringify(event?.payload)).not.toContain(config.prompt);
  });

  test("a replayed submit still leaves its row, marked as the replay it was", async () => {
    const audit = fakeAudit();
    const service = createExperimentSubmitService({
      experiments: {
        submit: async () => ({
          experiment: experimentRow as never,
          replayed: true,
          canaryFindings: 0,
        }),
      },
      audit: audit.store,
    });
    await service.submit(trusted, input);
    expect(audit.events[0]?.payload).toMatchObject({
      replayed: true,
      canaryFindings: 0,
    });
  });

  test("a forged scope is refused before the store is reached", async () => {
    const audit = fakeAudit();
    const service = createExperimentSubmitService({
      experiments: {
        submit: async () => {
          throw new Error("the store must not be reached");
        },
      },
      audit: audit.store,
    });
    await expect(service.submit({ ...trusted }, input)).rejects.toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(audit.events).toHaveLength(0);
  });
});

test("ExperimentStoreError keeps the house error convention: the code is the contract", () => {
  const error = new ExperimentStoreError("EXPERIMENT_STATE_INVALID", 409);
  expect(error.message).toBe("EXPERIMENT_STATE_INVALID");
  expect(error.code).toBe("EXPERIMENT_STATE_INVALID");
  expect(error.status).toBe(409);
  expect(error).toBeInstanceOf(Error);
});
