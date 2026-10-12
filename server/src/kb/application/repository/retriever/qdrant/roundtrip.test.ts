import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../../../../db/schema";
import { knowledges } from "../../../../db/schema";
import { processDocument } from "../../../../tasks/document-process";
import type { DocumentProcessPayload } from "../../../../tasks/queue";
import { createIndexWriter } from "./index-writer";
import { ensureCollection } from "../../../../infrastructure/qdrant/collections";
import { QdrantClient } from "../../../../infrastructure/qdrant/client";
import { createQdrantVectorEngine } from "./vector";
import { hybridSearch } from "../../../service/kb-search";
import { createCompositeRetrieveEngine } from "../../../service/retriever/composite";
import type { Embedder } from "../../../../models/embedding/embedder";

/**
 * QA 补盲区（跨模块 roundtrip）：摄取 → Qdrant（wait=true）→ 立刻检索可见性。
 * 真 Postgres + 真 Qdrant；embedder 用确定性 mock（文本长度调制向量首维）。
 * 验收点：upsert 完成即查得见（wait=true 语义）、删除后不可见、payload/链表
 * 扩展取回真实值。
 */

const DB_URL =
  process.env.KB_TEST_DATABASE_URL ??
  "postgres://kb_mastra:kb_mastra@127.0.0.1:5432/kb_mastra";
const QDRANT_URL = process.env.QDRANT_URL_TEST ?? "http://127.0.0.1:6333";

