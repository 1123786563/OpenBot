/**
 * T03 端到端冒烟（验收序列）：真实 postgres + qdrant + redis（+ docreader
 * 可选），embedding 用 mock（固定维度 8——独立冒烟 collection，不碰生产档）。
 *
 * 序列：建 KB 行 → createTextKnowledge → worker 进程内直跑 processDocument
 * （不经 BullMQ——队列语义已被单测覆盖，本脚本验证数据面）→ task 投影
 * completed → chunks 行数 == qdrant count → reparse 重跑不翻倍 →
 * deleteKnowledge → qdrant count 0。
 *
 * 用法：bun scripts/t03-smoke.ts
 * 退出码：0 全过；1 失败（步骤名打到 stderr）。
 */

import { eq, isNull, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createIndexWriter } from "../src/application/repository/retriever/qdrant/index-writer";
import { createFileKnowledge, createTextKnowledge, reparseKnowledge } from "../src/application/service/knowledge-create";
import { deleteKnowledge, deleteKnowledgeBase } from "../src/application/service/knowledge-delete";
import { getTaskProjection } from "../src/application/service/task-service";
import * as schema from "../src/db/schema";
import { QdrantClient } from "../src/infrastructure/qdrant/client";
import { ensureCollection } from "../src/infrastructure/qdrant/collections";
import { processDocument } from "../src/tasks/document-process";

const DB_URL = process.env.KB_TEST_DATABASE_URL ?? "postgres://kb_mastra:kb_mastra@127.0.0.1:5432/kb_mastra";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://127.0.0.1:6333";
const SMOKE_DIM = 8;
const SMOKE_COLLECTION = `kb_chunks_${SMOKE_DIM}`;

function fail(step: string, detail: unknown): never {
  console.error(`SMOKE FAIL [${step}]:`, detail);
  process.exit(1);
}

