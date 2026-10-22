import { IconPlus, IconRobot, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
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
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createMemoryMutationOptions,
  deleteMemoryMutationOptions,
  type MemoryRecord,
  memoriesQueryOptions,
  updateMemoryMutationOptions,
} from "@/lib/memory";
import { queryClient } from "@/query-client";

/**
 * A fact the person tells their Bots directly. It reaches every one of them.
 *
 * The page's one primary verb, so it is a button for `PageShell`'s `action` that opens a dialog,
 * rather than a form standing above the list somebody came to read.
 */
export function RememberFact() {
  const { t } = useTranslation("agents");
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  return (
    <>
      <Button
        onClick={() => {
          // Opening starts clean: no draft or failure left from an earlier attempt.
          setContent("");
          remember.reset();
          setOpen(true);
        }}
        size="sm"
        variant="ghost"
      >
        <IconPlus />
        {t("memory.rememberFact")}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("memory.rememberFact")}</DialogTitle>
            <DialogDescription>{t("memory.reachesAll")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                remember.mutate(content, {
                  onSuccess: () => {
                    setContent("");
                    setOpen(false);
                  },
                });
              }}
            >
              <Field>
                <FieldLabel htmlFor={`${formId}-content`}>
                  {t("memory.factLabel")}
                </FieldLabel>
                <Textarea
                  id={`${formId}-content`}
                  required
                  maxLength={6000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={t("memory.factPlaceholder")}
                />
              </Field>
            </form>
            {remember.error ? (
              <p role="alert" className="text-destructive text-sm">
                {remember.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)} size="sm" variant="outline">
              {t("memory.cancel")}
            </Button>
            <Button
              disabled={remember.isPending || !content.trim()}
              form={formId}
              size="sm"
              type="submit"
            >
              {t("memory.remember")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Everything the person's Bots remember about them, with who formed each memory. */
export function MemoryList() {
  const { t } = useTranslation("agents");
  const memories = useQuery(memoriesQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const botName = (id: string | null) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? t("memory.yourBot");
  return (
    <PageSection title={t("memory.yourMemories")}>
      {memories.isPending ? null : memories.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {memories.error.message}
        </p>
      ) : memories.data.length ? (
        <PageRows>
          {memories.data.map((memory, index) => (
            <Fragment key={memory.id}>
              {index > 0 ? <Separator /> : null}
              <MemoryRow
                botName={botName(memory.formedByAgentId)}
                memory={memory}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty>{t("memory.noMemories")}</PageEmpty>
      )}
    </PageSection>
  );
}

/**
 * One memory: the fact itself, then where it came from. Whether Bots use it is a switch; editing
 * its words opens a dialog, and confirming or forgetting it are the buttons beneath.
 */
function MemoryRow({
  memory,
  botName,
}: {
  memory: MemoryRecord;
  botName: string;
}) {
  const { t } = useTranslation("agents");
  const [editing, setEditing] = useState(false);
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const update = (input: {
    content?: string;
    enabled?: boolean;
    reviewState?: "confirmed";
  }) => save.mutate({ id: memory.id, input });
  const status = !memory.enabled
    ? t("memory.card.disabled")
    : memory.formedBy === "bot"
      ? t("memory.card.formedBy", { name: botName }) +
        (memory.reviewState === "unreviewed"
          ? t("memory.card.awaitingReview")
          : "")
      : memory.reviewState === "unreviewed"
        ? t("memory.card.importedAwaiting")
        : t("memory.card.reviewed");
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {memory.formedBy === "bot" ? <IconRobot /> : <IconUser />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {memory.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {memory.provenance} · {status}
        </ItemDescription>
        {memory.formedBy === "bot" && (
          <ItemDescription className="line-clamp-none">
            {t("memory.card.from", {
              source: memory.sourceApp ?? t("memory.card.aConversation"),
            })}
            {memory.observedAt
              ? t("memory.card.readSuffix", {
                  when: new Date(memory.observedAt).toLocaleString(),
                })
              : ""}
            {memory.sourceLink && (
              <>
                {" · "}
                <a href={memory.sourceLink} target="_blank" rel="noreferrer">
                  {t("memory.card.openRecord")}
                </a>
              </>
            )}
          </ItemDescription>
        )}
        {/* A set, so it wraps onto its own line rather than crowding the fact. */}
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                save.reset();
                setEditing(true);
              }}
              size="sm"
              variant="outline"
            >
              {t("memory.card.edit")}
            </Button>
            {memory.reviewState === "unreviewed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => update({ reviewState: "confirmed" })}
              >
                {t("memory.card.confirm")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={forget.isPending}
              onClick={() => forget.mutate(memory.id)}
            >
              {t("memory.card.forget")}
            </Button>
          </div>
        </ItemFooter>
        {!editing && (save.error || forget.error) && (
          <p role="alert" className="text-destructive text-sm">
            {save.error?.message || forget.error?.message}
          </p>
        )}
      </ItemContent>
      <ItemActions>
        {/* Binary and immediate: Bots stop or start using it when switched. */}
        <Switch
          aria-label={t("memory.card.useAria", {
            content: clip(memory.content),
          })}
          checked={memory.enabled}
          disabled={save.isPending}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </ItemActions>
      {editing ? (
        <EditMemoryDialog
          memory={memory}
          onClose={() => setEditing(false)}
          onSave={(content) =>
            save.mutate(
              { id: memory.id, input: { content } },
              { onSuccess: () => setEditing(false) },
            )
          }
          error={save.error?.message ?? null}
          saving={save.isPending}
        />
      ) : null}
    </Item>
  );
}

/** A memory's words, cut short enough to name the switch beside them. */
function clip(content: string) {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The memory's words in a dialog. Saving rewrites them; the server records it as edited. */
function EditMemoryDialog({
  memory,
  saving,
  error,
  onSave,
  onClose,
}: {
  memory: MemoryRecord;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  const [content, setContent] = useState(memory.content);
  const id = useId();
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("memory.card.editTitle")}</DialogTitle>
          <DialogDescription>{memory.provenance}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Field>
            <FieldLabel className="sr-only" htmlFor={id}>
              {t("memory.card.memoryLabel")}
            </FieldLabel>
            <Textarea
              autoFocus
              id={id}
              maxLength={6000}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              value={content}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            {t("memory.card.cancel")}
          </Button>
          <Button
            disabled={saving || !content.trim()}
            onClick={() => onSave(content)}
            size="sm"
          >
            {t("memory.card.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
