import { Stack } from "@astryxdesign/core/Stack";
import { IconPlugConnected, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useId, useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionIncomplete,
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
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
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { canKeepCachedRead } from "@/lib/client";
import {
  addMemorySourceMutationOptions,
  availableMemorySourcesQueryOptions,
  memorySourceActionMutationOptions,
  memorySourcesQueryOptions,
} from "@/lib/memory";

const syncLabel = {
  idle: "Not yet synced",
  running: "Syncing…",
  succeeded: "Up to date",
  error: "Couldn’t sync",
};

/**
 * Connected apps a Bot reads facts from. Given a Bot, only that Bot's sources, and a new one is that
 * Bot's without asking.
 *
 * Each source is a row; adding one is a dialog behind the section's action. The draft lives here
 * rather than in the dialog, so the Bot's read actions are already loaded when it opens.
 */
export function MemorySources({ agentId: fixedBot }: { agentId?: string }) {
  const queryClient = useQueryClient();
  const sources = useQuery(memorySourcesQueryOptions());
  const bots = useQuery(agentListQueryOptions());
  const [adding, setAdding] = useState(false);
  const [pickedBot, setAgentId] = useState("");
  const agentId = fixedBot ?? pickedBot;
  const [toolRef, setToolRef] = useState("");
  const [title, setTitle] = useState("");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const { requestConfirmation, confirmation } = useActionConfirmation();
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
  const add = useMutation(addMemorySourceMutationOptions(queryClient));
  const action = useMutation(memorySourceActionMutationOptions(queryClient));
  const changing = useRef(false);
  const shown = (
    canKeepCachedRead(sources.error) ? (sources.data ?? []) : []
  ).filter((source) => fixedBot === undefined || source.agentId === fixedBot);
  const canChange = sources.isSuccess && !action.isPending;
  const canAdd =
    canChange && !add.isPending && tools.isSuccess && Boolean(chosen);

  function changeSource(sourceId: string, name: "sync" | "enable" | "disable") {
    if (!canChange || changing.current) return;
    changing.current = true;
    void action
      .mutateAsync({ sourceId, name })
      .catch(() => undefined)
      .finally(() => {
        changing.current = false;
      });
  }
  return (
    <PageSection
      action={
        sources.isSuccess && shown.length > 0 ? (
          <Button
            className="min-h-11"
            onClick={() => {
              // The draft is kept on purpose; the last attempt's failure is not.
              setError("");
              add.reset();
              setAdding(true);
            }}
            size="sm"
            variant="ghost"
          >
            <IconPlus />
            Add source
          </Button>
        ) : null
      }
      description="Apps you connected that this Bot can read show up here, and you can add more. Sources refresh every 15 minutes. Only this Bot sees what they hold."
      title="App sources"
      headingRef={heading}
    >
      {confirmation}
      {sources.isPending ? (
        <ReadStatus kind="loading" message="Loading app sources…" />
      ) : null}
      {sources.error ? (
        <ReadError
          message={
            shown.length
              ? "Couldn’t refresh app sources"
              : "Couldn’t load app sources"
          }
          description={
            shown.length
              ? "Showing the last loaded sources. Retry to make changes."
              : undefined
          }
          focusAfterRetry={() => heading.current}
          retry={() => sources.refetch()}
          retryBelow
          retrying={sources.isFetching}
        />
      ) : null}
      {sources.isSuccess && shown.length === 0 ? (
        <PageEmpty
          action={
            <Button
              className="min-h-11"
              onClick={() => {
                // The draft is kept on purpose; the last attempt's failure is not.
                setError("");
                add.reset();
                setAdding(true);
              }}
              size="sm"
              variant="outline"
            >
              <IconPlus />
              Add source
            </Button>
          }
          icon={IconPlugConnected}
          title="No sources yet"
        >
          Apps this Bot can read from show up here.
        </PageEmpty>
      ) : null}
      {shown.length > 0 ? (
        <PageRows>
          {shown.map((source, index) => {
            const name =
              action.variables?.sourceId === source.id
                ? action.variables.name
                : undefined;
            const verb =
              name === "sync"
                ? "sync"
                : name === "enable"
                  ? "turn on"
                  : "turn off";
            const feedback = name && name !== "remove";
            return (
              <Fragment key={source.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconPlugConnected />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
                      {source.title}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {source.enabled
                        ? syncLabel[source.syncStatus]
                        : "Turned off"}
                      {source.lastSyncAt
                        ? ` · Last read ${new Date(source.lastSyncAt).toLocaleString()}`
                        : ""}
                    </ItemDescription>
                    {feedback && action.isError ? (
                      <p
                        role="alert"
                        className="text-destructive text-sm wrap-anywhere"
                      >
                        Couldn’t {verb} {source.title}.{" "}
                        {(name === "sync" && source.syncError) ||
                          action.error.message}
                      </p>
                    ) : source.syncError ? (
                      <p role="alert" className="text-destructive text-sm">
                        {source.syncError}
                      </p>
                    ) : null}
                    {feedback &&
                    (action.isPending ||
                      (action.isSuccess && sources.isSuccess)) ? (
                      <ItemDescription
                        className="line-clamp-none wrap-anywhere"
                        role="status"
                      >
                        {action.isPending
                          ? name === "sync"
                            ? `Syncing ${source.title}…`
                            : `Updating ${source.title}…`
                          : name === "sync"
                            ? `${source.title} synced.`
                            : `${source.title} is ${source.enabled ? "on" : "off"}.`}
                      </ItemDescription>
                    ) : null}
                    {/* A set, so it wraps onto its own line rather than crowding the title. */}
                    <ItemFooter>
                      <Stack direction="horizontal" gap={2} wrap="wrap">
                        <Button
                          aria-label={`Sync ${source.title} now`}
                          aria-disabled={
                            action.isPending || source.syncStatus === "running"
                          }
                          className="min-h-11"
                          size="sm"
                          variant="outline"
                          disabled={!source.enabled || !sources.isSuccess}
                          onClick={() => {
                            if (
                              source.enabled &&
                              source.syncStatus !== "running"
                            )
                              changeSource(source.id, "sync");
                          }}
                        >
                          Sync now
                        </Button>
                        <Button
                          aria-label={`Remove ${source.title}`}
                          className="min-h-11"
                          disabled={!canChange}
                          size="sm"
                          variant="outline"
                          onClick={(event) =>
                            requestConfirmation({
                              trigger: event.currentTarget,
                              fallbackFocus: () => heading.current,
                              title: `Remove ${source.title}?`,
                              description:
                                "This stops future reads and removes the memories already learned from this source.",
                              confirmLabel: "Remove source",
                              pendingLabel: "Removing…",
                              failureMessage:
                                "Couldn’t remove this source. Check the connection and try again.",
                              successMessage: `${source.title} removed.`,
                              refresh: sources.refetch,
                              run: async () => {
                                const current = await sources.refetch();
                                if (
                                  current.error &&
                                  !canKeepCachedRead(current.error)
                                )
                                  throw current.error;
                                if (current.error)
                                  throw new ActionIncomplete(
                                    "Couldn’t verify this source. Try again before removing it.",
                                  );
                                const latest = current.data?.find(
                                  ({ id }) => id === source.id,
                                );
                                if (
                                  !latest ||
                                  latest.agentId !== source.agentId ||
                                  latest.title !== source.title ||
                                  latest.toolRef !== source.toolRef
                                ) {
                                  throw new ActionUnavailable(
                                    "This source changed or is no longer available. Close this dialog and check the list.",
                                  );
                                }
                                await action.mutateAsync({
                                  sourceId: source.id,
                                  name: "remove",
                                });
                              },
                            })
                          }
                        >
                          Remove
                        </Button>
                      </Stack>
                    </ItemFooter>
                  </ItemContent>
                  <ItemActions>
                    {/* Binary and immediate: it refreshes, or stops refreshing, when switched. */}
                    <Switch
                      aria-disabled={action.isPending}
                      aria-label={`Read ${source.title}`}
                      checked={source.enabled}
                      disabled={!sources.isSuccess}
                      readOnly={action.isPending}
                      onCheckedChange={(enabled) =>
                        changeSource(source.id, enabled ? "enable" : "disable")
                      }
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      ) : null}
      <Dialog
        onOpenChange={(open, event) => {
          if (add.isPending) event.cancel();
          else setAdding(open);
        }}
        open={adding}
      >
        <DialogContent {...astryxScope}>
          <DialogHeader>
            <DialogTitle>Add a source</DialogTitle>
            <DialogDescription>
              OpenBot reads it now, then every 15 minutes while it's on.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            {sources.error ? (
              <ReadError
                message="Couldn’t verify the current sources"
                retry={sources.refetch}
                retryBelow
                retrying={sources.isFetching}
                retryLabel="Retry sources"
              />
            ) : null}
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={id}
              onSubmit={(event) => {
                event.preventDefault();
                if (!canAdd) return;
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
                        throw new Error(`Enter a number for ${setting.name}.`);
                      values[setting.name] = number;
                    } else if (setting.schema.type === "boolean")
                      values[setting.name] = value === "true";
                    else if (setting.schema.type === "array")
                      values[setting.name] = value
                        .split("\n")
                        .map((entry) => entry.trim())
                        .filter(Boolean);
                    else if (setting.schema.type === "object")
                      throw new Error(
                        "This one has settings OpenBot can't show. Choose another.",
                      );
                    else values[setting.name] = value;
                  }
                  setError("");
                  add.mutate(
                    {
                      agentId,
                      toolRef,
                      title,
                      args: values,
                    },
                    {
                      onSuccess: () => {
                        setTitle("");
                        setAdding(false);
                      },
                    },
                  );
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Check the source settings.",
                  );
                }
              }}
            >
              <FieldGroup>
                {fixedBot === undefined ? (
                  <Field>
                    <FieldLabel htmlFor={`${id}-bot`}>Bot</FieldLabel>
                    <Select
                      items={bots.data?.map((bot) => ({
                        value: bot.id,
                        label: bot.name,
                      }))}
                      onValueChange={(value) => {
                        setAgentId(value ?? "");
                        setToolRef("");
                      }}
                      required
                      value={agentId || null}
                    >
                      <SelectTrigger className="w-full" id={`${id}-bot`}>
                        <SelectValue placeholder="Choose a Bot" />
                      </SelectTrigger>
                      <SelectContent>
                        {bots.data?.map((bot) => (
                          <SelectItem key={bot.id} value={bot.id}>
                            {bot.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                <Field>
                  <FieldLabel htmlFor={`${id}-action`}>What to read</FieldLabel>
                  <Select
                    items={tools.data?.map((tool) => ({
                      value: tool.ref,
                      label: tool.title,
                    }))}
                    onValueChange={(value) => {
                      setToolRef(value ?? "");
                      setArgs({});
                    }}
                    required
                    value={toolRef || null}
                  >
                    <SelectTrigger className="w-full" id={`${id}-action`}>
                      <SelectValue placeholder="Choose what to read" />
                    </SelectTrigger>
                    <SelectContent>
                      {tools.data?.map((tool) => (
                        <SelectItem key={tool.ref} value={tool.ref}>
                          {tool.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {chosen?.description ? (
                    <FieldDescription>{chosen.description}</FieldDescription>
                  ) : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-name`}>Source name</FieldLabel>
                  <Input
                    id={`${id}-name`}
                    required
                    maxLength={160}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="My project documents"
                  />
                </Field>
                {settings.map(({ name, schema }) => (
                  <Field key={name}>
                    {/* `arg-` keeps a setting called `name` or `bot` off the fixed fields' ids. */}
                    <FieldLabel htmlFor={`${id}-arg-${name}`}>
                      {schema.title || name.replaceAll("_", " ")}
                      {required.includes(name) ? " *" : ""}
                    </FieldLabel>
                    {schema.type === "boolean" || schema.enum ? (
                      <Select
                        onValueChange={(value) =>
                          setArgs({ ...args, [name]: value ?? "" })
                        }
                        required={required.includes(name)}
                        value={args[name] || null}
                      >
                        <SelectTrigger
                          className="w-full"
                          id={`${id}-arg-${name}`}
                        >
                          <SelectValue placeholder="Choose a value" />
                        </SelectTrigger>
                        <SelectContent>
                          {(schema.enum ?? ["true", "false"]).map((value) => (
                            <SelectItem
                              key={String(value)}
                              value={String(value)}
                            >
                              {String(value)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={`${id}-arg-${name}`}
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
                      <FieldDescription>{schema.description}</FieldDescription>
                    )}
                  </Field>
                ))}
              </FieldGroup>
            </form>
            {tools.error ? (
              <ReadError
                message="Couldn’t load connected app actions"
                retry={tools.refetch}
                retryBelow
                retrying={tools.isFetching}
                retryLabel="Retry app actions"
              />
            ) : null}
            {(error || add.error) && (
              <p role="alert" className="text-destructive text-sm">
                {error || add.error?.message}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              className="min-h-11"
              disabled={add.isPending}
              onClick={() => setAdding(false)}
              size="sm"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={!canAdd}
              form={id}
              size="sm"
              type="submit"
            >
              {add.isPending ? "Reading source…" : "Add and sync source"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