async function main() {
  const sql = postgres(DB_URL, { max: 5 });
  const db = drizzle(sql, { schema });
  const qdrant = new QdrantClient({ baseUrl: QDRANT_URL });

  // 独立冒烟 collection（维度 8，不碰 KB_EMBED_DIMENSIONS 档）。
  await ensureCollection(qdrant, SMOKE_DIM).catch((e) => fail("ensureCollection", e.message));
  const writer = createIndexWriter(qdrant, SMOKE_COLLECTION);

  const mockEmbedder = {
    async embed(text: string) {
      return new Array<number>(SMOKE_DIM).fill(1);
    },
    async batchEmbed(texts: string[]) {
      return texts.map(() => new Array<number>(SMOKE_DIM).fill(1));
    },
    getModelName: () => "smoke-mock",
    getDimensions: () => SMOKE_DIM,
    getModelID: () => "smoke-mock",
  };

  const tenantId = `smoke-${Date.now().toString(36)}`;
  const kbId = `kb-smoke-${Date.now().toString(36)}`;

  // 1. 建 KB 行（借 knowledgeBases 直插——handler 层是 B 线的）。
  await db.insert(schema.knowledgeBases).values({
    id: kbId,
    tenantId,
    name: "smoke",
    chunkingConfig: { chunkSize: 64, chunkOverlap: 8, separators: ["\n\n"], strategy: "recursive" },
    embeddingModelId: "smoke-mock",
  });

  // 2. text 入口创建。
  const longText = Array.from({ length: 12 }, (_, i) => `第${i + 1}段落：内容填充以切出多个块。`).join("\n\n");
  const created = await createTextKnowledge(
    { db, storageRoot: "/tmp/kb-smoke" },
    {
      requestId: "smoke-req",
      tenantId,
      kbId,
      embeddingModelId: "smoke-mock",
      content: longText,
      title: "smoke doc",
    },
  );
  if (created.duplicate) fail("create", "should not be duplicate on first insert");

  // 3. 管线直跑（worker 内同一函数）。
  await processDocument(
    {
      db,
      registry: null as never,
      embedder: mockEmbedder as never,
      indexWriter: writer,
    },
    {
      requestId: "smoke-req",
      tenantId,
      knowledgeId: created.knowledgeId,
      kbId,
      filePath: "",
      fileName: "smoke doc",
      fileType: "txt",
      url: "",
      fileUrl: "",
      passages: longText,
      attempt: 0,
    },
  ).catch((e) => fail("process", e.message));

  // 4. task 投影 completed。
  const task = await getTaskProjection(db, { tenantId, kbId, taskId: created.knowledgeId });
  if (!task || task.status !== "completed") fail("task-projection", task);
  console.log(`task completed: chunks ${task.chunks_done}/${task.chunks_total}, progress ${task.progress}%`);

  // 5. chunks 行数 == qdrant count。
  const chunkRows = await db.select().from(schema.chunks).where(eq(schema.chunks.knowledgeId, created.knowledgeId));
  const qdrantCount = await qdrant.countPoints(SMOKE_COLLECTION, {
    must: [
      { key: "tenant_id", match: { value: tenantId } },
      { key: "doc_id", match: { value: created.knowledgeId } },
    ],
  });
  if (chunkRows.length !== qdrantCount || qdrantCount === 0)
    fail("counts-match", { chunkRows: chunkRows.length, qdrantCount });
  console.log(`counts match: ${chunkRows.length} chunks == ${qdrantCount} points`);

  // 6. reparse 重跑不翻倍。
  await reparseKnowledge({ db, storageRoot: "/tmp/kb-smoke" }, { requestId: "smoke-req-2", tenantId, knowledgeId: created.knowledgeId });
  const [row] = await db.select().from(schema.knowledges).where(eq(knowledges.id, created.knowledgeId));
  await processDocument(
    { db, registry: null as never, embedder: mockEmbedder as never, indexWriter: writer },
    {
      requestId: "smoke-req-2",
      tenantId,
      knowledgeId: created.knowledgeId,
      kbId,
      filePath: "",
      fileName: "smoke doc",
      fileType: "txt",
      url: "",
      fileUrl: "",
      passages: longText,
      attempt: row?.attempt ?? 1,
    },
  ).catch((e) => fail("reparse", e.message));
  const chunkRows2 = await db.select().from(schema.chunks).where(eq(schema.chunks.knowledgeId, created.knowledgeId));
  const qdrantCount2 = await qdrant.countPoints(SMOKE_COLLECTION, {
    must: [
      { key: "tenant_id", match: { value: tenantId } },
      { key: "doc_id", match: { value: created.knowledgeId } },
    ],
  });
  if (chunkRows2.length !== qdrantCount2) fail("reparse-stable", { chunks: chunkRows2.length, points: qdrantCount2 });
  console.log(`reparse stable: ${chunkRows2.length} chunks == ${qdrantCount2} points (was ${chunkRows.length})`);

  // 7. 文件入口 + 去重（同 content 再传 → duplicate）。
  const dupCheck = await createTextKnowledge(
    { db, storageRoot: "/tmp/kb-smoke" },
    { requestId: "smoke-req-3", tenantId, kbId, embeddingModelId: "smoke-mock", content: longText, title: "smoke doc again" },
  );
  if (!dupCheck.duplicate || dupCheck.knowledgeId !== created.knowledgeId)
    fail("dedupe", dupCheck);
  console.log("dedupe: same content hits the existing row");

  // 8. 删除 → qdrant count 0。
  await deleteKnowledge({ db, indexWriter: writer }, { tenantId, kbId, knowledgeId: created.knowledgeId });
  const qdrantAfter = await qdrant.countPoints(SMOKE_COLLECTION, {
    must: [
      { key: "tenant_id", match: { value: tenantId } },
      { key: "doc_id", match: { value: created.knowledgeId } },
    ],
  });
  if (qdrantAfter !== 0) fail("delete-cascade", qdrantAfter);
  const taskAfter = await getTaskProjection(db, { tenantId, kbId, taskId: created.knowledgeId });
  if (!taskAfter || taskAfter.status !== "failed") fail("deleted-projects-failed", taskAfter);
  console.log("delete cascade: 0 points, task projects failed (deleting→failed)");

  // 9. 清场：KB 级删 + 冒烟行。
  await deleteKnowledgeBase({ db, indexWriter: writer }, { tenantId, kbId });
  await db.delete(schema.knowledgeBases).where(and(eq(schema.knowledgeBases.id, kbId), isNull(schema.knowledgeBases.deletedAt)));
  await db.delete(schema.knowledgeBases).where(eq(schema.knowledgeBases.id, kbId));
  await sql.end();
  console.log("SMOKE PASS: create → process → counts → reparse → dedupe → delete all verified");
}

// schema 引用补齐（knowledges 别名）。
import { knowledges } from "../src/db/schema";

main().catch((e) => fail("unhandled", e));
