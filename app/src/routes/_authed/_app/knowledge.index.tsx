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
  createKnowledgeBase,
  deleteKnowledgeBase,
  knowledgeBasesQueryOptions,
  knowledgeKeys,
} from "@/lib/knowledge";

export const Route = createFileRoute("/_authed/_app/knowledge/")({
  component: KnowledgeIndexPage,
});

const field = "grid min-w-0 gap-1 text-sm";

function KnowledgeIndexPage() {
  const { t } = useTranslation("knowledge");
  const queryClient = useQueryClient();
  const bases = useQuery(knowledgeBasesQueryOptions());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const nameId = useId();
  const descriptionId = useId();

  const create = useMutation({
    mutationFn: createKnowledgeBase,
    onSuccess: async () => {
      setName("");
      setDescription("");
      await queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases });
    },
  });
  const remove = useMutation({
    mutationFn: deleteKnowledgeBase,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: knowledgeKeys.bases }),
  });

  return (
    <PageShell title={t("title")} description={t("description")} width="wide">
      <div className="grid gap-6">
        <form
          className="grid gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            create.mutate({
              name: name.trim(),
              description: description.trim() || undefined,
            });
          }}
        >
          <h2 className="font-semibold">{t("create.title")}</h2>
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
          <Button
            type="submit"
            className="justify-self-start"
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? t("create.creating") : t("create.submit")}
          </Button>
          {(create.error || remove.error) && (
            <p role="alert" className="text-destructive">
              {create.error?.message || remove.error?.message}
            </p>
          )}
        </form>

        <PageSection
          title={t("list.title")}
          description={t("list.description")}
        >
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
                          to="/knowledge/$kbId"
                          params={{ kbId: kb.id }}
                          className="underline-offset-4 hover:underline"
                        >
                          {kb.name}
                        </Link>
                      </ItemTitle>
                      <ItemDescription>
                        {kb.description || t("list.noDescription")}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <span className="text-xs text-muted-foreground">
                        {t("list.docCount", { count: kb.doc_count })}
                      </span>
                      <Button
                        size="icon"
                        variant="outline"
                        aria-label={t("list.delete")}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(kb.id)}
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
    </PageShell>
  );
}
