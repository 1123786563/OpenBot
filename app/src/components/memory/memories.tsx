import { Text } from "@astryxdesign/core/Text";
import {
  IconBrain,
  IconListSearch,
  IconPlus,
  IconRobot,
  IconUser,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ClientError } from "@/lib/client";
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
/** Placeholder rows while the list loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

type MemoryRefresh = { retry: () => unknown; retrying: boolean };

function MemoryDraftReadError({ retry, retrying }: MemoryRefresh) {
  return (
    <ReadError
      description="Your draft is still here. Refresh your memories before saving it."
      message="Saving is paused."
      retry={retry}
      retryBelow
      retryLabel="Refresh memories"
      retrying={retrying}
    />
  );
}

export function RememberFact({
  canWrite = true,
  refresh,
  fallbackFocus,
}: {
  canWrite?: boolean;
  refresh?: MemoryRefresh;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const formId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const remember = useMutation(createMemoryMutationOptions(queryClient));
  return (
    <>
      {canWrite ? (
        <Button
          className="min-h-11"
          id="remember-fact"
          ref={opener}
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
          Remember a fact
        </Button>
      ) : null}
      <Text
        as="p"
        className={canWrite && remember.isSuccess ? undefined : "sr-only"}
        color="secondary"
        role="status"
        size="sm"
      >
        {canWrite && remember.isSuccess ? "Memory saved." : null}
      </Text>
      <SettingsDraftDialog
        action={
          <Button
            className="min-h-11"
            disabled={!canWrite || remember.isPending || !content.trim()}
            form={formId}
            size="sm"
            type="submit"
          >
            {remember.isPending ? "Remembering…" : "Remember"}
          </Button>
        }
        description="All your Bots will know it."
        dirty={!!content.trim()}
        guardNavigation={submitting}
        onClose={() => setOpen(false)}
        open={open}
        opener={() => opener.current ?? fallbackFocus?.() ?? null}
        saving={remember.isPending}
        title="Remember a fact"
      >
        {refresh ? <MemoryDraftReadError {...refresh} /> : null}
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canWrite || remember.isPending || !content.trim()) return;
            submitting.current = true;
            remember.mutate(content, {
              onSuccess: () => {
                setContent("");
                setOpen(false);
              },
              onSettled: () => {
                submitting.current = false;
              },
            });
          }}
        >
          <Field>
            <FieldLabel htmlFor={`${formId}-content`}>
              Something you want your Bots to know
            </FieldLabel>
            <Textarea
              id={`${formId}-content`}
              disabled={remember.isPending}
              required
              maxLength={6000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="I prefer meetings in the morning."
            />
          </Field>
        </form>
        {remember.error ? (
          <p role="alert" className="text-destructive text-sm">
            {remember.error.message}
          </p>
        ) : null}
      </SettingsDraftDialog>
    </>
  );
}

/**
 * Everything the person's Bots remember about them, with who formed each memory.
 */
