import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { IndexWriter } from "../application/repository/retriever/qdrant/index-writer";
import * as schema from "../db/schema";
import { knowledges } from "../db/schema";
import { type ProcessDeps, processDocument } from "./document-process";
import type { DocumentProcessPayload } from "./queue";

/**
 * 摄取管线用例（T03 验收核心）：幂等守卫 / attempt 竞态 / 删除顺序铁律 /
 * 失败路径。真实 Postgres（127.0.0.1:5432 kb_mastra 库，T01 冒烟建过） +
 * mock embedder（固定向量）/ mock index-writer（记录调用序）。
 */

const DB_URL =
  process.env.KB_TEST_DATABASE_URL ??
  "postgres://kb_mastra:kb_mastra@127.0.0.1:5432/kb_mastra";

async function dbUp(): Promise<boolean> {
  try {
    const sql = postgres(DB_URL, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

const up = await dbUp();

/** mock index-writer：调用序是删除顺序断言的证据。 */
function recordingIndexWriter() {
  const calls: string[] = [];
  const points: { id: string; payload: Record<string, unknown> }[] = [];
  const writer: IndexWriter = {
    async upsertChunks(inputs) {
      calls.push(`upsert:${inputs.length}`);
      for (const input of inputs)
        points.push({
          id: input.chunkId,
          payload: { doc_id: input.docId, tenant_id: input.tenantId },
        });
    },
    async deleteByDoc(_tenantId, docId) {
      calls.push(`deleteDoc:${docId}`);
    },
    async deleteByKb(_tenantId, kbId) {
      calls.push(`deleteKb:${kbId}`);
    },
  };
  return { writer, calls, points };
}

/** mock embedder：确定性向量（chunk index 编码进前几维）。 */
function mockEmbedder(dimensions = 8) {
  let calls = 0;
  return {
    calls: () => calls,
    async embed(_text: string) {
      calls += 1;
      return new Array<number>(dimensions).fill(1);
    },
    async batchEmbed(texts: string[]) {
      calls += texts.length;
      return texts.map((_, i) => {
        const vector = new Array<number>(dimensions).fill(0.5);
        vector[0] = (i % 8) + 1;
        return vector;
      });
    },
    getModelName: () => "mock-embedder",
    getDimensions: () => dimensions,
    getModelID: () => "mock-embedder",
  };
}

describe.skipIf(!up)("processDocument guard semantics", () => {
  const sql = postgres(DB_URL, { max: 5 });
  const db = drizzle(sql, { schema });
  let kbId: string;

  const payload = (
    over: Partial<DocumentProcessPayload> = {},
  ): DocumentProcessPayload => ({
    requestId: "req-test",
    tenantId: "tenant-test",
    knowledgeId: "doc-guard",
    kbId,
    filePath: "",
    fileName: "text.txt",
    fileType: "txt",
    url: "",
    fileUrl: "",
    passages: "第一段。\n\n第二段内容较长一些，确保能切出块。",
    attempt: 0,
    ...over,
  });

  const deps = (): ProcessDeps => ({
    db,
    registry: null as never, // passages 入口不经 parser
    embedder: mockEmbedder() as never,
    indexWriter: recordingIndexWriter().writer,
  });

  beforeAll(async () => {
    kbId = `kb-test-${Date.now().toString(36)}`;
    await db.insert(schema.knowledgeBases).values({
      id: kbId,
      tenantId: "tenant-test",
      name: `guard-test-${Date.now()}`,
      chunkingConfig: {
        chunkSize: 32,
        chunkOverlap: 4,
        separators: ["\n\n"],
        strategy: "recursive",
      },
      embeddingModelId: "mock-embedder",
    });
  });

  afterAll(async () => {
    await db
      .delete(schema.knowledges)
      .where(eq(schema.knowledges.knowledgeBaseId, kbId));
    await db
      .delete(schema.knowledgeBases)
      .where(eq(schema.knowledgeBases.id, kbId));
    await sql.end();
  });

  async function insertDoc(id: string, over: Record<string, unknown> = {}) {
    await db.insert(knowledges).values({
      id,
      tenantId: "tenant-test",
      knowledgeBaseId: kbId,
      type: "manual",
      title: id,
      source: "manual",
      parseStatus: "pending",
      embeddingModelId: "mock-embedder",
      attempt: 0,
      ...over,
    });
  }

  test("happy path: pending doc → completed with chunks and progress", async () => {
    await insertDoc("doc-guard");
    const recorder = recordingIndexWriter();
    const result = await processDocument(
      { ...deps(), indexWriter: recorder.writer },
      payload(),
    );
    expect(result.skipped).toBeUndefined();
    const [row] = await db
      .select()
      .from(knowledges)
      .where(eq(knowledges.id, "doc-guard"));
    expect(row?.parseStatus).toBe("completed");
    expect(row?.progress?.chunksTotal ?? 0).toBeGreaterThan(0);
    expect(row?.progress?.chunksDone).toBe(row?.progress?.chunksTotal);
    const chunkRows = await db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.knowledgeId, "doc-guard"));
    expect(chunkRows.length).toBe(row?.progress?.chunksTotal ?? -1);
    // upsert 的 point 数 = chunk 行数。
    expect(recorder.points.length).toBe(chunkRows.length);
    // payload 七键齐（抽查）。
    expect(recorder.points[0]?.payload.doc_id).toBe("doc-guard");
    expect(recorder.points[0]?.payload.tenant_id).toBe("tenant-test");
  });

  test("completed doc is skipped (idempotent rerun does not reprocess)", async () => {
    const result = await processDocument(deps(), payload());
    expect(result.skipped).toBe("completed");
  });

  test("attempt mismatch is skipped (attemptSuperseded)", async () => {
    // 模拟 reparse：行 attempt 升到 1，但 in-flight job 携带 0。
    await db
      .update(knowledges)
      .set({ attempt: 1, parseStatus: "pending" })
      .where(eq(knowledges.id, "doc-guard"));
    const result = await processDocument(deps(), payload({ attempt: 0 }));
    expect(result.skipped).toBe("attemptSuperseded");
    // 修正世代号后可跑。
    const ok = await processDocument(deps(), payload({ attempt: 1 }));
    expect(ok.skipped).toBeUndefined();
  });

  test("deleting/cancelled docs are skipped", async () => {
    await insertDoc("doc-del", { parseStatus: "deleting" });
    await insertDoc("doc-can", { parseStatus: "cancelled" });
    expect(
      (await processDocument(deps(), payload({ knowledgeId: "doc-del" })))
        .skipped,
    ).toBe("deleting");
    expect(
      (await processDocument(deps(), payload({ knowledgeId: "doc-can" })))
        .skipped,
    ).toBe("cancelled");
  });

  test("missing row is skipped", async () => {
    expect(
      (await processDocument(deps(), payload({ knowledgeId: "doc-none" })))
        .skipped,
    ).toBe("missing");
  });

  test("reparse of processed doc: Qdrant-then-SQL cleanup keeps counts stable", async () => {
    // doc-guard 已 completed 且 attempt=1。reparse：attempt=2 重跑。
    await db
      .update(knowledges)
      .set({ attempt: 2, parseStatus: "pending" })
      .where(eq(knowledges.id, "doc-guard"));
    const recorder = recordingIndexWriter();
    await processDocument(
      { ...deps(), indexWriter: recorder.writer },
      payload({ attempt: 2 }),
    );
    // 删除顺序铁律：deleteDoc 先于 upsert。
    expect(recorder.calls[0]).toMatch(/^deleteDoc:doc-guard$/);
    expect(recorder.calls.some((call) => call.startsWith("upsert:"))).toBe(
      true,
    );
    // 不翻倍：chunk 行数 = 首跑数（新 id 覆盖旧 point）。
    const chunkRows = await db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.knowledgeId, "doc-guard"));
    const [row] = await db
      .select()
      .from(knowledges)
      .where(eq(knowledges.id, "doc-guard"));
    expect(chunkRows.length).toBe(row?.progress?.chunksTotal ?? -1);
    // chunk_revisions 追加语义：每次运行每块一版，总数 ≥ 当前块数。
    const revisions = await db
      .select()
      .from(schema.chunkRevisions)
      .where(eq(schema.chunkRevisions.knowledgeId, "doc-guard"));
    expect(revisions.length).toBeGreaterThanOrEqual(chunkRows.length);
  });

  test("embedder failure marks failed and rethrows (BullMQ retry semantics)", async () => {
    await insertDoc("doc-fail", { parseStatus: "pending" });
    const failing = {
      ...deps(),
      embedder: {
        embed: async () => [],
        batchEmbed: async () => {
          throw new Error("ollama down");
        },
        getModelName: () => "mock",
        getDimensions: () => 8,
        getModelID: () => "mock",
      } as never,
    };
    await expect(
      processDocument(failing, payload({ knowledgeId: "doc-fail" })),
    ).rejects.toThrow("ollama down");
    const [row] = await db
      .select()
      .from(knowledges)
      .where(eq(knowledges.id, "doc-fail"));
    expect(row?.parseStatus).toBe("failed");
    expect(row?.errorMessage).toContain("embedding failed");
  });

  test("empty passages complete with zero chunks and cleaned index", async () => {
    await insertDoc("doc-empty", { parseStatus: "pending" });
    const recorder = recordingIndexWriter();
    await processDocument(
      { ...deps(), indexWriter: recorder.writer },
      payload({ knowledgeId: "doc-empty", passages: "" }),
    );
    const [row] = await db
      .select()
      .from(knowledges)
      .where(eq(knowledges.id, "doc-empty"));
    expect(row?.parseStatus).toBe("completed");
    expect(row?.progress?.chunksTotal).toBe(0);
    expect(recorder.calls[0]).toMatch(/^deleteDoc:doc-empty$/);
    // 空文档不该有 upsert。
    expect(recorder.calls.some((c) => c.startsWith("upsert:"))).toBe(false);
  });
});
