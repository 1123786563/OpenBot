import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useCopilotChatConfiguration } from "@copilotkit/react-core/v2";
import { humanise, readToolName } from "@openbot/shared/tool-name";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useContext, useState } from "react";
import { TurnInFlightContext } from "@/components/gallery/streaming";
import { subagentStepsQueryOptions } from "@/lib/subagents/queries";
import { toVisibleChatItems, type VisibleChatItem } from "./chat-messages";
import {
  type StepDetails,
  StepIcon,
  StepOutput,
  StepRow,
  stepDetails,
} from "./tool-activity";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/**
 * A piece of work a Bot gave to a subagent, as one step of the line its turn's work folds into.
 *
 * A subagent is the same Bot run again on one part of the work, in a thread of its own, so its steps
 * are not in this conversation at all. This row is where the person finds them: one line saying it
 * was a subtask, what it was asked and how it ended, which opens to the task, its answer and each
 * step it took, read from its own thread.
 *
 * IT USED TO BE A CARD. Task, status badge, a clamped answer and a disclosure for its steps, drawn
 * on its own between the question and the answer. A Bot that started three subtasks beside a search
 * drew five boxes for one question, and one that stopped before an approval wore a "Needs your
 * approval" badge with nothing to press while the Bot went on working. Now it is one more thing the
 * Bot did, next to the searches and pages, and the approval card, when there is one, is the Bot's.
 *
 * Its steps are read only once the row is opened. A closed row needs nothing from its thread: how
 * it ended is in the call's own result, and while it works the folded line says so.
 *
 * Called a subtask on screen, because that is what the person is looking at: part of what they
 * asked for, being done on its own. "Agent" is a word OpenBot keeps for software somebody brings.
 */
export function SubtaskStep({
  step,
  active,
}: {
  step: StepDetails;
  /** The turn this step belongs to is still in flight. */
  active: boolean;
}) {
  const chat = useCopilotChatConfiguration();
  const [open, setOpen] = useState(false);
  const toolCallId = step.subtask?.toolCallId ?? step.id;
  const result = step.subtask?.result ?? null;
  /*
   * Running while its turn is, whichever row it is in: a component the Bot drew in the same step can
   * land below it, and the group is then not the newest row, though the subagent is still working.
   */
  const inFlight = useContext(TurnInFlightContext);
  const running = (active || inFlight) && step.pending;
  const options = subagentStepsQueryOptions({
    toolCallId,
    parentThreadId: chat?.threadId,
    threadId: result?.threadId,
    agentId: chat?.agentId ?? "default",
    live: running,
  });
  const thread = useQuery({
    ...options,
    enabled: open && options.enabled !== false,
  });
  const steps = (thread.data ? toVisibleChatItems(thread.data.messages) : [])
    .filter((item): item is ToolItem => item.kind === "tool")
    .map(stepDetails);
  const count = Math.max(steps.length, result?.steps ?? 0);
  const handedBack =
    result && "handedBack" in result ? result.handedBack : null;

  return (
    <li className="min-w-0">
      <details
        className="tool-line min-w-0"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5">
          <Text
            as="span"
            aria-hidden
            className="tool-line-chevron shrink-0 transition-transform"
            color="secondary"
            size="sm"
          >
            ▸
          </Text>
          <Stack
            as="span"
            direction="horizontal"
            align="center"
            gap={2}
            className="min-w-0"
          >
            <StepIcon kind="subtask" />
            {/* Shimmers while it works, as every running step does. See `StepRow`. */}
            <Text
              as="span"
              className={running ? "shrink-0 tool-line-running" : "shrink-0"}
              color="inherit"
            >
              {step.label}
            </Text>
            {step.detail ? (
              <Text as="span" className="truncate" color="secondary">
                {step.detail}
              </Text>
            ) : null}
            <SubtaskStatus
              count={count}
              handedBack={handedBack !== null}
              running={running}
              step={step}
            />
          </Stack>
        </summary>
        <Stack className="mt-1.5 pl-5" gap={2}>
          {step.subtask?.task ? (
            <Text
              as="p"
              className="whitespace-pre-wrap break-words"
              color="secondary"
            >
              {step.subtask.task}
            </Text>
          ) : null}
          {handedBack ? <HandedBack {...handedBack} /> : null}
          {step.output ? <StepOutput output={step.output} /> : null}
          {steps.length ? (
            <ol className="space-y-2">
              {steps.map((inner) => (
                <StepRow active={running} key={inner.id} step={inner} />
              ))}
            </ol>
          ) : null}
        </Stack>
      </details>
    </li>
  );
}

/** How the subtask ended, beside its line. A finished one says only how many steps it took. */
function SubtaskStatus({
  step,
  running,
  handedBack,
  count,
}: {
  step: StepDetails;
  running: boolean;
  handedBack: boolean;
  count: number;
}) {
  const steps = count > 0 ? `${count} ${count === 1 ? "step" : "steps"}` : "";
  if (running)
    return (
      <Text as="span" className="shrink-0" color="secondary">
        {steps ? `Working · ${steps}` : "Working"}
      </Text>
    );
  if (step.pending)
    return (
      <Text as="span" className="shrink-0" color="secondary">
        Not completed
      </Text>
    );
  if (step.refused)
    return (
      <Stack as="span" className="shrink-0 text-(--color-text-error)">
        <Text as="span" color="inherit" type="inherit">
          Blocked
        </Text>
      </Stack>
    );
  if (handedBack)
    return (
      <Text as="span" className="shrink-0" color="secondary">
        Handed back
      </Text>
    );
  if (step.failed)
    return (
      <Stack as="span" className="shrink-0 text-(--color-text-warning)">
        <Text as="span" color="inherit" type="inherit">
          Didn't finish
        </Text>
      </Stack>
    );
  return steps ? (
    <Text as="span" className="shrink-0" color="secondary">
      {steps}
    </Text>
  ) : null;
}

/**
 * The action the subagent stopped before, said plainly. Nothing was done and nobody was asked. The
 * Bot does it itself if it still needs doing, and the person is asked then, on the Bot's own card.
 */
function HandedBack({ tool, args }: { tool: string; args: unknown }) {
  const { label, detail } = tool.startsWith("mcp__")
    ? readToolName(tool)
    : { label: humanise(tool.replace(/^computer_/, "")), detail: undefined };
  const inputs =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [];
  return (
    <Stack as="section" aria-label="Handed back" gap={1}>
      <Text as="p">
        It stopped before a step that needs your approval. If the step still
        needs doing, the Bot asks you in this conversation.
      </Text>
      <Text as="p" weight="medium">
        {label}
        {detail ? ` on ${detail}` : ""}
      </Text>
      {inputs.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
          {inputs.map(([key, value]) => (
            <Fragment key={key}>
              <dt>{key}</dt>
              <dd className="min-w-0 break-words text-foreground/80">
                {typeof value === "string" ? value : JSON.stringify(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </Stack>
  );
}
