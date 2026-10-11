import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * 知识库（KB-Service）的前端客户端。
 *
 * 前端只和 OpenBot 自己的 `/api/knowledge/*` 说话，服务端再以 API Key 转发到
 * KB-Service。这里的类型字段名沿用 KB-Service 的 JSON wire format（snake_case），
 * 与 `server/src/knowledge/types.ts` 一致——它们是外部服务契约，而非本应用的
 * 领域命名，故不在此处做字段改写。
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

export type ListEnvelope<T> = { items: T[]; count: number };
export type RetrieveResponse = {
  results: KnowledgeSearchResult[];
  count: number;
};

export const knowledgeKeys = {
  all: ["knowledge"] as const,
  bases: ["knowledge", "bases"] as const,
  base: (id: string) => ["knowledge", "base", id] as const,
  documents: (kbId: string) => ["knowledge", "documents", kbId] as const,
  task: (kbId: string, taskId: string) =>
    ["knowledge", "task", kbId, taskId] as const,
};

/** 读取 JSON 响应体（`client` 不带 key 时返回已确认 2xx 的 Response）。 */
async function getJSON<T>(path: string): Promise<T> {
  const response = await client(path);
  return (await response.json()) as T;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const response = await client(path, {
    method: "POST",
    body,
    fallback: "The knowledge service failed.",
  });
  return (await response.json()) as T;
}

async function deleteJSON(path: string): Promise<{ deleted: boolean }> {
  const response = await client(path, {
    method: "DELETE",
    fallback: "The knowledge service failed.",
  });
  return (await response.json()) as { deleted: boolean };
}

// ---- 查询 ----

export const knowledgeBasesQueryOptions = () =>
  queryOptions({
    queryKey: knowledgeKeys.bases,
    queryFn: (): Promise<ListEnvelope<KnowledgeBase>> =>
      getJSON("/api/knowledge/kb"),
  });

export const knowledgeBaseQueryOptions = (id: string) =>
  queryOptions({
    queryKey: knowledgeKeys.base(id),
    queryFn: (): Promise<KnowledgeBase> =>
      getJSON(`/api/knowledge/kb/${encodeURIComponent(id)}`),
  });

export const documentsQueryOptions = (kbId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.documents(kbId),
    queryFn: (): Promise<ListEnvelope<KnowledgeDocument>> =>
      getJSON(`/api/knowledge/kb/${encodeURIComponent(kbId)}/documents`),
  });

export const taskQueryOptions = (kbId: string, taskId: string) =>
  queryOptions({
    queryKey: knowledgeKeys.task(kbId, taskId),
    queryFn: (): Promise<KnowledgeTask> =>
      getJSON(
        `/api/knowledge/kb/${encodeURIComponent(kbId)}/tasks/${encodeURIComponent(taskId)}`,
      ),
  });

// ---- 变更 ----

export type CreateKnowledgeBaseInput = {
  name: string;
  description?: string;
  embedder?: string;
  chunk_size?: number;
  chunk_overlap?: number;
  rerank_model?: string;
};

export const createKnowledgeBase = (input: CreateKnowledgeBaseInput) =>
  postJSON<KnowledgeBase>("/api/knowledge/kb", input);

export const deleteKnowledgeBase = (id: string) =>
  deleteJSON(`/api/knowledge/kb/${encodeURIComponent(id)}`);

export type AddDocumentInput = {
  type: "url" | "text";
  title?: string;
  content?: string;
  url?: string;
};

export type AddDocumentResult = { task_id: string; doc_id: string };

export const addDocument = (kbId: string, input: AddDocumentInput) =>
  postJSON<AddDocumentResult>(
    `/api/knowledge/kb/${encodeURIComponent(kbId)}/documents`,
    input,
  );

export const deleteDocument = (kbId: string, docId: string) =>
  deleteJSON(
    `/api/knowledge/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
  );

export type RetrieveInput = {
  query: string;
  top_k?: number;
  score_threshold?: number;
  hybrid?: boolean;
};

export const retrieve = (kbId: string, input: RetrieveInput) =>
  postJSON<RetrieveResponse>(
    `/api/knowledge/kb/${encodeURIComponent(kbId)}/retrieve`,
    input,
  );

/**
 * 文件上传走原生 `fetch` + `FormData`，因为 `client` 只处理 JSON body。
 * 仍然是同源请求，`credentials: "include"` 带上 better-auth 的 session cookie。
 */
export async function uploadDocumentFile(
  kbId: string,
  file: File,
): Promise<AddDocumentResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(
    `/api/knowledge/kb/${encodeURIComponent(kbId)}/documents`,
    { method: "POST", credentials: "include", body: form },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : "Could not upload the document.",
    );
  }
  return (await response.json()) as AddDocumentResult;
}
