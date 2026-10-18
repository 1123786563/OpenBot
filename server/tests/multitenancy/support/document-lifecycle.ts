// server/tests/multitenancy/support/document-lifecycle.ts
// MT038（Issue #81）共享夹具：文档上传、删除、导入与重解析的作用域。
//
// 契约：主库（企业测试库）+ KB 专用测试库缺一整套显式 skip，绝不回退开发库、
// skipped 不计通过。只读消费既有交付（MT036 夹具/镜像表、MT008 身份矩阵、
// 冻结 kb 任务管线类型），零改动。
//
// 本票新增：
//   - knowledges/chunks/chunk_revisions 种子（KB 库直插——KB 域无 RLS，
//     MT036 D3 同款披露：隔离由应用层受限入口承载）；
//   - 镜像破坏器（删镜像行 / 租户漂移）——执行时重建的拒绝面演示；
//   - storeFile / enqueue / index-writer / embedder 记录器（调用序与
//     归属断言的证据面；测试内无真实 Redis/Qdrant/embedder 依赖）。

import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, like } from "drizzle-orm";
import type {
  ChunkPointInput,
  IndexWriter,
} from "../../../src/kb/application/repository/retriever/qdrant/index-writer";
import type { Db as KbDb } from "../../../src/kb/db/client";
import { knowledgeBaseOwnershipStates } from "../../../src/kb/db/ownership-schema";
import {
  chunkRevisions,
  chunks,
  knowledges,
  type ParseStatusInternal,
} from "../../../src/kb/db/schema";
import type { DocumentProcessPayload } from "../../../src/kb/tasks/queue";
import {
  createKbOwnershipFixture,
  type KbOwnershipFixture,
  probeKbOwnershipEnvironment,
} from "./kb-ownership";
import type { TeamKey } from "./resource-policy";

export type { KbOwnershipFixture };
export { probeKbOwnershipEnvironment as probeDocumentLifecycleEnvironment };

/** 入队记录器载荷（发起归属字段在运行时随行，类型面为既有 payload 的扩展）。 */
export type RecordedScopedPayload = DocumentProcessPayload & {
  readonly initiatingWorkspaceId?: unknown;
  readonly initiatingPrincipalId?: unknown;
};

