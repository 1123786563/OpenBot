import { IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
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
  type CreateKnowledgeBaseInput,
  createKnowledgeBase,
  deleteKnowledgeBase,
  type KnowledgeBase,
  knowledgeBasesQueryOptions,
  knowledgeKeys,
} from "@/lib/knowledge";

export const Route = createFileRoute("/_authed/admin/knowledge/")({
  component: KnowledgeIndexPage,
});

const field = "grid min-w-0 gap-1 text-sm";

/** 高级参数的缺省值：与上游/检索层默认对齐（chunk 512 / overlap 80）。 */
const DEFAULT_CHUNK_SIZE = 512;
const DEFAULT_CHUNK_OVERLAP = 80;

function KnowledgeIndexPage() {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const bases = useQuery(knowledgeBasesQueryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeBase | null>(
    null,
  );

  const remove = useMutation({
    mutationFn: deleteKnowledgeBase,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });

  return (
    <PageShell title={t("title")} description={t("description")} width="wide">
      <div className="grid gap-6">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("list.description")}
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            {t("create.title")}
          </Button>
        </div>

        <PageSection title={t("list.title")} description={undefined}>
          {bases.isPending ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {t("list.loading")}
            </p>
          ) : bases.error ? (
            <p role="alert" className="mt-4 text-destructive">
              {bases.error.message}
            </p>
          ) : bases.data?.items.length ? (
            <PageRows>
              {bases.data.items.map((kb, index) => (
                <div key={kb.id}>
                  {index > 0 ? <Separator /> : null}
                  <Item size="sm">
                    <ItemContent>
                      <ItemTitle>
                        <Link
                          to="/admin/knowledge/$kbId"
                          params={{ kbId: kb.id }}
                          className="underline-offset-4 hover:underline"
                        >
                          {kb.name}
                        </Link>
                        {/* doc_count 徽标化（bots.index.tsx 先例）。 */}
                        <span className="ml-2 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                          {t("list.docCount", { count: kb.doc_count })}
                        </span>
                      </ItemTitle>
                      <ItemDescription>
                        {kb.description || t("list.noDescription")}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={t("list.delete")}
                        disabled={remove.isPending}
                        onClick={() => setPendingDelete(kb)}
                      >
                        <IconTrash />
                      </Button>
                    </ItemActions>
                  </Item>
                </div>
              ))}
            </PageRows>
          ) : (
            <Empty className="mt-4 border border-dashed">
              <EmptyHeader>
                <EmptyTitle>{t("list.emptyTitle")}</EmptyTitle>
                <EmptyDescription>
                  {t("list.emptyDescription")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </PageSection>
      </div>

      <CreateKnowledgeBaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        name={pendingDelete?.name ?? ""}
        pending={remove.isPending}
        error={remove.error?.message ?? null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await remove.mutateAsync(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </PageShell>
  );
}

/**
 * 建库表单（Dialog）：name/description 必填区 + 高级折叠区
 * （embedder/chunk_size/chunk_overlap/rerank_model，对齐 POST /kb 全字段）。
 */
function CreateKnowledgeBaseDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [embedder, setEmbedder] = useState("");
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [chunkOverlap, setChunkOverlap] = useState(DEFAULT_CHUNK_OVERLAP);
  const [rerankModel, setRerankModel] = useState("");
  const nameId = useId();
  const descriptionId = useId();
  const embedderId = useId();
  const chunkSizeId = useId();
  const chunkOverlapId = useId();
  const rerankId = useId();

  const create = useMutation({
    mutationFn: createKnowledgeBase,
    onSuccess: async () => {
      setName("");
      setDescription("");
      setAdvancedOpen(false);
      setEmbedder("");
      setChunkSize(DEFAULT_CHUNK_SIZE);
      setChunkOverlap(DEFAULT_CHUNK_OVERLAP);
      setRerankModel("");
      onOpenChange(false);
      await queryClient.invalidateQueries({
        queryKey: knowledgeKeys.bases,
      });
    },
  });

  const reset = () => {
    if (create.isPending) return;
    setName("");
    setDescription("");
    setAdvancedOpen(false);
    setEmbedder("");
    setChunkSize(DEFAULT_CHUNK_SIZE);
    setChunkOverlap(DEFAULT_CHUNK_OVERLAP);
    setRerankModel("");
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const input: CreateKnowledgeBaseInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      // 高级区只在用户填过时携带——空串会让上游拒绝 embedder。
      ...(embedder.trim() ? { embedder: embedder.trim() } : {}),
      ...(advancedOpen
        ? { chunk_size: chunkSize, chunk_overlap: chunkOverlap }
        : {}),
      ...(rerankModel.trim() ? { rerank_model: rerankModel.trim() } : {}),
    };
    create.mutate(input);
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("create.title")}</DialogTitle>
          <DialogDescription>{t("create.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <DialogBody className="mt-4">
            <label className={field} htmlFor={nameId}>
              {t("create.name")}
              <Input
                id={nameId}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("create.namePlaceholder")}
              />
            </label>
            <label className={field} htmlFor={descriptionId}>
              {t("create.description")}
              <Textarea
                id={descriptionId}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("create.descriptionPlaceholder")}
              />
            </label>

            {/* 高级折叠区：点开展开，不点则提交缺省值以外的内容为零。 */}
            <button
              type="button"
              className="justify-self-start text-sm text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              {advancedOpen
                ? t("create.hideAdvanced")
                : t("create.showAdvanced")}
            </button>
            {advancedOpen ? (
              <div className="grid gap-3 rounded-lg border p-3">
                <label className={field} htmlFor={embedderId}>
                  {t("create.embedder")}
                  <Input
                    id={embedderId}
                    value={embedder}
                    onChange={(event) => setEmbedder(event.target.value)}
                    placeholder={t("create.embedderPlaceholder")}
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className={field} htmlFor={chunkSizeId}>
                    {t("create.chunkSize")}
                    <Input
                      id={chunkSizeId}
                      type="number"
                      min={64}
                      value={chunkSize}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        if (Number.isFinite(parsed) && parsed > 0)
                          setChunkSize(parsed);
                      }}
                    />
                  </label>
                  <label className={field} htmlFor={chunkOverlapId}>
                    {t("create.chunkOverlap")}
                    <Input
                      id={chunkOverlapId}
                      type="number"
                      min={0}
                      value={chunkOverlap}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        if (Number.isFinite(parsed) && parsed >= 0)
                          setChunkOverlap(parsed);
                      }}
                    />
                  </label>
                </div>
                <label className={field} htmlFor={rerankId}>
                  {t("create.rerankModel")}
                  <Input
                    id={rerankId}
                    value={rerankModel}
                    onChange={(event) => setRerankModel(event.target.value)}
                    placeholder={t("create.rerankPlaceholder")}
                  />
                </label>
              </div>
            ) : null}

            {create.error ? (
              <p role="alert" className="text-sm text-destructive">
                {create.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => onOpenChange(false)}
            >
              {t("create.cancel")}
            </Button>
            <Button
              size="sm"
              type="submit"
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? t("create.creating") : t("create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 删除确认（bot-profile 危险操作模式：标题红强调 + destructive 按钮）。 */
function ConfirmDeleteDialog({
  open,
  name,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string;
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
          <DialogDescription>
            {t("list.deleteConfirm", { name })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">
            {t("list.deleteIrreversible")}
          </p>
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
