import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import {
  ProactiveResearchSettings,
  SuggestionsInbox,
} from "@/components/suggestions/proactive-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import {
  addMemorySource,
  availableMemorySourcesQueryOptions,
  createMemory,
  deleteMemory,
  type MemoryRecord,
  memoriesQueryOptions,
  memoryKeys,
  memorySourceAction,
  memorySourcesQueryOptions,
  updateMemory,
} from "@/lib/memory";
import { queryClient } from "@/query-client";
export const Route = createFileRoute("/_authed/_app/memory")({
  component: MemoryPage,
});
// min-w-0 and w-full, or a select as wide as its longest option pushes its grid column off the card.
const field = "grid min-w-0 gap-1 text-sm";
const select =
  "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm";
async function refresh() {
  await queryClient.invalidateQueries({ queryKey: memoryKeys.all });
}
function MemoryPage() {
  const { t } = useTranslation("agents");
  const memories = useQuery(memoriesQueryOptions());
  const [content, setContent] = useState("");
  const formId = useId();
  const remember = useMutation({
    mutationFn: createMemory,
    onSuccess: async () => {
      setContent("");
      await refresh();
    },
  });
  return (
    <PageShell title={t("memory.title")} description={t("memory.description")}>
      <div className="grid gap-6">
        <SuggestionsInbox />
        <form
          className="grid gap-3 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            remember.mutate(content);
          }}
        >
          <h2 className="font-semibold">{t("memory.rememberFact")}</h2>
          <label className={field} htmlFor={formId}>
            {t("memory.factLabel")}
          </label>
          <Textarea
            id={formId}
            required
            maxLength={6000}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t("memory.factPlaceholder")}
          />
          <Button
            type="submit"
            disabled={remember.isPending || !content.trim()}
            className="justify-self-start"
          >
            {t("memory.remember")}
          </Button>
          {remember.error && (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {remember.error.message}
            </p>
          )}
        </form>
        <ProactiveResearchSettings />
        <Sources />
        <section className="grid gap-3">
          <h2 className="font-semibold">{t("memory.yourMemories")}</h2>
          {memories.isPending ? (
            <p>{t("memory.loadingMemories")}</p>
          ) : memories.error ? (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {t("memory.loadError")}
            </p>
          ) : memories.data?.length ? (
            memories.data.map((memory) => (
              <MemoryCard key={memory.id} memory={memory} />
            ))
          ) : (
            <p className="text-muted-foreground">{t("memory.noMemories")}</p>
          )}
        </section>
      </div>
    </PageShell>
  );
}
function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  const [content, setContent] = useState(memory.content);
  const id = useId();
  const save = useMutation({
    mutationFn: (input: {
      content?: string;
      enabled?: boolean;
      reviewState?: "confirmed";
    }) => updateMemory(memory.id, input),
    onSuccess: refresh,
  });
  const forget = useMutation({
    mutationFn: () => deleteMemory(memory.id),
    onSuccess: refresh,
  });
  return (
    <article className="grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <label htmlFor={id} className="text-sm text-muted-foreground">
          {memory.provenance}
        </label>
        <span className="text-xs text-muted-foreground">
          {!memory.enabled
            ? t("memory.card.disabled")
            : memory.reviewState === "unreviewed"
              ? memory.formedBy === "bot"
                ? t("memory.card.formedAwaiting")
                : t("memory.card.importedAwaiting")
              : t("memory.card.reviewed")}
        </span>
      </div>
      {memory.formedBy === "bot" && (
        <p className="text-xs text-muted-foreground">
          {t("memory.card.from", {
            source: memory.sourceApp ?? t("memory.card.aConversation"),
          })}
          {memory.observedAt
            ? t("memory.card.readSuffix", {
                when: formatDateTime(memory.observedAt),
              })
            : ""}
          {memory.sourceLink && (
            <>
              {" · "}
              <a
                className="underline"
                href={memory.sourceLink}
                target="_blank"
                rel="noreferrer"
              >
                {t("memory.card.openRecord")}
              </a>
            </>
          )}
        </p>
      )}
      <Textarea
        id={id}
        value={content}
        maxLength={6000}
        onChange={(event) => setContent(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={save.isPending || !content.trim()}
          onClick={() => save.mutate({ content })}
        >
          {t("memory.card.save")}
        </Button>
        {memory.reviewState === "unreviewed" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => save.mutate({ reviewState: "confirmed" })}
          >
            {t("memory.card.confirm")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => save.mutate({ enabled: !memory.enabled })}
        >
          {memory.enabled ? t("memory.card.disable") : t("memory.card.enable")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={forget.isPending}
          onClick={() => forget.mutate()}
        >
          {t("memory.card.forget")}
        </Button>
      </div>
      {(save.error || forget.error) && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {save.error?.message || forget.error?.message}
        </p>
      )}
    </article>
  );
}
function Sources() {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  const sources = useQuery(memorySourcesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [agentId, setAgentId] = useState("");
  const [toolRef, setToolRef] = useState("");
  const [title, setTitle] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const id = useId();
  const tools = useQuery(availableMemorySourcesQueryOptions(agentId));
  const chosen = tools.data?.find((tool) => tool.ref === toolRef);
  const properties = chosen?.inputSchema.properties;
  const settings =
    properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.entries(properties).flatMap(([name, value]) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? [
                {
                  name,
                  schema: value as {
                    type?: string;
                    title?: string;
                    description?: string;
                    enum?: unknown[];
                  },
                },
              ]
            : [],
        )
      : [];
  const required = Array.isArray(chosen?.inputSchema.required)
    ? chosen.inputSchema.required
    : [];
  const add = useMutation({
    mutationFn: addMemorySource,
    onSuccess: async () => {
      setTitle("");
      await refresh();
    },
  });
  const action = useMutation({
    mutationFn: ({
      sourceId,
      name,
    }: {
      sourceId: string;
      name: "sync" | "remove" | "enable" | "disable";
    }) => memorySourceAction(sourceId, name),
    onSuccess: refresh,
  });
  return (
    <section className="grid gap-3">
      <h2 className="font-semibold">{t("memory.sources.title")}</h2>
      <p className="text-sm text-muted-foreground">
        {t("memory.sources.description")}
      </p>
      <form
        className="grid gap-3 rounded-lg border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            const values: Record<string, unknown> = {};
            for (const setting of settings) {
              const value = args[setting.name];
              if (!value) continue;
              if (
                setting.schema.type === "number" ||
                setting.schema.type === "integer"
              ) {
                const number = Number(value);
                if (!Number.isFinite(number))
                  throw new Error(
                    t("memory.sources.numberError", { name: setting.name }),
                  );
                values[setting.name] = number;
              } else if (setting.schema.type === "boolean")
                values[setting.name] = value === "true";
              else if (setting.schema.type === "array")
                values[setting.name] = value
                  .split("\n")
                  .map((entry) => entry.trim())
                  .filter(Boolean);
              else if (setting.schema.type === "object")
                throw new Error(t("memory.sources.simpleSettings"));
              else values[setting.name] = value;
            }
            setError("");
            add.mutate({
              agentId,
              toolRef,
              title,
              args: values,
            });
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : t("memory.sources.checkSettings"),
            );
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            {t("memory.sources.bot")}
            <select
              required
              className={select}
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                setToolRef("");
              }}
            >
              <option value="">{t("memory.sources.chooseBot")}</option>
              {bots.data?.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            {t("memory.sources.action")}
            <select
              required
              className={select}
              value={toolRef}
              onChange={(event) => {
                setToolRef(event.target.value);
                setArgs({});
              }}
            >
              <option value="">{t("memory.sources.chooseAction")}</option>
              {tools.data?.map((tool) => (
                <option key={tool.ref} value={tool.ref}>
                  {tool.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {chosen && (
          <p className="text-sm text-muted-foreground">{chosen.description}</p>
        )}
        <label className={field} htmlFor={`${id}-name`}>
          {t("memory.sources.sourceName")}
          <Input
            id={`${id}-name`}
            required
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("memory.sources.sourceNamePlaceholder")}
          />
        </label>
        {settings.map(({ name, schema }) => (
          <label key={name} className={field} htmlFor={`${id}-${name}`}>
            {schema.title || name.replaceAll("_", " ")}
            {required.includes(name) ? " *" : ""}
            {schema.type === "boolean" || schema.enum ? (
              <select
                id={`${id}-${name}`}
                className={select}
                value={args[name] ?? ""}
                required={required.includes(name)}
                onChange={(event) =>
                  setArgs({ ...args, [name]: event.target.value })
                }
              >
                <option value="">{t("memory.sources.chooseValue")}</option>
                {(schema.enum ?? ["true", "false"]).map((value) => (
                  <option key={String(value)} value={String(value)}>
                    {String(value)}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`${id}-${name}`}
                type={
                  schema.type === "number" || schema.type === "integer"
                    ? "number"
                    : "text"
                }
                required={required.includes(name)}
                value={args[name] ?? ""}
                onChange={(event) =>
                  setArgs({ ...args, [name]: event.target.value })
                }
              />
            )}
            {schema.description && (
              <span className="text-xs text-muted-foreground">
                {schema.description}
              </span>
            )}
          </label>
        ))}
        <Button
          type="submit"
          className="justify-self-start"
          disabled={add.isPending || !toolRef}
        >
          {add.isPending
            ? t("memory.sources.reading")
            : t("memory.sources.addAndSync")}
        </Button>
        {(error || add.error || tools.error) && (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {error || add.error?.message || tools.error?.message}
          </p>
        )}
      </form>
      {sources.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {sources.error.message}
        </p>
      )}
      {sources.data?.map((source) => (
        <article key={source.id} className="grid gap-2 rounded-lg border p-4">
          <div className="flex justify-between">
            <strong>{source.title}</strong>
            <span className="text-sm text-muted-foreground">
              {source.enabled
                ? source.syncStatus === "succeeded"
                  ? t("memory.sources.upToDate")
                  : source.syncStatus
                : t("memory.sources.disabled")}
            </span>
          </div>
          {source.lastSyncAt && (
            <p className="text-xs text-muted-foreground">
              {t("memory.sources.lastRead", {
                when: formatDateTime(source.lastSyncAt),
              })}
            </p>
          )}
          {source.syncError && (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {source.syncError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!source.enabled || action.isPending}
              onClick={() =>
                action.mutate({ sourceId: source.id, name: "sync" })
              }
            >
              {t("memory.sources.syncNow")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate({
                  sourceId: source.id,
                  name: source.enabled ? "disable" : "enable",
                })
              }
            >
              {source.enabled
                ? t("memory.sources.disable")
                : t("memory.sources.enable")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                action.mutate({ sourceId: source.id, name: "remove" })
              }
            >
              {t("memory.sources.remove")}
            </Button>
          </div>
        </article>
      ))}
      {action.error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {action.error.message}
        </p>
      )}
    </section>
  );
}
