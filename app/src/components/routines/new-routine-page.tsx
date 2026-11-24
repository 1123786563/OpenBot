import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { AstryxSurface, astryxScope } from "@/components/astryx-pilot/theme";
import { ExecutionBudgetDialog } from "@/components/billing/execution-budget-dialog";
import { PageCard, PageShell } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { RoutineAction } from "@/components/routines/routine-action";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { untitledLine } from "@/lib/channels/label";
import {
  type ChannelSummary,
  channelListQueryOptions,
} from "@/lib/channels/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  browserTimeZone,
  cronFrom,
  MONTH_DAYS,
  NEW_CONVERSATION,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  type RoutineFormValues,
  routineFormSchema,
  scheduleSentence,
  WEEKDAY_LABEL,
} from "@/lib/routines/form";
import {
  createRoutineMutationOptions,
  type RoutineInput,
} from "@/lib/routines/mutations";
import { openingOf } from "@/lib/voice/cut";
import { queryClient } from "@/query-client";

/** The conversations a routine for this Bot may post in: live ones the Bot is in. */
function conversationsWith(
  channels: ChannelSummary[] | undefined,
  agentId: string,
): ChannelSummary[] {
  return (channels ?? []).filter(
    (channel) =>
      channel.active && !channel.task && channel.agentIds.includes(agentId),
  );
}

function conversationName(channel: ChannelSummary): string {
  const title = (channel.summary || untitledLine(channel) || "").trim();
  // What the sidebar calls one nobody has named or written in yet.
  return title ? openingOf(title, 60) : "New conversation";
}

const MONTH_DAY_LABEL = Object.fromEntries(
  MONTH_DAYS.map((day) => [day, day]),
) as Record<string, string>;

const WEEKDAY_ITEMS = Object.fromEntries(
  WEEKDAY_LABEL.map((label, index) => [String(index), label]),
) as Record<string, string>;

/**
 * New routine, on a screen of its own: a Bot, what it does, when, and where it posts.
 *
 * The shape other assistants use for scheduled work. A frequency picker with a time, read back as
 * a sentence, and a way out for anything the picker does not cover: ask the Bot, which writes any
 * schedule through the same store this page does. `agentId` and `channelId` arrive pre-filled from
 * a Bot's Routines page and from the clock beside a conversation's message box.
 */
type RoutineCreateProps = { agentId?: string; channelId?: string };

export function NewRoutinePage(props: RoutineCreateProps) {
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <RoutineCreateForm {...props} />
    </AstryxSurface>
  );
}