/** 记录型 storeFile：虚拟路径（零磁盘依赖），字节可回读断言。 */
export interface StoredFileRecord {
  readonly path: string;
  readonly kbId: string;
  readonly knowledgeId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/**
 * 记录型 storeFile：真实临时文件（执行侧重建用例可被 worker 真实读取）+
 * 字节记录（归属断言）。
 */
export function createRecordingStore(rootDir: string) {
  const stored: StoredFileRecord[] = [];
  const storeFile = async (
    kbId: string,
    knowledgeId: string,
    bytes: Uint8Array,
    fileName: string,
  ): Promise<string> => {
    const dir = join(rootDir, kbId, knowledgeId);
    await mkdir(dir, { recursive: true });
    const safe = fileName.replace(/[/\\]/g, "_");
    const path = join(dir, safe);
    await writeFile(path, bytes);
    stored.push({ path, kbId, knowledgeId, fileName, bytes });
    return path;
  };
  return { storeFile, stored };
}

/** 记录型 index-writer：调用序（删除顺序铁律证据）+ upsert 点位（归属证据）。 */
export function recordingIndexWriter() {
  const calls: string[] = [];
  const points: ChunkPointInput[] = [];
  const writer: IndexWriter = {
    async upsertChunks(inputs) {
      calls.push(`upsert:${inputs.length}`);
      points.push(...inputs);
    },
    async deleteByDoc(tenantId, docId) {
      calls.push(`deleteDoc:${tenantId}:${docId}`);
    },
    async deleteByKb(tenantId, kbId) {
      calls.push(`deleteKb:${tenantId}:${kbId}`);
    },
  };
  return { writer, calls, points };
}

/** 确定性 mock embedder（冻结 document-process.test.ts 同款习惯用法）。 */
export function mockEmbedder(dimensions = 8) {
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

export interface DocumentLifecycleFixture {
  readonly ent: KbOwnershipFixture["ent"];
  readonly kbDb: KbDb;
  readonly runId: string;
  /** 种子一个文档行（knowledges 直插），返回文档 id。 */
  seedDocument(input: {
    key: string;
    kbId: string;
    tenantId: string;
    type?: "file" | "url" | "manual";
    title?: string;
    parseStatus?: ParseStatusInternal;
    attempt?: number;
    filePath?: string;
    fileName?: string;
    fileType?: string;
    source?: string;
    fileHash?: string;
  }): Promise<string>;
  /** 种子 chunks + chunk_revisions 首版，返回 chunk id 列表。 */
  seedChunks(input: {
    docId: string;
    kbId: string;
    tenantId: string;
    contents: readonly string[];
  }): Promise<string[]>;
  /** 镜像行删除（执行时重建的「缺失」演示面）。 */
  deleteMirrorRow(input: { kbId: string }): Promise<void>;
  /** 镜像行租户漂移（执行时重建的「不一致」演示面）。 */
  corruptMirrorTenant(input: { kbId: string; tenantId: string }): Promise<void>;
  /** 软删一个文档行（生命周期演示面）。 */
  softDeleteDocument(input: { docId: string }): Promise<void>;
  // —— MT036 夹具的透传（只读消费）——
  seedKnowledgeBase: KbOwnershipFixture["seedKnowledgeBase"];
  moveKnowledgeBaseOwnership: KbOwnershipFixture["moveKnowledgeBaseOwnership"];
  bumpRegistrationRevision: KbOwnershipFixture["bumpRegistrationRevision"];
  syncKbOwnershipState: KbOwnershipFixture["syncKbOwnershipState"];
  setTenantPolicyRevision: KbOwnershipFixture["setTenantPolicyRevision"];
  dispose(): Promise<void>;
}

export async function createDocumentLifecycleFixture(): Promise<DocumentLifecycleFixture> {
  const base = await createKbOwnershipFixture();
  const runId = `mt038-${randomUUID().slice(0, 8)}`;
  const kbDb = base.kbDb;
  const fixture: DocumentLifecycleFixture = {
    ent: base.ent,
    kbDb,
    runId,

    async seedDocument({
      key,
      kbId,
      tenantId,
      type = "manual",
      title,
      parseStatus = "pending",
      attempt = 0,
      filePath = "",
      fileName = "",
      fileType = "",
      source = "",
      fileHash = null,
    }) {
      const docId = `${runId}-${key}`.slice(0, 36);
      await kbDb.insert(knowledges).values({
        id: docId,
        tenantId,
        knowledgeBaseId: kbId,
        type,
        title: title ?? `doc-${key}`,
        source,
        parseStatus,
        embeddingModelId: "mt038-test-embedder",
        fileName,
        fileType,
        filePath,
        fileHash,
        attempt,
      });
      return docId;
    },

    async seedChunks({ docId, kbId, tenantId, contents }) {
      const ids: string[] = [];
      const rows = contents.map((content, index) => ({
        id: `${runId}-c${index}-${randomUUID().slice(0, 6)}`.slice(0, 36),
        tenantId,
        knowledgeId: docId,
        knowledgeBaseId: kbId,
        content,
        sourceContent: content,
        contentRevision: 0,
        chunkIndex: index,
        chunkType: "text" as const,
        contentHash: createHash("sha256").update(content).digest("hex"),
      }));
      for (let i = 0; i < rows.length; i += 1) {
        if (i > 0) rows[i]!.preChunkId = rows[i - 1]!.id;
        if (i < rows.length - 1) rows[i]!.nextChunkId = rows[i + 1]!.id;
      }
      await kbDb.insert(chunks).values(rows);
      await kbDb.insert(chunkRevisions).values(
        rows.map((row) => ({
          id: randomUUID().slice(0, 36),
          tenantId: row.tenantId,
          knowledgeBaseId: row.knowledgeBaseId,
          knowledgeId: row.knowledgeId,
          chunkId: row.id,
          revision: 0,
          content: row.content,
          isEnabled: true,
          editorId: "ingest",
          editSource: "ingest",
        })),
      );
      for (const row of rows) ids.push(row.id);
      return ids;
    },

    async deleteMirrorRow({ kbId }) {
      await kbDb
        .delete(knowledgeBaseOwnershipStates)
        .where(eq(knowledgeBaseOwnershipStates.knowledgeBaseId, kbId));
    },

    async corruptMirrorTenant({ kbId, tenantId }) {
      await kbDb
        .update(knowledgeBaseOwnershipStates)
        .set({ tenantId, updatedAt: new Date() })
        .where(eq(knowledgeBaseOwnershipStates.knowledgeBaseId, kbId));
    },

    async softDeleteDocument({ docId }) {
      await kbDb
        .update(knowledges)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(knowledges.id, docId));
    },

    seedKnowledgeBase: base.seedKnowledgeBase,
    moveKnowledgeBaseOwnership: base.moveKnowledgeBaseOwnership,
    bumpRegistrationRevision: base.bumpRegistrationRevision,
    syncKbOwnershipState: base.syncKbOwnershipState,
    setTenantPolicyRevision: base.setTenantPolicyRevision,

    async dispose() {
      // MT036 夹具的 dispose 按 runId 前缀清镜像行与 KB 行（FK cascade
      // 跟随清除 knowledges/chunks/chunk_revisions）；残留文档行按前缀兜底。
      await kbDb.delete(knowledges).where(like(knowledges.id, `${runId}-%`));
      await base.dispose();
    },
  };
  return fixture;
}

export type { TeamKey };
export { createHash };
