import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { UploadTasksPanel } from "@/components/knowledge/upload-tasks-panel";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AddDocumentInput,
  addDocument,
  deleteDocument,
  documentsQueryOptions,
  emptyDocumentFilter,
  type KnowledgeDocument,
  type KnowledgeDocumentFilter,
  type KnowledgeSearchResult,
  knowledgeBaseQueryOptions,
  knowledgeKeys,
  type ListEnvelope,
  type ParseStatus,
  retrieve,
  taskQueryOptions,
} from "@/lib/knowledge";
import { formatFileSize } from "@/lib/knowledge-format";
import {
  DEFAULT_DOCUMENT_SORT,
  type DocumentSortField,
  type DocumentSortValue,
  getDocumentSortOption,
  nextSortValue,
  sortDocuments,
} from "@/lib/knowledge-sorting";
import { relativeTime } from "@/lib/relative-time";
import { uploadCommands, useUploadTasksFor } from "@/lib/upload-queue/store";

export const Route = createFileRoute("/_authed/_app/knowledge/$kbId")({
  component: KnowledgeDetailPage,
});

const field = "grid min-w-0 gap-1 text-sm";
const select =
  "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

/** 关键字输入的 debounce：每次击键都重筛 500 行表格没有意义。 */
const KEYWORD_DEBOUNCE_MS = 300;
/** 存在非终态文档/活动 task 时的文档列表轮询间隔（无则停）。 */
const DOCS_POLL_MS = 5_000;
/** task 级进度轮询间隔。 */
const TASK_POLL_MS = 2_000;
/** 批量删除的上限：客户端循环单删，N 过大应改观感而不是静默慢。 */
const MAX_BULK_DELETE = 50;

function KnowledgeDetailPage() {
  const { t } = useTranslation("knowledge");
  const { kbId } = Route.useParams();
  const kb = useQuery(knowledgeBaseQueryOptions(kbId));

  return (
    <PageShell
      backButton={{ label: t("back"), linkProps: { to: "/knowledge" } }}
      title={kb.data?.name ?? t("back")}
      description={t("detail.description")}
      width="wide"
    >
      {kb.error ? (
        <p role="alert" className="mt-6 text-destructive">
          {t("detail.unreachable")}
        </p>
      ) : (
        <div className="grid gap-6">
          <AddDocument kbId={kbId} />
          <UploadTasksPanel kbId={kbId} />
          <DocumentList kbId={kbId} />
          <RetrievalTest kbId={kbId} />
        </div>
      )}
    </PageShell>
  );
}