export function MemoryList({ description }: { description?: ReactNode } = {}) {
  const memories = useQuery(memoriesQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const forget = useMutation(deleteMemoryMutationOptions(queryClient));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const denied =
    memories.error instanceof ClientError &&
    (memories.error.status === 401 || memories.error.status === 403);
  const records = denied ? undefined : memories.data;
  const canWrite = memories.isSuccess;
  const refresh =
    memories.isError && !denied
      ? { retry: memories.refetch, retrying: memories.isFetching }
      : undefined;
  const botName = (id: string | null) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? "your Bot";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const searchId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (records ?? []).filter((memory) => {
    if (status === "review" && memory.reviewState !== "unreviewed")
      return false;
    if (status === "paused" && memory.enabled) return false;
    if (words.length === 0) return true;
    const text = [
      memory.content,
      memoryOrigin(memory),
      memory.sourceApp,
      memory.formedByAgentId ? botName(memory.formedByAgentId) : null,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  return (
    <PageSection
      action={
        !denied ? (
          <RememberFact
            canWrite={canWrite}
            fallbackFocus={() => heading.current}
            refresh={refresh}
          />
        ) : undefined
      }
      description={description}
      headingRef={heading}
      title="Your memories"
    >
      {confirmation}
      {memories.error ? (
        <section className="mt-4">
          <ReadError
            message={
              denied
                ? "You no longer have access to these memories."
                : "Couldn't load your memories."
            }
            description={
              records?.length
                ? "Showing the last loaded memories. Editing is paused until the list refreshes."
                : undefined
            }
            focusAfterRetry={() => heading.current}
            retry={memories.refetch}
            retryBelow
            retrying={memories.isFetching}
          />
        </section>
      ) : null}
      {records?.length ? (
        <FieldGroup className="mt-4 flex-col gap-3 sm:flex-row">
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor={searchId}>Search memories</FieldLabel>
            <Input
              className="min-h-11"
              id={searchId}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  setSearch("");
                }
              }}
              placeholder="Fact, source, or Bot"
              ref={searchInput}
              type="search"
              value={search}
            />
          </Field>
          <label className="grid gap-2 text-sm">
            Status
            <select
              className="min-h-11 rounded-md border border-border bg-background p-2 focus-visible:outline-2 focus-visible:outline-ring"
              onChange={(event) => setStatus(event.target.value)}
              value={status}
            >
              <option value="all">All memories</option>
              <option value="review">Needs review</option>
              <option value="paused">Paused</option>
            </select>
          </label>
        </FieldGroup>
      ) : null}
      {records?.length && (words.length > 0 || status !== "all") ? (
        <Text as="p" className="mt-2" color="secondary" role="status" size="sm">
          {matching.length} of {records.length} memories match
        </Text>
      ) : null}
      {memories.isPending ? (
        <div aria-busy="true" aria-label="Loading memories" role="status">
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <Fragment key={key}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-64" />
                    <Skeleton className="h-3 w-32" />
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </div>
      ) : matching.length > 0 ? (
        <PageRows>
          {matching.map((memory, index) => (
            <Fragment key={memory.id}>
              {index > 0 ? <Separator /> : null}
              <MemoryRow
                botName={botName(memory.formedByAgentId)}
                canWrite={canWrite}
                fallbackFocus={() => searchInput.current ?? heading.current}
                memory={memory}
                refresh={refresh}
                onForget={(trigger) =>
                  requestConfirmation({
                    title: "Forget this memory?",
                    description: `“${memory.content}” will be removed from your memories. ${forgetAudience(memory, botName)} You can't undo this.`,
                    confirmLabel: "Forget memory",
                    pendingLabel: "Forgetting…",
                    failureMessage: "Couldn't forget this memory. Try again.",
                    successMessage: "Memory forgotten.",
                    trigger,
                    fallbackFocus: () =>
                      searchInput.current ??
                      document.getElementById("remember-fact"),
                    refresh: () => memories.refetch(),
                    run: async () => {
                      const { data: latest } = await memories.refetch({
                        throwOnError: true,
                      });
                      const current = latest?.find(
                        (candidate) => candidate.id === memory.id,
                      );
                      if (!current || current.content !== memory.content) {
                        throw new ActionUnavailable(
                          "This memory changed or is no longer available. Return to the list to review it.",
                        );
                      }
                      await forget.mutateAsync(memory.id);
                    },
                  })
                }
              />
            </Fragment>
          ))}
        </PageRows>
      ) : records?.length ? (
        <PageEmpty
          action={
            <Button
              className="min-h-11"
              onClick={() => {
                setSearch("");
                setStatus("all");
                searchInput.current?.focus();
              }}
              type="button"
              variant="outline"
            >
              {status === "all" ? "Clear search" : "Clear filters"}
            </Button>
          }
          icon={IconListSearch}
          title="No matching memories"
        />
      ) : !memories.error ? (
        <PageEmpty icon={IconBrain} title="No memories yet">
          Add one with Remember a fact.
        </PageEmpty>
      ) : null}
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
  canWrite,
  fallbackFocus,
  onForget,
  refresh,
}: {
  memory: MemoryRecord;
  botName: string;
  canWrite: boolean;
  fallbackFocus: () => HTMLElement | null;
  onForget: (trigger: HTMLElement) => void;
  refresh?: MemoryRefresh;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const preview = memory.content
    .split("\n")
    .slice(0, 3)
    .join("\n")
    .slice(0, 180)
    .trimEnd();
  const hasPreview = preview !== memory.content.trimEnd();
  const editButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const save = useMutation(updateMemoryMutationOptions(queryClient));
  const update = (input: {
    content?: string;
    enabled?: boolean;
    reviewState?: "confirmed";
  }) => {
    const trigger = document.activeElement;
    void save
      .mutateAsync({ id: memory.id, input })
      .catch(() => undefined)
      .finally(() => {
        requestAnimationFrame(() => {
          if (document.activeElement !== document.body) return;
          if (trigger instanceof HTMLElement && trigger.isConnected) {
            trigger.focus();
          } else {
            fallbackFocus()?.focus();
          }
        });
      });
  };
  // Intelligence keeps only the words of a memory it holds for this person, so it can be edited or
  // forgotten here but not paused or reviewed.
  const heldByIntelligence = memory.formedBy === "intelligence";
  const status = heldByIntelligence
    ? null
    : !memory.enabled
      ? "Paused"
      : memory.formedBy === "bot"
        ? `Learned by ${botName}${memory.reviewState === "unreviewed" ? " · needs review" : ""}`
        : memory.reviewState === "unreviewed"
          ? "Imported · needs review"
          : null;
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {memory.formedBy === "bot" ? <IconRobot /> : <IconUser />}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle
          id={contentId}
          className="line-clamp-none whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {hasPreview && !expanded ? `${preview}…` : memory.content}
        </ItemTitle>
        {hasPreview ? (
          <Button
            aria-controls={contentId}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Show less" : "Read full memory"}: ${clip(memory.content)}`}
            className="min-h-11 self-start"
            onClick={() => setExpanded(!expanded)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {expanded ? "Show less" : "Read full memory"}
          </Button>
        ) : null}
        <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
          {memoryOrigin(memory)}
          {status ? ` · ${status}` : null}
        </ItemDescription>
        {memory.formedBy === "bot" && !memory.sourceRef && (
          <ItemDescription className="line-clamp-none">
            Bots can’t use this memory because its source can’t be verified.
          </ItemDescription>
        )}
        {memory.formedBy === "bot" && (
          <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
            From {memory.sourceApp ?? "a conversation"}
            {memory.observedAt
              ? `, read ${new Date(memory.observedAt).toLocaleString()}`
              : ""}
            {memory.sourceLink && (
              <>
                {" · "}
                <a href={memory.sourceLink} target="_blank" rel="noreferrer">
                  Open record
                </a>
              </>
            )}
          </ItemDescription>
        )}
        {!editing && save.error && (
          <p role="alert" className="text-destructive text-sm">
            {save.error.message}
          </p>
        )}
      </ItemContent>
      {canWrite ? (
        <ItemFooter className="flex-wrap justify-start">
          <Button
            aria-label={`Edit memory: ${clip(memory.content)}`}
            className="min-h-11"
            disabled={save.isPending}
            onClick={() => {
              save.reset();
              setEditing(true);
            }}
            ref={editButton}
            size="sm"
            variant="outline"
          >
            Edit
          </Button>
          {memory.reviewState === "unreviewed" && (
            <Button
              aria-label={`Confirm memory: ${clip(memory.content)}`}
              className="min-h-11"
              disabled={save.isPending}
              size="sm"
              variant="outline"
              onClick={() => update({ reviewState: "confirmed" })}
            >
              Confirm
            </Button>
          )}
          <Button
            aria-label={`Forget memory: ${clip(memory.content)}`}
            className="min-h-11"
            disabled={save.isPending}
            size="sm"
            variant="outline"
            onClick={(event) => onForget(event.currentTarget)}
          >
            Forget
          </Button>
          {heldByIntelligence ? null : (
            <ItemActions className="ms-auto gap-3 px-2">
              <Text aria-hidden="true" color="secondary" size="sm">
                Use memory
              </Text>
              {/* Binary and immediate: Bots stop or start using it when switched. */}
              <Switch
                aria-label={`Use this memory: ${clip(memory.content)}`}
                checked={memory.enabled}
                className="after:top-1/2 after:bottom-auto after:h-11 after:-translate-y-1/2"
                disabled={save.isPending}
                onCheckedChange={(enabled) => update({ enabled })}
              />
            </ItemActions>
          )}
        </ItemFooter>
      ) : null}
      {editing ? (
        <EditMemoryDialog
          canWrite={canWrite}
          memory={memory}
          onClose={() => setEditing(false)}
          onSave={(content) => {
            submitting.current = true;
            save.mutate(
              { id: memory.id, input: { content } },
              {
                onSuccess: () => setEditing(false),
                onSettled: () => {
                  submitting.current = false;
                },
              },
            );
          }}
          error={save.error?.message ?? null}
          finalFocus={() => editButton.current ?? fallbackFocus()}
          refresh={refresh}
          saving={save.isPending}
          submitting={submitting}
        />
      ) : null}
    </Item>
  );
}

function memoryOrigin(memory: MemoryRecord) {
  return memory.formedBy === "person" && memory.provenance === "You"
    ? "Added by you"
    : memory.provenance;
}

/**
 * Which Bots stop using a fact when it is forgotten.
 *
 * The reach is the server's, not a guess: a Bot-formed memory is recalled only by the Bot that
 * formed it, an imported one only through its source, and only a fact of the person's own reaches
 * every Bot of theirs. Saying "your Bots" for all three told somebody forgetting one Bot's fact
 * that every Bot would lose it.
 */
function forgetAudience(
  memory: MemoryRecord,
  botName: (id: string | null) => string,
) {
  if (memory.formedBy === "bot")
    return `Only ${botName(memory.formedByAgentId)} uses it.`;
  if (memory.formedBy === "import")
    return `Only Bots reading ${memory.sourceApp ?? memory.provenance} use it.`;
  return "All your Bots use it.";
}

/** A memory's words, cut short enough to name the switch beside them. */
function clip(content: string) {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The memory's words in a dialog. Saving rewrites them; the server records it as edited. */
function EditMemoryDialog({
  canWrite,
  memory,
  saving,
  error,
  onSave,
  onClose,
  finalFocus,
  refresh,
  submitting,
}: {
  canWrite: boolean;
  memory: MemoryRecord;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
  refresh?: MemoryRefresh;
  submitting: RefObject<boolean>;
}) {
  const [content, setContent] = useState(memory.content);
  const id = useId();
  const dirty = content.trim() !== memory.content.trim();
  return (
    <SettingsDraftDialog
      action={
        <Button
          className="min-h-11"
          disabled={!canWrite || saving || !content.trim() || !dirty}
          onClick={() => onSave(content)}
          size="sm"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      }
      description={memory.provenance}
      dirty={dirty}
      guardNavigation={submitting}
      onClose={onClose}
      open
      opener={finalFocus}
      saving={saving}
      title="Edit memory"
    >
      {refresh ? <MemoryDraftReadError {...refresh} /> : null}
      <Field>
        <FieldLabel className="sr-only" htmlFor={id}>
          Memory
        </FieldLabel>
        <Textarea
          autoFocus
          disabled={saving}
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
    </SettingsDraftDialog>
  );
}