function RoutineCreateForm({
  agentId: presetAgentId,
  channelId: presetChannelId,
}: RoutineCreateProps) {
  const navigate = useNavigate();
  const agents = useQuery(agentListQueryOptions());
  const channels = useInfiniteQuery(channelListQueryOptions());
  const createRoutine = useMutation(createRoutineMutationOptions(queryClient));
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const [budgetedInput, setBudgetedInput] = useState<RoutineInput>();
  async function create(input: RoutineInput) {
    await createRoutine.mutateAsync(input);
    await navigate({
      to: "/routines",
      ignoreBlocker: true,
      replace: true,
      state: { routineCreated: true },
    });
  }
  const submitting = useRef(false);
  const botPicker = useRef<HTMLButtonElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const failed = createRoutine.isError;
  useEffect(() => {
    if (failed && document.activeElement === document.body)
      errorNotice.current?.focus();
  }, [failed]);
  const timeZone = browserTimeZone();
  const timeZoneName =
    new Intl.DateTimeFormat("en", {
      timeZone,
      timeZoneName: "longGeneric",
    })
      .formatToParts()
      .find(({ type }) => type === "timeZoneName")?.value ?? timeZone;

  const defaultValues: RoutineFormValues = {
    agentId: presetAgentId ?? "",
    instruction: "",
    title: "",
    repeat: "weekdays",
    time: "09:00",
    weekday: "1",
    monthDay: "1",
    channelId:
      presetChannelId && presetAgentId ? presetChannelId : NEW_CONVERSATION,
  };

  const form = useForm({
    defaultValues,
    validators: { onSubmit: routineFormSchema },
    onSubmitMeta: { useCredits: false },
    onSubmit: async ({ value, meta }) => {
      const input: RoutineInput = {
        agentId: value.agentId,
        instruction: value.instruction.trim(),
        ...(value.title.trim() ? { title: value.title.trim() } : {}),
        cron: cronFrom(value),
        timezone: timeZone,
        channelId: value.channelId,
      };
      if (meta.useCredits) setBudgetedInput(input);
      else await create(input);
    },
  });

  async function submitRoutine(useCredits = false) {
    if (submitting.current || !agents.isSuccess || createRoutine.isPending)
      return;
    submitting.current = true;
    try {
      await form.handleSubmit({ useCredits });
    } catch {
      // The mutation state supplies the inline error.
    } finally {
      submitting.current = false;
    }
  }

  const botItems = Object.fromEntries(
    (agents.data ?? []).map((agent) => [agent.id, agent.name]),
  ) as Record<string, string>;

  return (
    <PageShell
      backButton={{ label: "Routines", linkProps: { to: "/routines" } }}
      description="Set up recurring work for a Bot and choose where it posts the results."
      title="New routine"
    >
      {budgetedInput ? (
        <ExecutionBudgetDialog
          title="Set a Routine budget"
          onClose={() => setBudgetedInput(undefined)}
          submit={(budgetId) => create({ ...budgetedInput, budgetId })}
        />
      ) : null}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submitRoutine();
        }}
      >
        <form.Subscribe
          selector={(state) => [!state.isDefaultValue, state.isSubmitting]}
        >
          {([hasDraft, saving]) => (
            <DraftLeaveConfirmation
              description="The Bot, instructions, and schedule you entered will be lost."
              hasDraft={hasDraft}
              saving={saving}
              submitting={submitting}
              title="Discard this routine draft?"
            />
          )}
        </form.Subscribe>
        <PageCard
          footer={
            <>
              <Link
                className={buttonVariants({
                  className: "min-h-11",
                  variant: "outline",
                })}
                to="/routines"
              >
                Cancel
              </Link>
              {capabilities?.testCreditConversations ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={createRoutine.isPending}
                  onClick={() => void submitRoutine(true)}
                >
                  Create using Credits
                </Button>
              ) : null}
              <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting]}
              >
                {([canSubmit, isSubmitting]) => (
                  <RoutineAction
                    disabled={
                      !canSubmit ||
                      !agents.isSuccess ||
                      isSubmitting ||
                      createRoutine.isPending
                    }
                    type="submit"
                  >
                    {isSubmitting || createRoutine.isPending
                      ? "Creating…"
                      : "Create routine"}
                  </RoutineAction>
                )}
              </form.Subscribe>
            </>
          }
        >
          <FieldGroup>
            <form.Field name="agentId">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Bot</FieldLabel>
                    {agents.isPending ? (
                      <ReadStatus kind="loading" message="Loading your Bots…" />
                    ) : agents.error ? (
                      <ReadError
                        focusAfterRetry={() => botPicker.current}
                        message="Couldn't load your Bots."
                        retry={agents.refetch}
                        retryBelow
                        retryLabel="Retry loading Bots"
                        retrying={agents.isFetching}
                      />
                    ) : null}
                    <Select
                      disabled={!agents.isSuccess}
                      items={botItems}
                      onValueChange={(value) => {
                        const next = String(value ?? "");
                        field.handleChange(next);
                        // Another Bot is in other conversations: start a new one unless this one is shared.
                        const current = form.getFieldValue("channelId");
                        if (
                          !conversationsWith(channels.data, next).some(
                            (channel) => channel.id === current,
                          )
                        ) {
                          form.setFieldValue("channelId", NEW_CONVERSATION);
                        }
                      }}
                      value={field.state.value || null}
                    >
                      <SelectTrigger
                        aria-invalid={isInvalid}
                        className="min-h-11 w-full"
                        id={field.name}
                        ref={botPicker}
                      >
                        <SelectValue placeholder="Choose a Bot" />
                      </SelectTrigger>
                      <SelectContent {...astryxScope}>
                        <SelectGroup>
                          {(agents.data ?? []).map((agent) => (
                            <SelectItem key={agent.id} value={agent.id}>
                              {/* Hidden: the name beside it already says who. */}
                              <span aria-hidden="true" className="contents">
                                <AbstractAvatar
                                  name={agent.name}
                                  seed={agent.avatarSeed}
                                  size={18}
                                />
                              </span>
                              {agent.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            <form.Field name="instruction">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>What to do</FieldLabel>
                    <FieldDescription id="routine-instruction-help">
                      Describe what the Bot should do each time it runs. For
                      example, “Send me a summary of yesterday’s new leads.”
                    </FieldDescription>
                    <Textarea
                      aria-describedby="routine-instruction-help"
                      aria-invalid={isInvalid}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      rows={3}
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>

            <Field>
              <FieldLabel htmlFor="repeat">When</FieldLabel>
              <div className="flex flex-wrap gap-3">
                <form.Field name="repeat">
                  {(field) => (
                    <Select
                      items={REPEAT_LABEL}
                      onValueChange={(value) =>
                        field.handleChange(value as Repeat)
                      }
                      value={field.state.value}
                    >
                      <SelectTrigger
                        aria-describedby="routine-schedule-preview"
                        className="min-h-11 min-w-40 flex-1"
                        id="repeat"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent {...astryxScope}>
                        <SelectGroup>
                          {REPEATS.map((repeat) => (
                            <SelectItem key={repeat} value={repeat}>
                              {REPEAT_LABEL[repeat]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                </form.Field>
                <form.Subscribe selector={(state) => state.values.repeat}>
                  {(repeat) => (
                    <>
                      {repeat === "weekly" ? (
                        <form.Field name="weekday">
                          {(field) => (
                            <Select
                              items={WEEKDAY_ITEMS}
                              onValueChange={(value) =>
                                field.handleChange(String(value))
                              }
                              value={field.state.value}
                            >
                              <SelectTrigger
                                aria-describedby="routine-schedule-preview"
                                aria-label="Day of the week"
                                className="min-h-11 min-w-36 flex-1"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent {...astryxScope}>
                                <SelectGroup>
                                  {WEEKDAY_LABEL.map((label, index) => (
                                    <SelectItem
                                      key={label}
                                      value={String(index)}
                                    >
                                      {label}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          )}
                        </form.Field>
                      ) : null}
                      {repeat === "monthly" ? (
                        <form.Field name="monthDay">
                          {(field) => (
                            <Select
                              items={MONTH_DAY_LABEL}
                              onValueChange={(value) =>
                                field.handleChange(String(value))
                              }
                              value={field.state.value}
                            >
                              <SelectTrigger
                                aria-describedby="routine-schedule-preview"
                                aria-label="Day of the month"
                                className="min-h-11 min-w-24"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent {...astryxScope}>
                                <SelectGroup>
                                  {MONTH_DAYS.map((day) => (
                                    <SelectItem key={day} value={day}>
                                      {day}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              </SelectContent>
                            </Select>
                          )}
                        </form.Field>
                      ) : null}
                      {repeat === "hourly" ? null : (
                        <form.Field name="time">
                          {(field) => (
                            <Input
                              aria-describedby="routine-schedule-preview"
                              aria-label="Time"
                              className="min-h-11 w-32"
                              onChange={(event) =>
                                field.handleChange(event.target.value)
                              }
                              step={900}
                              type="time"
                              value={field.state.value}
                            />
                          )}
                        </form.Field>
                      )}
                    </>
                  )}
                </form.Subscribe>
              </div>
              <form.Subscribe selector={(state) => state.values}>
                {(values) => (
                  <FieldDescription id="routine-schedule-preview">
                    {scheduleSentence(values)} ({timeZoneName}). For a schedule
                    like every other Tuesday, ask the Bot in a conversation.
                  </FieldDescription>
                )}
              </form.Subscribe>
            </Field>

            <form.Subscribe selector={(state) => state.values.agentId}>
              {(agentId) => {
                const shared = conversationsWith(channels.data, agentId);
                // The conversation the clock was pressed in, second and called what it is to the
                // person who just left it, even when it is past the roster's first page. The server
                // still checks the Bot is in it.
                const here =
                  presetChannelId && agentId === presetAgentId
                    ? { [presetChannelId]: "This conversation" }
                    : {};
                const items: Record<string, string> = {
                  [NEW_CONVERSATION]: "A new conversation",
                  ...here,
                  ...Object.fromEntries(
                    shared.map((channel) => [
                      channel.id,
                      conversationName(channel),
                    ]),
                  ),
                  ...here,
                };
                const choices = Object.entries(items);
                return (
                  <form.Field name="channelId">
                    {(field) => (
                      <Field>
                        <FieldLabel htmlFor={field.name}>Posts in</FieldLabel>
                        <FieldDescription id="routine-destination-help">
                          {field.state.value === NEW_CONVERSATION
                            ? "OpenBot creates one conversation for this routine, with the routine name or the first part of your instructions."
                            : "Each run posts its result in the selected conversation."}
                        </FieldDescription>
                        <Select
                          disabled={!agentId}
                          items={items}
                          onValueChange={(value) =>
                            field.handleChange(String(value))
                          }
                          value={
                            field.state.value in items
                              ? field.state.value
                              : NEW_CONVERSATION
                          }
                        >
                          <SelectTrigger
                            aria-describedby="routine-destination-help"
                            className="min-h-11 w-full"
                            id={field.name}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent {...astryxScope}>
                            <SelectGroup>
                              {choices.map(([value, label]) => (
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                  </form.Field>
                );
              }}
            </form.Subscribe>

            <form.Field name="title">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <FieldDescription>
                      Optional. The Routines page shows it by this name.
                    </FieldDescription>
                    <Input
                      aria-invalid={isInvalid}
                      className="min-h-11"
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                      placeholder="Morning leads"
                      value={field.state.value}
                    />
                    {isInvalid ? (
                      <FieldError errors={field.state.meta.errors} />
                    ) : null}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>
          {createRoutine.error ? (
            <p
              className="mt-5 text-destructive text-sm"
              role="alert"
              ref={errorNotice}
              tabIndex={-1}
            >
              {createRoutine.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </PageShell>
  );
}