/** 上传/添加文档：支持 text / url / file 三种来源；文件批量走上传队列。 */
function AddDocument({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const [type, setType] = useState<"text" | "url" | "file">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const typeId = useId();
  const titleId = useId();
  const contentId = useId();
  const urlId = useId();
  const fileId = useId();

  // 队列 settle（批次结束）时刷新列表与库计数——文件落库的准确时机。
  const onSettled = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.documents(kbId),
    });
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.base(kbId) });
  }, [queryClient, kbId]);
  const tasks = useUploadTasksFor(kbId, onSettled);
  // 任务从活动变到 uploaded 的瞬间同样刷新（单文件场景 settled 已覆盖，
  // 这里兜底多文件批次中途的行可见性）。
  useEffect(() => {
    if (tasks.some((task) => task.phase === "uploaded")) onSettled();
  }, [tasks, onSettled]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.documents(kbId),
      }),
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.base(kbId) }),
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases }),
    ]);

  const add = useMutation({
    mutationFn: (input: AddDocumentInput) => addDocument(kbId, input),
    onSuccess: async (result) => {
      // 记住本会话产生的 task，文档行的解析进度轮询用它。
      noteRecentTask(kbId, result.doc_id, result.task_id);
      setTitle("");
      setContent("");
      setUrl("");
      await refresh();
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (type === "file") return; // 文件走 input 的 onChange
    if (type === "url") {
      if (!url.trim()) return;
      add.mutate({
        type: "url",
        url: url.trim(),
        title: title.trim() || undefined,
      });
      return;
    }
    if (!content.trim()) return;
    add.mutate({ type: "text", content, title: title.trim() || undefined });
  };

  return (
    <form className="grid gap-3 rounded-lg border p-4" onSubmit={submit}>
      <h2 className="font-semibold">{t("add.title")}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={field} htmlFor={typeId}>
          {t("add.type")}
          <select
            id={typeId}
            className={select}
            value={type}
            onChange={(event) =>
              setType(event.target.value as "text" | "url" | "file")
            }
          >
            <option value="text">{t("add.typeText")}</option>
            <option value="url">{t("add.typeUrl")}</option>
            <option value="file">{t("add.typeFile")}</option>
          </select>
        </label>
        <label className={field} htmlFor={titleId}>
          {t("add.titleField")}
          <Input
            id={titleId}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
      </div>
      {type === "text" ? (
        <label className={field} htmlFor={contentId}>
          {t("add.content")}
          <Textarea
            id={contentId}
            required
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t("add.contentPlaceholder")}
          />
        </label>
      ) : type === "url" ? (
        <label className={field} htmlFor={urlId}>
          {t("add.url")}
          <Input
            id={urlId}
            required
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t("add.urlPlaceholder")}
          />
        </label>
      ) : (
        <label className={field} htmlFor={fileId}>
          {t("add.file")}
          {/* multiple：多文件一起进上传队列（有界并发），面板显示进度。 */}
          <Input
            id={fileId}
            ref={fileInput}
            type="file"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0)
                uploadCommands.enqueue(
                  kbId,
                  files.map((file) => ({ file })),
                );
              // 允许连续选同一批文件（重选同名也触发 onChange）。
              event.target.value = "";
            }}
          />
        </label>
      )}
      {type !== "file" ? (
        <Button
          type="submit"
          className="justify-self-start"
          disabled={
            add.isPending ||
            (type === "text" && !content.trim()) ||
            (type === "url" && !url.trim())
          }
        >
          {add.isPending ? t("add.adding") : t("add.submit")}
        </Button>
      ) : null}
      {add.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {add.error.message}
        </p>
      )}
    </form>
  );
}

