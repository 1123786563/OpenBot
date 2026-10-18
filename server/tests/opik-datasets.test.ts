import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import { REDACTION_POLICY_VERSION } from "../../shared/ai-observability";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import {
  contentHash,
  createObservationDatasetStore,
  DatasetStoreError,
  freezeCases,
  MAX_DATASET_CASES,
} from "../src/ai-observability/datasets";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { Database } from "../src/db/client";
import {
  aiObservationDatasets,
  aiObservationDatasetVersions,
} from "../src/db/schema/ai-observability-datasets";

/**
 * Unit contract of the dataset version store (Issue #25 / DAG T19): fail-closed scope handling,
 * input refusal, the freeze pipeline that projects case content before it is ever hashed or
 * stored, and the hash discipline that makes "save the same cases again" the same version. The
 * behavioral proofs (idempotency, isolation, immutability at the database, partial-sync
 * recovery) live in opik-datasets.integration.test.ts against a dedicated database.
 */

const trusted = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

/** A store that must never reach its database: every assertion here refuses before any query. */
const store = createObservationDatasetStore({} as Database);

const caseInput = {
  input: "Summarize the outage report.",
  referenceOutput: "A one-paragraph summary of the outage.",
  toolFixtures: { search: { query: "outage", results: 0 } },
  sourceRunId: "run-1",
  sourceAttemptId: "attempt-1",
  sourceBindingId: "binding-1",
};

