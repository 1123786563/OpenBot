import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  createRunBindingStore,
  RunBindingError,
} from "../src/ai-observability/bindings";
import { ObservationScopeError } from "../src/ai-observability/contracts";
import { resolveObservationScope } from "../src/ai-observability/scope";
import type { Database } from "../src/db/client";
import { aiObservationBindings } from "../src/db/schema/ai-observability-bindings";

/**
 * Unit contract of the authoritative run-binding store: fail-closed scope handling, input
 * refusal, and the schema/migration shape that makes PostgreSQL — not application code — the
 * idempotency authority. The behavioral proofs (idempotency, isolation, concurrency,
 * reconciliation) live in opik-bindings.integration.test.ts against a dedicated database.
 */

const trusted = resolveObservationScope({
  actorId: "user-a",
  botId: "agent-1",
  ownership: "owner",
  epoch: 1,
});

/** A store that must never reach its database: every assertion here refuses before any query. */
const store = createRunBindingStore({} as Database);

const beginInput = {
  runId: "run-1",
  attemptId: "attempt-1",
  traceId: "trace-1",
  capability: "detailed" as const,
  expiresAt: new Date("2026-10-22T00:00:00.000Z"),
};

describe("the run-binding store refuses what is not a trusted scope", () => {
  test("a spread copy of a real scope is forged, not trusted", () => {
    // Structurally identical to `trusted` down to every field — and issued to nobody.
    const forged = { ...trusted };

    expect(() => store.begin(forged, beginInput)).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(() => store.get(forged, "binding-id")).toThrow(
      new ObservationScopeError("OWNERSHIP_REQUIRED", 403),
    );
    expect(() =>
      store.reconcile(forged, "run-1", "attempt-1", "opik-trace-1"),
    ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
  });

  test("an ownership denial never yields a scope to bind under", () => {
    // The authority rule starts one module upstream: no scope, no binding, no fallback kind.
    expect(() =>
      resolveObservationScope({
        actorId: "user-a",
        botId: "agent-1",
        ownership: "none",
        epoch: 1,
      }),
    ).toThrow(new ObservationScopeError("OWNERSHIP_REQUIRED", 403));
  });
});

describe("the run-binding store validates its own inputs", () => {
  test("refuses empty run, attempt and trace references", () => {
    for (const runId of ["", " "]) {
      expect(() => store.begin(trusted, { ...beginInput, runId })).toThrow(
        new RunBindingError("BINDING_INPUT_INVALID", 400),
      );
    }
    expect(() =>
      store.begin(trusted, { ...beginInput, attemptId: "" }),
    ).toThrow(new RunBindingError("BINDING_INPUT_INVALID", 400));
    expect(() => store.begin(trusted, { ...beginInput, traceId: "" })).toThrow(
      new RunBindingError("BINDING_INPUT_INVALID", 400),
    );
  });

  test("refuses an unknown capability and an expiry that is not a moment in time", () => {
    expect(() =>
      store.begin(trusted, {
        ...beginInput,
        capability: "everything" as never,
      }),
    ).toThrow(new RunBindingError("BINDING_INPUT_INVALID", 400));
    expect(() =>
      store.begin(trusted, {
        ...beginInput,
        expiresAt: new Date("not a date"),
      }),
    ).toThrow(new RunBindingError("BINDING_INPUT_INVALID", 400));
  });

  test("reconciliation needs the authoritative key and the upstream identifier", () => {
    expect(() =>
      store.reconcile(trusted, "", "attempt-1", "opik-trace-1"),
    ).toThrow(new RunBindingError("BINDING_INPUT_INVALID", 400));
    expect(() => store.reconcile(trusted, "run-1", "attempt-1", "")).toThrow(
      new RunBindingError("BINDING_INPUT_INVALID", 400),
    );
  });
});

describe("the binding table holds authority, not content", () => {
  const table = getTableConfig(aiObservationBindings);

  test("no column names a place raw business content could land", () => {
    // The parent Spec forbids storing prompts, outputs, tool arguments, credentials, account
    // emails or attachment URLs. The column set is the whole attack surface for that mistake:
    // nothing that even sounds like a content, body or credential store may exist here.
    const forbidden =
      /prompt|output|body|message|content|attachment|argument|credential|secret|password|token|email|url/i;
    for (const column of table.columns) {
      expect(column.name).not.toMatch(forbidden);
    }
  });

  test("uniqueness is declared where idempotency is decided: the database", () => {
    const unique = table.indexes.filter((index) => index.config.unique);
    expect(unique.map((index) => index.config.name).sort()).toEqual([
      "ai_observation_bindings_scope_opik_trace_uq",
      "ai_observation_bindings_scope_run_attempt_uq",
    ]);
    // (scope, run, attempt) makes begin idempotent; (scope, upstream trace) keeps reconciliation
    // from minting a second local subject for one upstream record.
    expect(
      unique
        .find(
          (index) =>
            index.config.name ===
            "ai_observation_bindings_scope_run_attempt_uq",
        )
        ?.config.columns.map((column) => column.name),
    ).toEqual(["scope_key", "run_id", "attempt_id"]);
  });
});

describe("the opik bindings migration touches only its own objects", () => {
  const drizzle = new URL("../drizzle/", import.meta.url);

  const migrationOf = async () => {
    const journal = JSON.parse(
      await readFile(new URL("meta/_journal.json", drizzle), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((entry) =>
      entry.tag.includes("opik_observation_bindings"),
    );
    if (!entry) throw new Error("no opik_observation_bindings journal entry");
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

  test("creates the table and both uniqueness authorities, and nothing else", async () => {
    const { sql } = await migrationOf();
    // A migration for this ticket that names another ticket's object is the way an unrelated
    // rollback stops being isolated; every identifier the SQL mentions must be one of ours.
    const own = new Set([
      "ai_observation_bindings",
      "ai_observation_bindings_capability_check",
      "ai_observation_bindings_state_check",
      "ai_observation_bindings_scope_run_attempt_uq",
      "ai_observation_bindings_scope_opik_trace_uq",
    ]);

    const named = [
      ...sql.matchAll(
        /(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|DROP TABLE|DROP INDEX|ALTER TABLE|CONSTRAINT|CREATE SCHEMA)(?: IF NOT EXISTS | IF EXISTS | )?"([^"]+)"/g,
      ),
    ].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((name) => !own.has(name))).toEqual([]);

    expect(sql).toContain('CREATE TABLE "ai_observation_bindings"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ai_observation_bindings_scope_run_attempt_uq"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "ai_observation_bindings_scope_opik_trace_uq"',
    );
  });

  test("the snapshot the next migration will diff against describes them", async () => {
    const { snapshot } = await migrationOf();
    const table = Object.values(snapshot.tables).find(
      (table) => table.name === "ai_observation_bindings",
    );
    expect(table).toBeDefined();
    expect(Object.keys(table?.indexes ?? {})).toEqual(
      expect.arrayContaining([
        "ai_observation_bindings_scope_run_attempt_uq",
        "ai_observation_bindings_scope_opik_trace_uq",
      ]),
    );
  });
});

test("RunBindingError keeps the house error convention: the code is the contract", () => {
  const error = new RunBindingError("BINDING_NOT_FOUND", 404);
  expect(error.message).toBe("BINDING_NOT_FOUND");
  expect(error.code).toBe("BINDING_NOT_FOUND");
  expect(error.status).toBe(404);
  expect(error).toBeInstanceOf(Error);
});
