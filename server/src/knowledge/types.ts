/**
 * KB-Service 的领域类型。
 *
 * 字段名与 kb-service（internal/model/model.go）的 JSON 标签一一对应，
 * 这里是 Server 进程与上游交互时使用的镜像，避免在 routes/client 里散落
 * 未经约束的 `any`。
 */

export type ParseStatus = "pending" | "processing" | "completed" | "failed";

export type KnowledgeBase = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  embedder: string;
  chunk_size: number;
  chunk_overlap: number;
  rerank_model?: string;
  doc_count: number;
  created_at: string;
  updated_at: string;
};

export type KnowledgeDocument = {
  id: string;
  kb_id: string;
  tenant_id: string;
  title: string;
  source: "file" | "url" | "text";
  file_name?: string;
  file_type?: string;
  parse_status: ParseStatus;
  chunk_count: number;
  metadata?: Record<string, string>;
  created_at: string;
  updated_at: string;
};

export type KnowledgeTask = {
  task_id: string;
  kb_id: string;
  doc_id: string;
  status: ParseStatus;
  progress: number;
  chunks_done: number;
  chunks_total: number;
  error?: string;
  created_at: string;
};

export type KnowledgeSearchResult = {
  chunk_id: string;
  doc_id: string;
  content: string;
  score: number;
  source: string;
  metadata?: Record<string, string>;
};

/** 列表端点统一用 `{ items, count }` 包裹。 */
export type ListEnvelope<T> = { items: T[]; count: number };

export type RetrieveResponse = {
  results: KnowledgeSearchResult[];
  count: number;
};
