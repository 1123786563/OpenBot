/**
 * 文档三入口创建（WeKnora knowledge_process 的 CreateKnowledge 三入口对应物）：
 * multipart file / url / text(manual)。类型白名单 → SHA256 去重（partial
 * unique 兜底）→ local 存储 → knowledges 行 pending → BullMQ enqueue。
 *
 * 配额检查 P1 跳过（TODO 位保留）。handler 层（B 线）解析 HTTP，本层只接
 * 已归一化的输入。
 */

import { and, eq, isNull } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getLogger } from "../../../../shared/logger";
import type { Db } from "../../db/client";
import { knowledges } from "../../db/schema";
import { enqueueDocumentProcess } from "../../tasks/queue";

const log = getLogger("kb-mastra");

/** WeKnora isValidFileType 的 P1 白名单（simple 四类 + docreader 全家桶）。 */
export const ALLOWED_FILE_EXTENSIONS = [
  "md",
  "txt",
  "csv",
  "json",
  "pdf",
  "docx",
  "doc",
  "pptx",
  "xlsx",
  "html",
  "htm",
  "epub",
] as const;

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

/** 409 语义：同租户同库同 hash 的活文档已存在（kb-service 无此语义，v1 设计保留）。 */
export class DuplicateDocumentError extends Error {
  readonly existingId: string;
  constructor(existingId: string) {
    super("an identical document already exists in this knowledge base");
    this.name = "DuplicateDocumentError";
    this.existingId = existingId;
  }
}

export type CreateResult = {
  knowledgeId: string;
  /** 是否命中去重（true 时 knowledgeId 是既有行，未入队）。 */
  duplicate: boolean;
};

export type CreateDeps = {
  db: Db;
  /** local 存储根（STORAGE_LOCAL_PATH）。 */
  storageRoot: string;
  /** 覆盖默认存储路径（测试注入内存态）。 */
  storeFile?: (kbId: string, knowledgeId: string, bytes: Uint8Array, fileName: string) => Promise<string>;
};

/** 默认存储：{root}/{kbId}/{knowledgeId}/{fileName}，返回绝对路径。 */
async function defaultStoreFile(
  root: string,
  kbId: string,
  knowledgeId: string,
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  const dir = join(root, kbId, knowledgeId);
  await mkdir(dir, { recursive: true });
  const safe = fileName.replace(/[/\\]/g, "_");
  const path = join(dir, safe);
  await writeFile(path, bytes);
  return path;
}

/** file 入口：multipart 的已读字节。 */
export async function createFileKnowledge(
  deps: CreateDeps,
  input: {
    requestId: string;
    tenantId: string;
    kbId: string;
    embeddingModelId: string;
    fileName: string;
    title?: string;
    fileContent: Uint8Array;
  },
): Promise<CreateResult> {
  const ext = extensionOf(input.fileName);
  if (!ALLOWED_FILE_EXTENSIONS.includes(ext as (typeof ALLOWED_FILE_EXTENSIONS)[number])) {
    throw new Error(`file type .${ext} is not allowed`);
  }

  const fileHash = createHash("sha256").update(input.fileContent).digest("hex");

  // SHA256 去重（tenant+kb+file_hash 的活行）。
  const [existing] = await deps.db
    .select({ id: knowledges.id })
    .from(knowledges)
    .where(
      and(
        eq(knowledges.tenantId, input.tenantId),
        eq(knowledges.knowledgeBaseId, input.kbId),
        eq(knowledges.fileHash, fileHash),
        isNull(knowledges.deletedAt),
      ),
    )
    .limit(1);
  if (existing) {
    log.info(
      { type: "kb-ingest-duplicate", knowledgeId: existing.id, kbId: input.kbId },
      "kb-ingest-duplicate",
    );
    return { knowledgeId: existing.id, duplicate: true };
  }

  const knowledgeId = randomUUID();
  const store = deps.storeFile ?? defaultStoreFile.bind(null, deps.storageRoot);
  const filePath = await store(
    input.kbId,
    knowledgeId,
    input.fileContent,
    input.fileName,
  );

  await deps.db.insert(knowledges).values({
    id: knowledgeId,
    tenantId: input.tenantId,
    knowledgeBaseId: input.kbId,
    type: "file",
    title: input.title?.trim() || input.fileName,
    source: "file",
    parseStatus: "pending",
    embeddingModelId: input.embeddingModelId,
    fileName: input.fileName,
    fileType: ext,
    fileSize: input.fileContent.byteLength,
    fileHash,
    filePath,
    storageSize: input.fileContent.byteLength,
    attempt: 0,
  });

  await enqueueDocumentProcess({
    requestId: input.requestId,
    tenantId: input.tenantId,
    knowledgeId,
    kbId: input.kbId,
    filePath,
    fileName: input.fileName,
    fileType: ext,
    url: "",
    fileUrl: "",
    passages: "",
    attempt: 0,
  });
  return { knowledgeId, duplicate: false };
}