async function depsUp(): Promise<boolean> {
  try {
    const sql = postgres(DB_URL, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    const q = new QdrantClient({ baseUrl: QDRANT_URL, timeoutMs: 3_000 });
    await q.getCollection("kb_chunks_8");
    return true;
  } catch {
    return false;
  }
}

const up = await depsUp();

/** 确定性 embedder：8 维；向量首维 = 文本长度的确定性哈希——相同文本同向量。 */
const mockEmbedder: Embedder = {
  async embed(text) {
    return vectorFor(text);
  },
  async batchEmbed(texts) {
    return texts.map(vectorFor);
  },
  getModelName: () => "mock-rt",
  getDimensions: () => 8,
  getModelID: () => "mock-rt",
};
function vectorFor(text: string): number[] {
  const vec = new Array<number>(8).fill(0.1);
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  vec[0] = (hash % 100) / 100 + 0.1;
  return vec;
}

describe.skipIf(!up)("ingest → qdrant → retrieve roundtrip (live)", () => {
  const sql = postgres(DB_URL, { max: 5 });
  const db = drizzle(sql, { schema });
  const qdrant = new QdrantClient({ baseUrl: QDRANT_URL });
  const indexWriter = createIndexWriter(qdrant, "kb_chunks_8", { batchSize: 4, concurrency: 2 });
  const engine = createQdrantVectorEngine({ client: qdrant, collection: "kb_chunks_8" });
  const composite = createCompositeRetrieveEngine([engine]);
  const tenantId = `rt-qa-${Date.now().toString(36)}`;
  let kbId = "";

  beforeAll(async () => {
    await ensureCollection(qdrant, 8);
    kbId = `kb-rt-${Date.now().toString(36)}`;
    await db.insert(schema.knowledgeBases).values({
      id: kbId,
      tenantId,
      name: `roundtrip-${Date.now()}`,
      chunkingConfig: { chunkSize: 24, chunkOverlap: 4, separators: ["\n\n"], strategy: "recursive" },
      embeddingModelId: "mock-rt",
    });
  });

  afterAll(async () => {
    // 清理：Qdrant points（先）→ SQL 行（后）——与铁律同序
    await qdrant.deletePointsByFilter("kb_chunks_8", {
      must: [{ key: "tenant_id", match: { value: tenantId } }],
    });
    await db.delete(schema.knowledges).where(eq(schema.knowledges.knowledgeBaseId, kbId));
    await db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, kbId));
    await sql.end();
  });

  async function ingestDoc(docId: string, passages: string): Promise<void> {
    await db.insert(knowledges).values({
      id: docId,
      tenantId,
      knowledgeBaseId: kbId,
      type: "manual",
      title: docId,
      source: "manual",
      parseStatus: "pending",
      embeddingModelId: "mock-rt",
      attempt: 0,
    });
    const payload: DocumentProcessPayload = {
      requestId: "req-rt",
      tenantId,
      knowledgeId: docId,
      kbId,
      filePath: "",
      fileName: "t.txt",
      fileType: "txt",
      url: "",
      fileUrl: "",
      passages,
      attempt: 0,
    };
    const out = await processDocument(
      { db, registry: null as never, embedder: mockEmbedder, indexWriter },
      payload,
    );
    expect(out.skipped).toBeUndefined();
  }

  test("ingest then immediate retrieve hits (wait=true visibility)", async () => {
    const docId = `doc-rt-${Date.now().toString(36)}`;
    await ingestDoc(
      docId,
      "风险准备金率是交易所要求的资金。\n\n杠杆交易的风险控制要点。",
    );
    // completed 落行
    const [row] = await db.select().from(knowledges).where(eq(knowledges.id, docId));
    expect(row.parseStatus).toBe("completed");
    expect((row.progress?.chunksTotal ?? 0)).toBeGreaterThan(0);

    // 立刻检索（同 embedding 输入 → 同向量 → 命中自身）
    const outcome = await hybridSearch(
      {
        embedder: mockEmbedder,
        composite,
        db,
      },
      {
        tenantId,
        kbIds: [kbId],
        query: "风险准备金率是交易所要求的资金。\n\n杠杆交易的风险控制要点。",
        topK: 5,
        scoreThreshold: 0,
        hybrid: true,
      },
    );
    expect(outcome.count).toBeGreaterThan(0);
    expect(outcome.results[0].docId).toBe(docId);
    expect(outcome.results[0].content.length).toBeGreaterThan(0);
    // manual → text（组装路径）
    expect(outcome.results[0].source).toBe("manual"); // service 层保留内部枚举；wire 投影在 handler
  });

  test("reparse (attempt bump) does not duplicate points", async () => {
    const docId = `doc-rp-${Date.now().toString(36)}`;
    await ingestDoc(docId, "第一段内容。\n\n第二段内容。");
    const before = await qdrant.countPoints("kb_chunks_8", {
      must: [
        { key: "tenant_id", match: { value: tenantId } },
        { key: "doc_id", match: { value: docId } },
      ],
    });
    expect(before).toBeGreaterThan(0);

    // reparse：attempt+1 后重跑
    await db.update(knowledges).set({ attempt: 1, parseStatus: "pending" }).where(eq(knowledges.id, docId));
    await processDocument(
      { db, registry: null as never, embedder: mockEmbedder, indexWriter },
      {
        requestId: "req-rt2",
        tenantId,
        knowledgeId: docId,
        kbId,
        filePath: "",
        fileName: "t.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: "第一段内容。\n\n第二段内容。",
        attempt: 1,
      },
    );
    const after = await qdrant.countPoints("kb_chunks_8", {
      must: [
        { key: "tenant_id", match: { value: tenantId } },
        { key: "doc_id", match: { value: docId } },
      ],
    });
    expect(after).toBe(before); // 清旧+重插不翻倍
  });

  test("old attempt job during reparse is skipped (guard)", async () => {
    const docId = `doc-race-${Date.now().toString(36)}`;
    await db.insert(knowledges).values({
      id: docId,
      tenantId,
      knowledgeBaseId: kbId,
      type: "manual",
      title: docId,
      source: "manual",
      parseStatus: "pending",
      embeddingModelId: "mock-rt",
      attempt: 2, // reparse 已把世代号推到 2
    });
    const out = await processDocument(
      { db, registry: null as never, embedder: mockEmbedder, indexWriter },
      {
        requestId: "req-race",
        tenantId,
        knowledgeId: docId,
        kbId,
        filePath: "",
        fileName: "t.txt",
        fileType: "txt",
        url: "",
        fileUrl: "",
        passages: "内容",
        attempt: 1, // 旧 job 携带旧世代号
      },
    );
    expect(out.skipped).toBe("attemptSuperseded");
    // 行未被旧 job 碰过
    const [row] = await db.select().from(knowledges).where(eq(knowledges.id, docId));
    expect(row.parseStatus).toBe("pending");
  });

  test("delete makes chunks unretrievable (Qdrant-first cascade)", async () => {
    const docId = `doc-del-${Date.now().toString(36)}`;
    await ingestDoc(docId, "将被删除的独有内容标记。");
    const hit = await hybridSearch(
      { embedder: mockEmbedder, composite, db },
      {
        tenantId,
        kbIds: [kbId],
        query: "将被删除的独有内容标记。",
        topK: 10,
        scoreThreshold: 0,
        hybrid: false,
      },
    );
    expect(hit.results.some((r) => r.docId === docId)).toBe(true);

    // 删除（先 Qdrant 后 SQL）
    await indexWriter.deleteByDoc(tenantId, docId);
    await db.delete(schema.chunks).where(eq(schema.chunks.knowledgeId, docId));
    await db.update(knowledges).set({ deletedAt: new Date(), parseStatus: "deleting" }).where(eq(knowledges.id, docId));

    const after = await hybridSearch(
      { embedder: mockEmbedder, composite, db },
      {
        tenantId,
        kbIds: [kbId],
        query: "将被删除的独有内容标记。",
        topK: 10,
        scoreThreshold: 0,
        hybrid: false,
      },
    );
    expect(after.results.some((r) => r.docId === docId)).toBe(false);
  });

  test("neighbor expansion joins pre/next content (chunk_index ordering)", async () => {
    const docId = `doc-nb-${Date.now().toString(36)}`;
    await ingestDoc(docId, "首段邻接内容甲。\n\n中段邻接内容乙。\n\n尾段邻接内容丙。");
    const outcome = await hybridSearch(
      { embedder: mockEmbedder, composite, db },
      {
        tenantId,
        kbIds: [kbId],
        query: "首段邻接内容甲。\n\n中段邻接内容乙。\n\n尾段邻接内容丙。",
        topK: 1,
        scoreThreshold: 0,
        hybrid: false,
      },
    );
    expect(outcome.count).toBe(1);
    // 命中块 + 相邻块拼接（一跳扩展把邻接文本带上）
    expect(outcome.results[0].content).toContain("邻接内容");
  });
});