/** 筛选/排序/多选/批量删除/轮询一体的文档表。 */
function DocumentList({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const [filter, setFilter] =
    useState<KnowledgeDocumentFilter>(emptyDocumentFilter);
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [sort, setSort] = useState<DocumentSortValue>(DEFAULT_DOCUMENT_SORT);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastCheckedIndex, setLastCheckedIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(
    null,
  );
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const keywordId = useId();
  const typeId = useId();
  const statusId = useId();

  // 关键字 debounce：输入即时入 state，筛选值 300ms 后跟上。
  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedKeyword(filter.keyword.trim().toLowerCase()),
      KEYWORD_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [filter.keyword]);

  const docs = useQuery({
    ...documentsQueryOptions(kbId),
    refetchInterval: (query) => {
      // 存在非终态文档时降频轮询（5s），否则停——替换旧版整表 2s 常开。
      const data = query.state.data as
        | ListEnvelope<KnowledgeDocument>
        | undefined;
      return data?.items.some(
        (doc) =>
          doc.parse_status === "pending" || doc.parse_status === "processing",
      )
        ? DOCS_POLL_MS
        : false;
    },
  });

  const visible = useMemo(() => {
    const items = docs.data?.items ?? [];
    const filtered = items.filter((doc) => {
      if (filter.type && doc.source !== filter.type) return false;
      if (filter.status && doc.parse_status !== filter.status) return false;
      if (debouncedKeyword) {
        const haystack = `${doc.title} ${doc.file_name ?? ""}`.toLowerCase();
        if (!haystack.includes(debouncedKeyword)) return false;
      }
      return true;
    });
    return sortDocuments(filtered, sort);
  }, [docs.data, filter.type, filter.status, debouncedKeyword, sort]);

  // 行点击 checkbox 的 shift 范围选（WeKnora DocumentListView 交互直译）。
  const toggleRow = (index: number, id: string, shiftKey: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (shiftKey && lastCheckedIndex !== null) {
        const [from, to] =
          lastCheckedIndex < index
            ? [lastCheckedIndex, index]
            : [index, lastCheckedIndex];
        for (let i = from; i <= to; i += 1) {
          const row = visible[i];
          if (row) next.add(row.id);
        }
      } else if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setLastCheckedIndex(index);
  };

  const remove = useMutation({
    mutationFn: (docId: string) => deleteDocument(kbId, docId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.documents(kbId),
        }),
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.base(kbId) }),
      ]);
    },
  });

  // 批量删除 = 循环单删（上游无 batch 端点，spec §4.4）；全部完成后一次失效。
  const bulkDelete = async () => {
    const ids = [...selected].slice(0, MAX_BULK_DELETE);
    if (ids.length === 0) return;
    setBulkDeleting(true);
    setBulkError(null);
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteDocument(kbId, id);
      } catch {
        failed += 1;
      }
    }
    setBulkDeleting(false);
    setSelected(new Set());
    setLastCheckedIndex(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.documents(kbId),
      }),
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.base(kbId) }),
    ]);
    if (failed > 0) setBulkError(t("docs.bulkError", { count: failed }));
  };

  const statusLabel = (status: ParseStatus) =>
    ({
      pending: t("status.pending"),
      processing: t("status.processing"),
      completed: t("status.completed"),
      failed: t("status.failed"),
    })[status];

  const activeOption = getDocumentSortOption(sort);

  const sortHeader = (label: string, column: DocumentSortField) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-medium hover:text-foreground"
      onClick={() => setSort((current) => nextSortValue(current, column))}
    >
      {label}
      {activeOption.sortBy === column
        ? activeOption.sortOrder === "asc"
          ? " ↑"
          : " ↓"
        : ""}
    </button>
  );

  return (
    <PageSection title={t("docs.title")} description={t("docs.description")}>
      {/* 筛选工具栏：全部客户端过滤（上游列表接口无查询参数）。 */}
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <label className={field} htmlFor={keywordId}>
          {t("filter.keyword")}
          <Input
            id={keywordId}
            value={filter.keyword}
            placeholder={t("filter.keywordPlaceholder")}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                keyword: event.target.value,
              }))
            }
          />
        </label>
        <label className={field} htmlFor={typeId}>
          {t("filter.type")}
          <select
            id={typeId}
            className={select}
            value={filter.type}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                type: event.target.value as KnowledgeDocumentFilter["type"],
              }))
            }
          >
            <option value="">{t("filter.all")}</option>
            <option value="file">{t("add.typeFile")}</option>
            <option value="url">{t("add.typeUrl")}</option>
            <option value="text">{t("add.typeText")}</option>
          </select>
        </label>
        <label className={field} htmlFor={statusId}>
          {t("filter.status")}
          <select
            id={statusId}
            className={select}
            value={filter.status}
            onChange={(event) =>
              setFilter((current) => ({
                ...current,
                status: event.target.value as KnowledgeDocumentFilter["status"],
              }))
            }
          >
            <option value="">{t("filter.all")}</option>
            <option value="pending">{t("status.pending")}</option>
            <option value="processing">{t("status.processing")}</option>
            <option value="completed">{t("status.completed")}</option>
            <option value="failed">{t("status.failed")}</option>
          </select>
        </label>
      </div>

      {selected.size > 0 && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
          <span>{t("docs.selectedCount", { count: selected.size })}</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
            >
              {t("docs.clearSelection")}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={bulkDeleting}
              onClick={() => void bulkDelete()}
            >
              {bulkDeleting
                ? t("docs.bulkDeleting")
                : t("docs.bulkDelete", { count: selected.size })}
            </Button>
          </div>
        </div>
      )}
      {bulkError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {bulkError}
        </p>
      )}

      {docs.error ? (
        <p role="alert" className="mt-4 text-destructive">
          {docs.error.message}
        </p>
      ) : visible.length > 0 ? (
        <section
          aria-label={t("docs.tableAria")}
          className="mt-2 overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: An overflow region needs keyboard focus to scroll in Safari; the region has an accessible name.
          tabIndex={0}
        >
          {/* 裸 table 惯例（audit.tsx/consumption-table.tsx 先例）。 */}
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-border border-b">
                <th className="w-8 px-4 py-2" aria-label={t("docs.select")} />
                <th className="px-4 py-2 font-medium">
                  {sortHeader(t("docs.colTitle"), "title")}
                </th>
                <th className="px-4 py-2 font-medium">{t("docs.colMeta")}</th>
                <th className="px-4 py-2 font-medium">
                  {sortHeader(t("docs.colCreated"), "created_at")}
                </th>
                <th className="px-4 py-2 font-medium">
                  {sortHeader(t("docs.colUpdated"), "updated_at")}
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  {t("docs.colActions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((doc, index) => (
                <DocumentRow
                  key={doc.id}
                  doc={doc}
                  index={index}
                  checked={selected.has(doc.id)}
                  onToggle={(shiftKey) => toggleRow(index, doc.id, shiftKey)}
                  statusLabel={statusLabel(doc.parse_status)}
                  onDelete={() => setPendingDelete(doc)}
                  deletePending={remove.isPending}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : docs.isPending ? null : (
        <Empty className="mt-4 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{t("docs.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("docs.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ""}
        body={t("docs.deleteConfirm", { title: pendingDelete?.title ?? "" })}
        pending={remove.isPending}
        error={remove.error?.message ?? null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await remove.mutateAsync(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </PageSection>
  );
}

function DocumentRow({
  doc,
  checked,
  onToggle,
  statusLabel,
  onDelete,
  deletePending,
}: {
  doc: KnowledgeDocument;
  index: number;
  checked: boolean;
  onToggle: (shiftKey: boolean) => void;
  statusLabel: string;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const { t } = useTranslation("knowledge");
  const finished =
    doc.parse_status === "completed" || doc.parse_status === "failed";
  return (
    <tr className="border-t">
      <td className="py-2 pr-2">
        <Checkbox
          aria-label={t("docs.selectRow", { title: doc.title })}
          checked={checked}
          onCheckedChange={() => onToggle(false)}
          onClick={(event) => {
            if (event.shiftKey) {
              event.preventDefault();
              onToggle(true);
            }
          }}
        />
      </td>
      <td className="py-2 pr-2">
        <div className="grid gap-0.5">
          <span className="font-medium">{doc.title}</span>
          {doc.file_name && doc.file_name !== doc.title ? (
            <span className="text-xs text-muted-foreground truncate">
              {doc.file_name}
              {doc.file_type ? ` · ${doc.file_type}` : ""}
            </span>
          ) : doc.file_type ? (
            <span className="text-xs text-muted-foreground">
              {doc.file_type}
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-2 pr-2">
        <div className="grid gap-0.5">
          {/* 状态徽标（bots.index.tsx 先例）+ task 级 chunks 进度。 */}
          <span className="flex items-center gap-1.5">
            <span
              className={`rounded-full px-1.5 text-xs ${
                finished
                  ? doc.parse_status === "completed"
                    ? "bg-primary text-primary-foreground"
                    : "bg-destructive text-destructive-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {statusLabel}
            </span>
            {!finished && doc.chunk_count > 0 ? (
              <TaskProgress kbId={doc.kb_id} docId={doc.id} />
            ) : null}
          </span>
          <span className="text-xs text-muted-foreground">
            {doc.chunk_count > 0
              ? t("docs.chunks", { count: doc.chunk_count })
              : ""}
            {/* 上游 Document 无 file_size 字段；放 metadata 里时兜底展示。 */}
            {doc.metadata?.file_size
              ? ` · ${formatFileSize(doc.metadata.file_size)}`
              : ""}
          </span>
        </div>
      </td>
      <td className="py-2 pr-2 text-xs text-muted-foreground">
        {relativeTime(doc.created_at)}
      </td>
      <td className="py-2 pr-2 text-xs text-muted-foreground">
        {relativeTime(doc.updated_at)}
      </td>
      <td className="py-2 pr-2 text-right">
        <Button
          size="icon"
          variant="outline"
          aria-label={t("docs.delete")}
          disabled={deletePending}
          onClick={onDelete}
        >
          <IconTrash />
        </Button>
      </td>
    </tr>
  );
}

/**
 * task 级解析进度：文档行存在 pending/processing 时轮询其最近 task。
 * 上游按 doc 查 task 的入口是 tasks/:taskId——需要 task_id；文档行只有
 * doc_id，所以这里以文档自身 status 为信号、由上传/添加返回的 task_id 经
 * context 传入。简化实现：仅当本会话产生的 task（记录在模块级 map）时显示。
 */
const recentTaskIds = new Map<string, string>();

export function noteRecentTask(kbId: string, docId: string, taskId: string) {
  recentTaskIds.set(`${kbId}:${docId}`, taskId);
}

function TaskProgress({ kbId, docId }: { kbId: string; docId: string }) {
  const { t } = useTranslation("knowledge");
  const taskId = recentTaskIds.get(`${kbId}:${docId}`);
  const task = useQuery({
    ...taskQueryOptions(kbId, taskId ?? ""),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "processing"
        ? TASK_POLL_MS
        : false;
    },
  });
  if (!taskId || !task.data) return null;
  const { progress, chunks_done, chunks_total, status } = task.data;
  if (status !== "pending" && status !== "processing") return null;
  return (
    <span className="text-xs text-muted-foreground">
      {t("docs.taskProgress", {
        progress: String(progress),
        done: String(chunks_done),
        total: String(chunks_total),
      })}
    </span>
  );
}

/** 检索测试：query + top_k + score_threshold + hybrid 全参数透传。 */
function RetrievalTest({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [threshold, setThreshold] = useState(0);
  const [hybrid, setHybrid] = useState(true);
  const queryId = useId();
  const topKId = useId();
  const thresholdId = useId();
  const hybridId = useId();

  const search = useMutation({
    mutationFn: (q: string) =>
      retrieve(kbId, {
        query: q,
        top_k: topK,
        ...(threshold > 0 ? { score_threshold: threshold } : {}),
        hybrid,
      }),
  });

  return (
    <PageSection
      title={t("search.title")}
      description={t("search.description")}
    >
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim()) search.mutate(query.trim());
        }}
      >
        <label className={field} htmlFor={queryId}>
          {t("search.query")}
          <Input
            id={queryId}
            required
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search.placeholder")}
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className={field} htmlFor={topKId}>
            {t("search.topK")}
            <Input
              id={topKId}
              type="number"
              min={1}
              max={10}
              value={topK}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(parsed))
                  setTopK(Math.min(10, Math.max(1, parsed)));
              }}
            />
          </label>
          <label className={field} htmlFor={thresholdId}>
            {t("search.threshold")}
            <Input
              id={thresholdId}
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const parsed = Number.parseFloat(event.target.value);
                setThreshold(
                  Number.isFinite(parsed)
                    ? Math.min(1, Math.max(0, parsed))
                    : 0,
                );
              }}
            />
          </label>
          <div className={field}>
            <Label htmlFor={hybridId}>{t("search.hybrid")}</Label>
            <div className="flex h-9 items-center gap-2">
              <Switch
                id={hybridId}
                checked={hybrid}
                onCheckedChange={setHybrid}
              />
              <span className="text-xs text-muted-foreground">
                {hybrid ? t("search.hybridOn") : t("search.hybridOff")}
              </span>
            </div>
          </div>
        </div>
        <Button
          type="submit"
          className="justify-self-start"
          disabled={search.isPending || !query.trim()}
        >
          {search.isPending ? t("search.searching") : t("search.submit")}
        </Button>
      </form>
      {search.error ? (
        <p role="alert" className="mt-4 text-destructive">
          {search.error.message}
        </p>
      ) : search.data ? (
        search.data.results.length ? (
          <div className="mt-4 grid gap-3">
            {search.data.results.map((result) => (
              <ResultCard key={result.chunk_id} result={result} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            {t("search.noResults")}
          </p>
        )
      ) : null}
    </PageSection>
  );
}

function ResultCard({ result }: { result: KnowledgeSearchResult }) {
  const { t } = useTranslation("knowledge");
  return (
    <article className="grid gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* metadata.title 优先：它才是用户起的名字；source 只是来源标识。 */}
        <span className="text-sm font-medium">
          {result.metadata?.title || result.source || "—"}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("search.score", { score: result.score.toFixed(4) })}
        </span>
      </div>
      <p className="text-sm text-muted-foreground whitespace-pre-wrap">
        {result.content}
      </p>
    </article>
  );
}

/** 通用危险确认（bot-profile 模式：标题红强调 + destructive 按钮）。 */
function ConfirmDeleteDialog({
  open,
  title,
  body,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation("knowledge");
  return (
    <Dialog
      onOpenChange={(next) => (next ? undefined : onCancel())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">
            {t("delete.title")}
          </DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <p className="text-sm font-medium">{title}</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button size="sm" variant="outline" onClick={onCancel}>
            {t("delete.cancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {pending ? t("delete.deleting") : t("delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
