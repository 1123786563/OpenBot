/**
 * 元数据四表（修订 R1：embeddings 表不存在，Qdrant 是唯一向量真源）。
 *
 * WeKnora 五表的一对一翻译（裁剪 RBAC/分享/多模态列）：knowledge_bases /
 * knowledges / chunks / chunk_revisions。列名与语义对齐 WeKnora GORM 模型
 * （internal/types/{knowledgebase,knowledge,chunk}.go）；Drizzle 侧 snake_case
 * 列名即 WeKnora 的列名，迁移可对照。
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/** WeKnora ChunkingConfig 的 P1 投影：strategy 五档 + 尺寸参数。 */
export type ChunkingConfig = {
  chunkSize: number;
  chunkOverlap: number;
  separators: string[];
  strategy: "auto" | "heading" | "heuristic" | "recursive" | "legacy";
};

/** 摄取进度（task 投影的回写源；§5.2 progress jsonb）。 */
export type IngestProgress = {
  chunksTotal: number;
  chunksDone: number;
  /** 最近一次阶段名（parse/embed/index…），前端可显示在 processing 详情。 */
  stage: string;
  updatedAt: string;
};

/** 索引策略（WeKnora indexing_strategy；P1 恒 vector 单通道，字段保留）。 */
export type IndexingStrategy = {
  channels: ("vector" | "keywords")[];
};

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull().default(""),
    /** WeKnora chunking_config JSONB——保留原结构以便 P2 平移高级配置。 */
    chunkingConfig: jsonb("chunking_config").$type<ChunkingConfig>().notNull(),
    indexingStrategy: jsonb("indexing_strategy")
      .$type<IndexingStrategy>()
      .notNull()
      .default({ channels: ["vector"] }),
    /** 创建后不可改（service 层守卫；换模型=新 collection 全量重嵌，R-Q1）。 */
    embeddingModelId: varchar("embedding_model_id", { length: 128 }).notNull(),
    /** 向量库归属（P1 恒 qdrant collection 名 kb_chunks_{dim}）。 */
    vectorStoreId: varchar("vector_store_id", { length: 128 }),
    rerankModel: varchar("rerank_model", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_knowledge_bases_tenant").on(table.tenantId),
    // 软删下的租户内唯一名：deleted_at IS NULL 的行才参与约束。
    uniqueIndex("uq_knowledge_bases_name_tenant_active")
      .on(table.tenantId, table.name)
      .where(sql`deleted_at IS NULL`),
  ],
);

/** 内部解析状态全保真 7 态（§6.3：对外投影为 OpenBot 的 4 态）。 */
export const PARSE_STATUSES = [
  "pending",
  "processing",
  "finalizing",
  "completed",
  "failed",
  "deleting",
  "cancelled",
] as const;
export type ParseStatusInternal = (typeof PARSE_STATUSES)[number];