/** url 入口：抓取在 worker 侧做（parser.parseURL），这里只落行+入队。 */
export async function createUrlKnowledge(
  deps: CreateDeps,
  input: {
    requestId: string;
    tenantId: string;
    kbId: string;
    embeddingModelId: string;
    url: string;
    title?: string;
  },
): Promise<CreateResult> {
  const knowledgeId = randomUUID();
  await deps.db.insert(knowledges).values({
    id: knowledgeId,
    tenantId: input.tenantId,
    knowledgeBaseId: input.kbId,
    type: "url",
    title: input.title?.trim() || input.url,
    source: input.url,
    parseStatus: "pending",
    embeddingModelId: input.embeddingModelId,
    fileType: "html",
    attempt: 0,
  });

  await enqueueDocumentProcess({
    requestId: input.requestId,
    tenantId: input.tenantId,
    knowledgeId,
    kbId: input.kbId,
    filePath: "",
    fileName: input.title?.trim() || input.url,
    fileType: "html",
    url: input.url,
    fileUrl: "",
    passages: "",
    attempt: 0,
  });
  return { knowledgeId, duplicate: false };
}

/** text/manual 入口：直传内容，worker 跳过解析直接切分。 */
export async function createTextKnowledge(
  deps: CreateDeps,
  input: {
    requestId: string;
    tenantId: string;
    kbId: string;
    embeddingModelId: string;
    content: string;
    title?: string;
  },
): Promise<CreateResult> {
  const knowledgeId = randomUUID();
  const fileHash = createHash("sha256").update(input.content).digest("hex");

  const [existing] = await deps.db
    .select({ id: knowledges.id })
    .from(knowledges)
    .where(
      and(
        eq(knowledges.tenantId, input.tenantId),
        eq(knowledges.knowledgeBaseId, input.kbId),
        eq(knowledges.fileHash, fileHash),
        isNull(knowledges.deletedAt),
      ),
    )
    .limit(1);
  if (existing) return { knowledgeId: existing.id, duplicate: true };

  await deps.db.insert(knowledges).values({
    id: knowledgeId,
    tenantId: input.tenantId,
    knowledgeBaseId: input.kbId,
    type: "manual",
    title: input.title?.trim() || "Untitled",
    source: "manual",
    parseStatus: "pending",
    embeddingModelId: input.embeddingModelId,
    fileType: "txt",
    fileSize: Buffer.byteLength(input.content),
    fileHash,
    attempt: 0,
  });

  await enqueueDocumentProcess({
    requestId: input.requestId,
    tenantId: input.tenantId,
    knowledgeId,
    kbId: input.kbId,
    filePath: "",
    fileName: input.title?.trim() || "text",
    fileType: "txt",
    url: "",
    fileUrl: "",
    passages: input.content,
    attempt: 0,
  });
  return { knowledgeId, duplicate: false };
}

/**
 * reparse（P1 预留）：attempt+1 世代号后重新入队。worker 守卫会跳过携带旧
 * attempt 的在途 job（attemptSuperseded）。
 */
export async function reparseKnowledge(
  deps: CreateDeps,
  input: { requestId: string; tenantId: string; knowledgeId: string },
): Promise<boolean> {
  const [row] = await deps.db
    .select()
    .from(knowledges)
    .where(eq(knowledges.id, input.knowledgeId))
    .limit(1);
  if (!row || row.tenantId !== input.tenantId) return false;
  const attempt = row.attempt + 1;
  await deps.db
    .update(knowledges)
    .set({ attempt, parseStatus: "pending", errorMessage: "", updatedAt: new Date() })
    .where(eq(knowledges.id, input.knowledgeId));
  await enqueueDocumentProcess({
    requestId: input.requestId,
    tenantId: input.tenantId,
    knowledgeId: row.id,
    kbId: row.knowledgeBaseId,
    filePath: row.filePath,
    fileName: row.fileName,
    fileType: row.fileType,
    url: row.type === "url" ? row.source : "",
    fileUrl: "",
    passages: row.type === "manual" ? "" : "",
    attempt,
  });
  return true;
}
