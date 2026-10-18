import { describe, expect, test } from "bun:test";
import {
  chunkTraceIds,
  DEFAULT_EXPORT_CONCURRENCY,
  DEFAULT_EXPORT_MAX_ACTIVE,
  DEFAULT_EXPORT_MAX_ROWS,
  EXPORT_VERDICT_BATCH,
  ExportError,
  ExportRowLimitExceeded,
  foldExportPages,
  isTerminalExportJobState,
  MalformedExportPage,
  parseExportJobState,
  resolveExportLimits,
} from "../src/ai-observability/exports";
import { projectRow } from "../src/ai-observability/queries/runs";

/**
 * The pure contract of the export pipeline (Issue #40 / DAG T34), no database:
 * the fail-closed state vocabulary, the deployment bounds, the page folding
 * that refuses to truncate, and the T05 projection the artifact rides through.
 * The database-backed behavior (concurrency, revocation, isolation) is
 * opik-export.integration.test.ts.
 */

describe("the export job state vocabulary (T10 discipline)", () => {
  test("accepts exactly the five words", () => {
    for (const state of [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(parseExportJobState(state)).toBe(state);
    }
  });

  test("refuses anything else rather than guessing (fail closed)", () => {
    for (const alien of ["cancel", "CANCELED", "", "canceled ", 0, null, {}]) {
      expect(() => parseExportJobState(alien)).toThrow(ExportError);
    }
  });

  test("terminal is decidable and exactly the settled three", () => {
    expect(
      (["queued", "running"] as const).map(isTerminalExportJobState),
    ).toEqual([false, false]);
    expect(
      (["completed", "failed", "cancelled"] as const).map(
        isTerminalExportJobState,
      ),
    ).toEqual([true, true, true]);
  });
});

describe("deployment bounds", () => {
  test("absent env means the conservative defaults", () => {
    expect(resolveExportLimits({})).toEqual({
      concurrency: DEFAULT_EXPORT_CONCURRENCY,
      maxRows: DEFAULT_EXPORT_MAX_ROWS,
      maxActive: DEFAULT_EXPORT_MAX_ACTIVE,
    });
  });

  test("clean values are honored", () => {
    expect(resolveExportLimits({ OPIK_EXPORT_CONCURRENCY: "4" })).toEqual(
      expect.objectContaining({ concurrency: 4 }),
    );
    expect(resolveExportLimits({ OPIK_EXPORT_MAX_ROWS: "250" })).toEqual(
      expect.objectContaining({ maxRows: 250 }),
    );
  });

  test("garbage, zero and over-max keep the default rather than being guessed at", () => {
    for (const bad of ["0", "-1", "abc", "", "999999999"]) {
      expect(
        resolveExportLimits({ OPIK_EXPORT_CONCURRENCY: bad }).concurrency,
      ).toBe(DEFAULT_EXPORT_CONCURRENCY);
    }
    expect(resolveExportLimits({ OPIK_EXPORT_MAX_ROWS: "0" }).maxRows).toBe(
      DEFAULT_EXPORT_MAX_ROWS,
    );
  });

  test("loose numeric forms are refused, not truncated (R2-42: 1e3/1.5/1_000/2500x)", () => {
    // Number.parseInt silently read every one of these as a different quantity
    // ("1e3"→1000, "1.5"→1, "1_000"→1, "2500x"→2500) — the retentionDay Number()
    // precedent refuses what it cannot read whole, and so does an export bound:
    // a row cap the operator did not write is a cap the deployment cannot audit.
    for (const bad of ["1e3", "1.5", "1_000", "2500x", "1e4"]) {
      expect(resolveExportLimits({ OPIK_EXPORT_MAX_ROWS: bad }).maxRows).toBe(
        DEFAULT_EXPORT_MAX_ROWS,
      );
      expect(
        resolveExportLimits({ OPIK_EXPORT_MAX_ACTIVE: bad }).maxActive,
      ).toBe(DEFAULT_EXPORT_MAX_ACTIVE);
      expect(
        resolveExportLimits({ OPIK_EXPORT_CONCURRENCY: bad }).concurrency,
      ).toBe(DEFAULT_EXPORT_CONCURRENCY);
    }
  });
});

describe("folding upstream pages under a row cap", () => {
  const page = (total: number, content: unknown[]) => ({
    total,
    content,
  });

  test("one page under the cap is returned whole", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(await foldExportPages(10, async () => page(2, rows))).toEqual(rows);
  });

  test("walks pages until total is covered", async () => {
    const asked: number[] = [];
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}` }));
    const folded = await foldExportPages(10, async (n) => {
      asked.push(n);
      return page(5, all.slice(n * 2, n * 2 + 2));
    });
    expect(asked).toEqual([0, 1, 2]);
    expect(folded).toEqual(all);
  });

  test("a total above the cap fails explicitly, before any second fetch", async () => {
    let fetches = 0;
    await expect(
      foldExportPages(3, async () => {
        fetches += 1;
        return page(4, [{ id: "a" }]);
      }),
    ).rejects.toBeInstanceOf(ExportRowLimitExceeded);
    expect(fetches).toBe(1);
  });

  test("accumulating past the cap despite a small total fails the cap", async () => {
    // A hostile upstream under-reports its total; the fold trusts the row count
    // it can see, not the envelope's promise.
    await expect(
      foldExportPages(2, async (n) =>
        page(3, n === 0 ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }]),
      ),
    ).rejects.toBeInstanceOf(ExportRowLimitExceeded);
  });

  test("an over-shipped FIRST page fails the cap too (OCR m139)", async () => {
    // The envelope promised 1; the page carried 3. Shipping the extra rows as a
    // success would be an over-limit export wearing a clean answer.
    await expect(
      foldExportPages(2, async () =>
        page(1, [{ id: "a" }, { id: "b" }, { id: "c" }]),
      ),
    ).rejects.toBeInstanceOf(ExportRowLimitExceeded);
  });

  test("pages that run out before total are malformed, never a short success", async () => {
    await expect(
      foldExportPages(10, async (n) =>
        page(4, n === 0 ? [{ id: "a" }, { id: "b" }] : []),
      ),
    ).rejects.toBeInstanceOf(MalformedExportPage);
  });

  test("a drifting total between pages is malformed", async () => {
    await expect(
      foldExportPages(10, async (n) =>
        page(n === 0 ? 4 : 3, [{ id: "a" }, { id: "b" }]),
      ),
    ).rejects.toBeInstanceOf(MalformedExportPage);
  });

  test("overshooting the total under the cap is malformed, never a truncated success (OCR R4-31)", async () => {
    // The loop exits when accumulation crosses total, not when it lands on it:
    // a hostile upstream over-shipping its pages (3 promised, 3+3 delivered,
    // all unique ids, all under the cap) used to sail through as 6 honest rows.
    // The terminal state must be exact — refuse the whole fold, never trim to
    // the promised total and call it done.
    await expect(
      foldExportPages(10, async (n) =>
        page(
          4,
          n === 0
            ? [{ id: "a" }, { id: "b" }, { id: "c" }]
            : [{ id: "d" }, { id: "e" }, { id: "f" }],
        ),
      ),
    ).rejects.toBeInstanceOf(MalformedExportPage);
  });

  test("the same trace id twice is malformed, not two observations", async () => {
    await expect(
      foldExportPages(10, async (n) =>
        page(
          4,
          n === 0 ? [{ id: "a" }, { id: "b" }] : [{ id: "a" }, { id: "c" }],
        ),
      ),
    ).rejects.toBeInstanceOf(MalformedExportPage);
  });
});

describe("chunking the verdict join's id list (OCR R4-38)", () => {
  test("the batch size stays far under PG's 65,535 bind-parameter ceiling", () => {
    expect(EXPORT_VERDICT_BATCH).toBe(1000);
  });

  test("a job-sized id list splits into ordered, cap-sized batches", () => {
    // 2,500 ids is a legal job.rowLimit world (max 100_000) — one unchunked
    // inArray over it is 2,500 bound parameters, and a full 100_000-trace job
    // is a guaranteed protocol blow-up past 65,535.
    const ids = Array.from({ length: 2_500 }, (_, i) => `t${i}`);
    const batches = chunkTraceIds(ids);
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 500]);
    expect(batches.flat()).toEqual(ids);
  });

  test("exactly one batch stays one batch; an empty list asks for nothing", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    expect(chunkTraceIds(ids)).toEqual([ids]);
    expect(chunkTraceIds([])).toEqual([]);
  });
});

describe("the artifact projection (T05 seam)", () => {
  test("a canary in metadata is omitted, never masked-through", () => {
    const projected = projectRow({
      id: "trace-1",
      status: "COMPLETED",
      metadata: {
        thread_id: "thread-1",
        model: "sk-live-abcdefghijklmnopqrst",
        api_key: "sk-live-abcdefghijklmnopqrst",
        notes: "a bearer sk-test-abcdefghijklmnop token in prose",
      },
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    // An allowlisted key carrying a credential-shaped value is omitted with
    // the reason; a disallowed key is dropped outright, never rendered.
    expect(projected.metadata.model).toEqual({
      state: "omitted",
      reason: "credential",
    });
    expect(projected.metadata).not.toHaveProperty("api_key");
    expect(projected.metadata).not.toHaveProperty("notes");
    expect(JSON.stringify(projected)).not.toContain("sk-live-");
    expect(JSON.stringify(projected)).not.toContain("sk-test-");
  });

  test("keys off the metadata allowlist are dropped outright", () => {
    const projected = projectRow({
      id: "trace-2",
      status: "IN_PROGRESS",
      metadata: { secret_notes: "harmless text on a disallowed key" },
    });
    expect(projected.metadata).not.toHaveProperty("secret_notes");
    expect(projected.state).toBe("running");
    expect(projected.usage).toEqual({ source: "unavailable" });
  });
});
