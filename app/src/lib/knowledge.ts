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
    fallbackKey: "knowledge.service",
  });
  return (await response.json()) as T;
}

async function deleteJSON(path: string): Promise<{ deleted: boolean }> {
  const response = await client(path, {
    method: "DELETE",
    fallbackKey: "knowledge.service",
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

/** 单份文档（后端 GET documents/:docId 已有，这里补上前端封装）。 */
export const documentQueryOptions = (kbId: string, docId: string) =>
  queryOptions({
    queryKey: ["knowledge", "document", kbId, docId] as const,
    queryFn: (): Promise<KnowledgeDocument> =>
      getJSON(
        `/api/knowledge/kb/${encodeURIComponent(kbId)}/documents/${encodeURIComponent(docId)}`,
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

/** 文档列表的客户端筛选条件（上游列表接口不支持查询参数，全部在本地过滤）。 */
export type KnowledgeDocumentFilter = {
  /** 匹配 title/file_name 的不区分大小写子串。 */
  keyword: string;
  /** 空串 = 不过滤。 */
  status: ParseStatus | "";
  /** 空串 = 不过滤。 */
  type: KnowledgeDocument["source"] | "";
};

export const emptyDocumentFilter: KnowledgeDocumentFilter = {
  keyword: "",
  status: "",
  type: "",
};

/**
 * 文件上传走原生 `XMLHttpRequest` + `FormData`：fetch 没有上传进度事件，
 * 而 `client` 只处理 JSON body。`xhr.upload.onprogress` 把 0..1 的进度比例交给
 * `onProgress`；`signal` 触发 `xhr.abort()`，与 AbortController 取消语义一致。
 * 仍然同源并 `withCredentials`，与其它请求同一 session。
 */
export function uploadDocumentFile(
  kbId: string,
  file: File,
  options?: {
    onProgress?: (ratio: number) => void;
    signal?: AbortSignal;
  },
): Promise<AddDocumentResult> {
  // 上游契约为 multipart 的 file + title（文件名）两个字段。
  const form = new FormData();
  form.append("file", file);
  form.append("title", file.name);

  return new Promise<AddDocumentResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/knowledge/kb/${encodeURIComponent(kbId)}/documents`);
    xhr.withCredentials = true;
    xhr.responseType = "json";

    const onProgress = options?.onProgress;
    if (onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0)
          onProgress(event.loaded / event.total);
      });
    }

    const onAbort = () => {
      cleanup();
      reject(new DOMException("The upload was aborted.", "AbortError"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Could not upload the document."));
    };
    const onLoad = () => {
      cleanup();
      const body = xhr.response as { error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response as AddDocumentResult);
        return;
      }
      reject(
        new Error(
          typeof body?.error === "string"
            ? body.error
            : "Could not upload the document.",
        ),
      );
    };
    const cleanup = () => {
      options?.signal?.removeEventListener("abort", onAbort);
      xhr.removeEventListener("abort", onAbort);
      xhr.removeEventListener("error", onError);
      xhr.removeEventListener("load", onLoad);
    };

    // 请求还没发出就已被取消：abort() 在 open 后是 no-op，直接拒绝。
    if (options?.signal?.aborted) {
      reject(new DOMException("The upload was aborted.", "AbortError"));
      return;
    }
    options?.signal?.addEventListener("abort", () => xhr.abort());
    xhr.addEventListener("abort", onAbort);
    xhr.addEventListener("error", onError);
    xhr.addEventListener("load", onLoad);
    xhr.send(form);
  });
}