/** knowledges = WeKnora 的 Knowledge 表（文档行）。 */
export const knowledges = pgTable(
  "knowledges",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 36 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    /** WeKnora type：file | url | manual（faq 裁剪）；对外 wire source 做映射。 */
    type: varchar("type", { length: 32 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    description: text("description").notNull().default(""),
    /** url 型 = 抓取地址；manual 型 = "manual"（对齐 WeKnora Source 列语义）。 */
    source: varchar("source", { length: 2048 }).notNull().default(""),
    channel: varchar("channel", { length: 50 }).notNull().default("web"),
    parseStatus: varchar("parse_status", { length: 32 })
      .$type<ParseStatusInternal>()
      .notNull()
      .default("pending"),
    pendingSubtasksCount: integer("pending_subtasks_count")
      .notNull()
      .default(0),
    enableStatus: varchar("enable_status", { length: 32 })
      .notNull()
      .default("enabled"),
    embeddingModelId: varchar("embedding_model_id", { length: 128 }).notNull(),
    fileName: varchar("file_name", { length: 512 }).notNull().default(""),
    fileType: varchar("file_type", { length: 64 }).notNull().default(""),
    fileSize: bigint("file_size", { mode: "number" }).notNull().default(0),
    /** SHA256（tenant+kb+hash 唯一 → 上传去重键）。 */
    fileHash: varchar("file_hash", { length: 64 }),
    filePath: varchar("file_path", { length: 1024 }).notNull().default(""),
    storageSize: bigint("storage_size", { mode: "number" })
      .notNull()
      .default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    customMetadata: jsonb("custom_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** 摄取管线进度回写（task 投影的 chunks_done/total 来源）。 */
    progress: jsonb("progress").$type<IngestProgress>(),
    /** reparse 世代号：payload 携带的 attempt 与 DB 不等则跳过（幂等核心）。 */
    attempt: integer("attempt").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorMessage: text("error_message").notNull().default(""),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_knowledges_tenant_kb").on(table.tenantId, table.knowledgeBaseId),
    index("idx_knowledges_status").on(table.parseStatus),
    // 上传去重：同租户同库同 hash 的活文档只允许一份。
    uniqueIndex("uq_knowledges_file_hash_active")
      .on(table.tenantId, table.knowledgeBaseId, table.fileHash)
      .where(sql`deleted_at IS NULL AND file_hash IS NOT NULL`),
  ],
);

/** chunk_type：P1 只写 text 与 parent_text（枚举值保留对齐 WeKnora）。 */
export const CHUNK_TYPES = [
  "text",
  "parent_text",
  "image",
  "table",
  "faq",
  "summary",
  "entity",
  "relation",
] as const;
export type ChunkType = (typeof CHUNK_TYPES)[number];

/** WeKnora SourceLocator（JSON 数组存 jsonb）：pdf page/bbox 归一化坐标等。 */
export type SourceLocator = {
  type: string;
  page?: number;
  bbox?: [number, number, number, number];
  [key: string]: unknown;
};

export const chunks = pgTable(
  "chunks",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    knowledgeId: varchar("knowledge_id", { length: 36 })
      .notNull()
      .references(() => knowledges.id, { onDelete: "cascade" }),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 36 }).notNull(),
    tagId: varchar("tag_id", { length: 36 }),
    content: text("content").notNull(),
    /** 解析器原始输出（首编辑前的不可变副本）。 */
    sourceContent: text("source_content").notNull().default(""),
    /** 每次用户编辑/回滚 +1。 */
    contentRevision: integer("content_revision").notNull().default(0),
    indexStatus: varchar("index_status", { length: 16 })
      .notNull()
      .default("ready"),
    lastEditorId: varchar("last_editor_id", { length: 64 })
      .notNull()
      .default(""),
    chunkIndex: integer("chunk_index").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    flags: integer("flags").notNull().default(1),
    status: integer("status").notNull().default(0),
    /** 不变量：endAt - startAt == rune 计数的 content 长度（validator 校验）。 */
    startAt: integer("start_at").notNull().default(0),
    endAt: integer("end_at").notNull().default(0),
    preChunkId: varchar("pre_chunk_id", { length: 36 }).notNull().default(""),
    nextChunkId: varchar("next_chunk_id", { length: 36 }).notNull().default(""),
    chunkType: varchar("chunk_type", { length: 20 })
      .$type<ChunkType>()
      .notNull()
      .default("text"),
    parentChunkId: varchar("parent_chunk_id", { length: 36 }),
    relationChunks: jsonb("relation_chunks").$type<string[]>(),
    indirectRelationChunks: jsonb("indirect_relation_chunks").$type<string[]>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    contentHash: varchar("content_hash", { length: 64 }).notNull().default(""),
    imageInfo: text("image_info"),
    /** 索引时的标题面包屑（重建索引输入保真）。 */
    contextHeader: text("context_header").notNull().default(""),
    sourceLocators: jsonb("source_locators").$type<SourceLocator[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_chunks_tenant_kb").on(table.tenantId, table.knowledgeBaseId),
    index("idx_chunks_knowledge").on(table.knowledgeId),
    index("idx_chunks_parent").on(table.parentChunkId),
  ],
);

/** 不可变修订历史，仅追加（WeKnora ChunkRevision 一对一）。 */
export const chunkRevisions = pgTable(
  "chunk_revisions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 36 }).notNull(),
    knowledgeId: varchar("knowledge_id", { length: 36 }).notNull(),
    chunkId: varchar("chunk_id", { length: 36 }).notNull(),
    revision: integer("revision").notNull(),
    content: text("content").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    editorId: varchar("editor_id", { length: 64 }).notNull().default(""),
    editSource: varchar("edit_source", { length: 16 }).notNull().default(""),
    editedAt: timestamp("edited_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // WeKnora idx_chunk_revision：(chunk_id, revision) 唯一。
    unique("uq_chunk_revisions_chunk_revision").on(
      table.chunkId,
      table.revision,
    ),
    index("idx_chunk_revisions_knowledge").on(table.knowledgeId),
  ],
);
