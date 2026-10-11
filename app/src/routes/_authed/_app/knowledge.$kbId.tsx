import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  type AddDocumentInput,
  addDocument,
  deleteDocument,
  documentsQueryOptions,
  type KnowledgeDocument,
  type KnowledgeSearchResult,
  knowledgeBaseQueryOptions,
  knowledgeKeys,
  type ListEnvelope,
  type ParseStatus,
  retrieve,
  uploadDocumentFile,
} from "@/lib/knowledge";

export const Route = createFileRoute("/_authed/_app/knowledge/$kbId")({
  component: KnowledgeDetailPage,
});

const field = "grid min-w-0 gap-1 text-sm";
const select =
  "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm";

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
          <DocumentList kbId={kbId} />
          <RetrievalTest kbId={kbId} />
        </div>
      )}
    </PageShell>
  );
}

/** 上传/添加文档：支持 text / url / file 三种来源。 */
function AddDocument({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const [type, setType] = useState<"text" | "url" | "file">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const typeId = useId();
  const titleId = useId();
  const contentId = useId();
  const urlId = useId();
  const fileId = useId();

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
    onSuccess: async () => {
      setTitle("");
      setContent("");
      setUrl("");
      setFileName("");
      if (fileInput.current) fileInput.current.value = "";
      await refresh();
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadDocumentFile(kbId, file),
    onSuccess: async () => {
      setTitle("");
      setFileName("");
      if (fileInput.current) fileInput.current.value = "";
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
          <Input
            id={fileId}
            ref={fileInput}
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                setFileName(file.name);
                upload.mutate(file);
              }
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
      ) : (
        <p className="text-xs text-muted-foreground">
          {upload.isPending ? `${t("add.adding")} ${fileName}` : fileName}
        </p>
      )}
      {(add.error || upload.error) && (
        <p role="alert" className="text-destructive">
          {add.error?.message || upload.error?.message}
        </p>
      )}
    </form>
  );
}

/** 文档列表：解析是异步的，存在 pending/processing 文档时轮询刷新。 */
function DocumentList({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const docs = useQuery({
    ...documentsQueryOptions(kbId),
    refetchInterval: (query) => {
      const data = query.state.data as
        | ListEnvelope<KnowledgeDocument>
        | undefined;
      return data?.items.some(
        (doc) =>
          doc.parse_status === "pending" || doc.parse_status === "processing",
      )
        ? 2000
        : false;
    },
  });

  const remove = useMutation({
    mutationFn: (docId: string) => deleteDocument(kbId, docId),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.documents(kbId),
        }),
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.base(kbId) }),
      ]),
  });

  const statusLabel = (status: ParseStatus) =>
    ({
      pending: t("status.pending"),
      processing: t("status.processing"),
      completed: t("status.completed"),
      failed: t("status.failed"),
    })[status];

  return (
    <PageSection title={t("docs.title")} description={t("docs.description")}>
      {docs.error ? (
        <p role="alert" className="mt-4 text-destructive">
          {docs.error.message}
        </p>
      ) : docs.data?.items.length ? (
        <PageRows>
          {docs.data.items.map((doc, index) => (
            <div key={doc.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{doc.title}</ItemTitle>
                  <ItemDescription>
                    {statusLabel(doc.parse_status)}
                    {doc.parse_status === "completed"
                      ? ` · ${t("docs.chunks", { count: doc.chunk_count })}`
                      : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    size="icon"
                    variant="outline"
                    aria-label={t("docs.delete")}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(doc.id)}
                  >
                    <IconTrash />
                  </Button>
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
      ) : docs.isPending ? null : (
        <Empty className="mt-4 border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{t("docs.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("docs.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </PageSection>
  );
}

/** 检索测试：输入 query，展示带分数与来源的召回结果。 */
function RetrievalTest({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const [query, setQuery] = useState("");
  const queryId = useId();
  const search = useMutation({
    mutationFn: (q: string) => retrieve(kbId, { query: q }),
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
        <span className="text-sm font-medium">{result.source || "—"}</span>
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
