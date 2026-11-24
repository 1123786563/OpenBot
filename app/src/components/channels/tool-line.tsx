import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/**
 * One line for one thing a Bot did.
 *
 * Every tool call in the transcript draws through this, so a browser action, an MCP call and a
 * refusal read as the same kind of event. Detail stays behind a disclosure so the transcript keeps a
 * single-line action rhythm.
 *
 * While it is still running the text shimmers, which is the only signal that the Bot is working on
 * something with nothing to show yet.
 */
/** A label this short stays on one line: "Asked you", "Searched the web", "Fetch". */
const SHORT_LABEL = 32;

export function ToolLine({
  icon,
  label,
  attempted,
  detail,
  running,
  refused,
  failed,
  notYet,
  byYou,
  bare,
  children,
}: {
  /** Drawn before the label, small and muted. A group of steps puts its kinds here. */
  icon?: ReactNode;
  /** What was done, in a couple of words: "Searched Slack", "Filled in", "Read the page". */
  label: string;
  /**
   * What was tried, for a step that was refused: "Save file", not "Saved file". A refused step did
   * not happen, so its line says what was attempted. Without it the label is used.
   */
  attempted?: string;
  /** What it was done to. Muted, and truncated rather than wrapped. */
  detail?: string;
  running?: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused?: boolean;
  /** It was permitted and did not work. A different request might. */
  failed?: boolean;
  /**
   * Nothing was done yet, for an ordinary reason: a computer still starting turned the call away
   * before it reached anything. Muted like a success, because nothing went wrong, and labelled so it
   * does not read as one.
   */
  notYet?: boolean;
  /**
   * The step was handed to the person and they did it themselves. Muted like a success, because it
   * was done, and labelled so it does not read as the Bot having done it.
   */
  byYou?: boolean;
  /** Shown when the line is expanded. Without it the line is not expandable. */
  children?: ReactNode;
  /**
   * The expanded part grows with what it holds instead of scrolling, for children that bound
   * themselves: a group's list of steps, each of which folds its own result. One scrolling box
   * inside another left two scrollbars side by side.
   */
  bare?: boolean;
}) {
  const tone = refused
    ? "text-(--color-text-error)"
    : failed
      ? "text-(--color-text-warning)"
      : "text-muted-foreground";

  const text = (
    <Stack
      as="span"
      direction="horizontal"
      gap={1.5}
      align="start"
      maxWidth="100%"
      className={`min-w-0 items-baseline text-sm ${tone} ${
        running ? "tool-line-running" : ""
      }`}
    >
      {icon ? (
        <Text color="inherit" type="inherit" className="shrink-0 self-center">
          {icon}
        </Text>
      ) : null}
      {/*
       * Free to shrink, so a long label (a folded run's "Read 1 file, searched for 2 patterns and
       * listed 1 directory") wraps in a phone-width column instead of running past it. The detail
       * shrinks a hundred times faster, but even a hundred times faster still took a few pixels from
       * the label, enough to break "Asked you" over two lines beside a long question. So a label of a
       * few words never shrinks at all, and only a long one is left free to wrap.
       */}
      <Text
        as="span"
        color="inherit"
        type="inherit"
        className={
          label.length <= SHORT_LABEL ? "shrink-0 whitespace-nowrap" : "min-w-0"
        }
      >
        {refused
          ? `Blocked: ${attempted ?? label}`
          : failed
            ? `${label}, didn't work`
            : notYet
              ? `${label}, not done yet`
              : byYou
                ? `${label}, done by you`
                : label}
      </Text>
      {detail ? (
        <Text
          as="span"
          color="inherit"
          type="inherit"
          className="min-w-0 shrink-[100] truncate opacity-70"
        >
          {detail}
        </Text>
      ) : null}
    </Stack>
  );

  if (!children) return <Stack className="my-1.5">{text}</Stack>;

  return (
    <Collapsible
      chevronPosition="start"
      className="my-1.5 min-w-0"
      defaultIsOpen={false}
      trigger={text}
    >
      {/*
       * Headings are cut down to the size of the surrounding text. A tool result is markdown a
       * server wrote for a model, so its `#` is a section marker rather than a page title.
       */}
      <Stack
        className={`mt-2 border-l text-xs ${bare ? "" : "max-h-80 overflow-auto"} [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium`}
        paddingInlineStart={3}
      >
        {children}
      </Stack>
    </Collapsible>
  );
}