describe("the dataset store refuses what is not a trusted scope", () => {
  test("a spread copy of a real scope is forged, not trusted", () => {
    const forged = { ...trusted };

    expect(() =>
      store.saveVersion(forged, {
        datasetName: "eval-set",
        cases: [caseInput],
      }),
    ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
    expect(() => store.getDataset(forged, "dataset-id")).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(() => store.getVersion(forged, "version-id")).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(() =>
      store.markSynced(forged, "dataset-id", "opik-dataset-1"),
    ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
  });
});

describe("the dataset store validates its own inputs", () => {
  test("refuses an empty or blank dataset name", () => {
    for (const datasetName of ["", " "]) {
      expect(() =>
        store.saveVersion(trusted, { datasetName, cases: [caseInput] }),
      ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
    }
  });

  test("refuses a dataset name longer than 128 bytes", () => {
    expect(() =>
      store.saveVersion(trusted, {
        datasetName: "n".repeat(129),
        cases: [caseInput],
      }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
  });

  test("refuses a credential-shaped dataset name before anything is stored (OCR m110)", () => {
    // The reviewer types this name in the save flow; the subject row and the
    // append-only audit row would both carry it forever. Same discipline as the
    // experiment name (h5): a credential-class match is refused, never stored.
    for (const datasetName of [
      "sk-live-abcdefghijklmnopqrst",
      "postgres://user:hunter2@host/db",
    ]) {
      expect(() =>
        store.saveVersion(trusted, { datasetName, cases: [caseInput] }),
      ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
    }
  });

  test("refuses zero cases and more cases than one version may freeze", () => {
    expect(() =>
      store.saveVersion(trusted, { datasetName: "eval-set", cases: [] }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
    expect(() =>
      store.saveVersion(trusted, {
        datasetName: "eval-set",
        cases: Array.from({ length: MAX_DATASET_CASES + 1 }, () => caseInput),
      }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
  });

  test("refuses a case without reviewed input, reference output or a source run", () => {
    expect(() =>
      store.saveVersion(trusted, {
        datasetName: "eval-set",
        cases: [{ ...caseInput, input: "" }],
      }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
    expect(() =>
      store.saveVersion(trusted, {
        datasetName: "eval-set",
        cases: [{ ...caseInput, referenceOutput: "  " }],
      }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
    expect(() =>
      store.saveVersion(trusted, {
        datasetName: "eval-set",
        cases: [{ ...caseInput, sourceRunId: "" }],
      }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
    expect(() =>
      store.saveVersion(trusted, {
        datasetName: "eval-set",
        cases: [{ ...caseInput, sourceAttemptId: "" }],
      }),
    ).toThrow(new DatasetStoreError("DATASET_INPUT_INVALID", 400));
  });

  test("refuses references that are not non-empty strings before any query", () => {
    expect(() => store.getDataset(trusted, "")).toThrow(
      new DatasetStoreError("DATASET_INPUT_INVALID", 400),
    );
    expect(() => store.getVersion(trusted, " ")).toThrow(
      new DatasetStoreError("DATASET_INPUT_INVALID", 400),
    );
    expect(() => store.markSynced(trusted, "dataset-id", "")).toThrow(
      new DatasetStoreError("DATASET_INPUT_INVALID", 400),
    );
  });
});

describe("the freeze pipeline projects case content before it is hashed", () => {
  test("reviewed free text survives, denied text does not", () => {
    const frozen = freezeCases([
      {
        ...caseInput,
        input: "sk-live-abc123def456ghi789jkl012 is not a case input",
      },
    ]);
    // Free text was reviewed by the case author, so it is projectable — but a credential
    // literal is never projectable, and the freeze keeps the refusal, not the literal.
    expect(frozen[0]!.safeInput).toEqual({
      state: "omitted",
      reason: "credential",
    });
    expect(frozen[0]!.referenceOutput.state).toBe("projected");
    // Tool fixtures are structured: keys and values both go through the deny scan, and every
    // level carries its own SafeValue state — that is T05's shape, kept as-is.
    expect(frozen[0]!.toolFixtures).toEqual({
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
    // The source references are frozen as-is: they are our own opaque ids.
    expect(frozen[0]!.sourceRunId).toBe("run-1");
    expect(frozen[0]!.sourceBindingId).toBe("binding-1");
  });

  test("a fixture key or value the policy denies is dropped, not echoed", () => {
    const frozen = freezeCases([
      {
        ...caseInput,
        toolFixtures: {
          "postgres://u:p@h/db": "value",
          nested: { token: "Bearer abcdefghijklmnop" },
        },
      },
    ]);
    expect(frozen[0]!.toolFixtures).toEqual({
      state: "projected",
      // The connection-string key is dropped outright — rendering it as omitted would echo
      // the hostile key name — and the denied value under a clean key is refused in place.
      value: {
        nested: {
          state: "projected",
          value: { token: { state: "omitted", reason: "credential" } },
        },
      },
    });
  });
});

describe("the content hash is stable, canonical and policy-bound", () => {
  const frozen = freezeCases([caseInput]);

  test("is sha-256 hex and identical across key orders and insertions", () => {
    const hash = contentHash(frozen, REDACTION_POLICY_VERSION);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Canonical JSON: object key order never changes the hash.
    const reordered = freezeCases([
      {
        toolFixtures: { search: { results: 0, query: "outage" } },
        sourceRunId: "run-1",
        referenceOutput: "A one-paragraph summary of the outage.",
        sourceBindingId: "binding-1",
        input: "Summarize the outage report.",
        sourceAttemptId: "attempt-1",
      },
    ]);
    expect(contentHash(reordered, REDACTION_POLICY_VERSION)).toBe(hash);
  });

  test("the redaction policy version participates: a policy bump is a different version", () => {
    const hash = contentHash(frozen, REDACTION_POLICY_VERSION);
    expect(contentHash(frozen, "opik-redaction/6")).not.toBe(hash);
  });

  test("different cases are a different version: the hash discriminates content", () => {
    const other = freezeCases([
      { ...caseInput, input: "A different reviewed case." },
    ]);
    expect(contentHash(other, REDACTION_POLICY_VERSION)).not.toBe(
      contentHash(frozen, REDACTION_POLICY_VERSION),
    );
  });

  test("golden hash: the algorithm is pinned, not merely self-consistent", () => {
    // Computed once and frozen here so a future refactor cannot silently rehash every saved
    // dataset into "new" versions. If this breaks on purpose, the policy/migration story must
    // say so loudly — bumping the algorithm re-keys every dataset.
    expect(contentHash(frozen, REDACTION_POLICY_VERSION)).toBe(
      "9d91f62f068c23c08d82372243542fd37d127bafa0e8990ed69ce6c57b1dbf38",
    );
  });
});

describe("the dataset tables hold frozen snapshots and sync truth, not secrets", () => {
  test("no column names a credential, secret or contact surface", () => {
    // The versions table IS the content store — input, reference and fixture columns are its
    // job — so the bindings-table forbid-list does not apply. What must never exist anywhere
    // is a column that sounds like a credential, secret or contact channel.
    const forbidden =
      /prompt|credential|secret|password|token|email|attachment|url|api_key/i;
    for (const table of [aiObservationDatasets, aiObservationDatasetVersions]) {
      for (const column of getTableConfig(table).columns) {
        expect(column.name).not.toMatch(forbidden);
      }
    }
  });

  test("version idempotency is a database key: (scope, dataset, content hash)", () => {
    const unique = getTableConfig(aiObservationDatasetVersions).indexes.filter(
      (index) => index.config.unique,
    );
    expect(unique.map((index) => index.config.name).sort()).toEqual([
      "ai_observation_dataset_versions_scope_dataset_hash_uq",
    ]);
    expect(unique[0]!.config.columns.map((column) => column.name)).toEqual([
      "scope_key",
      "dataset_id",
      "content_hash",
    ]);
  });

  test("a dataset name is unique inside one scope, and one upstream id is claimed once", () => {
    expect(
      getTableConfig(aiObservationDatasets)
        .indexes.filter((index) => index.config.unique)
        .map((index) => index.config.name)
        .sort(),
    ).toEqual([
      "ai_observation_datasets_scope_name_uq",
      "ai_observation_datasets_scope_opik_dataset_uq",
    ]);
  });
});

describe("the dataset migration touches only its own objects", () => {
  const drizzle = new URL("../drizzle/", import.meta.url);

  const migrationOf = async () => {
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", drizzle), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((entry) =>
      entry.tag.includes("opik_dataset_versions"),
    );
    if (!entry) throw new Error("no opik_dataset_versions journal entry");
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

  test("creates the tables, keys and immutability trigger, and nothing else", async () => {
    const { sql } = await migrationOf();
    const own = new Set([
      "ai_observation_datasets",
      "ai_observation_datasets_sync_state_check",
      "ai_observation_datasets_synced_requires_upstream_check",
      "ai_observation_datasets_scope_name_uq",
      "ai_observation_datasets_scope_opik_dataset_uq",
      "ai_observation_dataset_versions",
      "ai_observation_dataset_versions_scope_dataset_hash_uq",
      "ai_observation_dataset_versions_dataset_id_ai_observation_datasets_id_fk",
      "ai_observation_dataset_versions_reject_update",
      "ai_observation_dataset_versions_immutable",
    ]);

    const named = [
      ...sql.matchAll(
        /(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|DROP TABLE|DROP INDEX|CREATE TRIGGER|CREATE FUNCTION)(?: IF NOT EXISTS | IF EXISTS | )?"([^"]+)"|ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/g,
      ),
    ].flatMap((match) => [match[1], match[3]].filter(Boolean) as string[]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !own.has(name))).toEqual([]);

    expect(sql).toContain('CREATE TABLE "ai_observation_datasets"');
    expect(sql).toContain('CREATE TABLE "ai_observation_dataset_versions"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ai_observation_dataset_versions_scope_dataset_hash_uq"',
    );
    // The immutability guarantee is a database fact, not a discipline: an UPDATE on a frozen
    // version row raises, whoever tries it and whatever code path let them.
    expect(sql).toContain(
      'CREATE TRIGGER "ai_observation_dataset_versions_immutable"',
    );
  });

  test("the snapshot the next migration will diff against describes them", async () => {
    const { snapshot } = await migrationOf();
    const tables = Object.values(snapshot.tables);
    const datasets = tables.find(
      (table) => table.name === "ai_observation_datasets",
    );
    const versions = tables.find(
      (table) => table.name === "ai_observation_dataset_versions",
    );
    expect(datasets).toBeDefined();
    expect(versions).toBeDefined();
    expect(Object.keys(versions?.indexes ?? {})).toEqual([
      "ai_observation_dataset_versions_scope_dataset_hash_uq",
    ]);
  });
});

test("DatasetStoreError keeps the house error convention: the code is the contract", () => {
  const error = new DatasetStoreError("DATASET_NOT_FOUND", 404);
  expect(error.message).toBe("DATASET_NOT_FOUND");
  expect(error.code).toBe("DATASET_NOT_FOUND");
  expect(error.status).toBe(404);
  expect(error).toBeInstanceOf(Error);
});
