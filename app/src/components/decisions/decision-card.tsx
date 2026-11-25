import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { IconCheck } from "@tabler/icons-react";
import { type RegisterableHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Badge, type Tone } from "@/components/gallery/frame";
import { EASE_OUT } from "@/lib/motion";
import { useNewestDecision } from "./newest-decision";

/** One answer a person can give. */
export type DecisionOption = {
  value: string;
  label: string;
  /** What picking it does, in a line. */
  description?: string;
};

/** The answer, once given: drawn as one line where the choices were. */
export type DecisionAnswer = {
  /** The badge: "Approved", "Declined", "Answered". */
  label: string;
  /** The line under it, when it says more than the badge: the option picked, in its own words. */
  choice?: string;
  /** Words the person typed with it, if any. */
  note?: string;
  tone: Tone;
};

/** The value the "something else" row submits. */
export const OTHER = "__other__";

const COLLAPSE_SECONDS = 0.22;

/**
 * A card that waits on a person's answer: a Bot's question, a Bot asking for approval, or OpenBot
 * asking before a Bot uses an app.
 *
 * Laid out as T3 Code lays out its questions: the answers are rows, each with what it does under
 * it, the first picked to start with, and one button at the bottom right that sends the picked one
 * and is named for it, so it always says what pressing it will do. Where the Bot can take words
 * instead of a choice, the last row is a field for them.
 *
 * THE KEYBOARD. 1 to 9 pick a row and Enter sends it, as in T3 Code, but only on the newest card
 * that is waiting (`useNewestDecision`), so two cards never both take a key, and never while the
 * person is typing somewhere (TanStack's single-key hotkeys skip inputs and contenteditable, so
 * the message box keeps every digit). The rows are Astryx radios, so Up and Down move between them.
 *
 * ANSWERING FOLDS THE CARD. The rows and the button close up and the answer takes their place as one
 * line, so a conversation that asked ten things does not stay ten cards tall. Shown already folded
 * when the card is drawn answered (`initial={false}`), and without movement for anybody who asked
 * for less of it.
 */
export function DecisionCard({
  title,
  caption,
  children,
  options,
  other,
  answer,
  onSubmit,
  submitting = false,
  error,
}: {
  title: string;
  /** One line under the title: why this is being asked. */
  caption?: ReactNode;
  /** What the person needs to decide, between the header and the answers. */
  children?: ReactNode;
  options: DecisionOption[];
  /** Offer a last row for words instead of a choice. */
  other?: { placeholder: string };
  /** Set once answered. */
  answer?: DecisionAnswer;
  onSubmit: (value: string, text: string) => void;
  /** An answer is on its way: everything holds still. */
  submitting?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const [picked, setPicked] = useState(options[0]?.value ?? OTHER);
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLElement>(null);
  const waiting = !answer;
  const keyed = useNewestDecision(id, waiting && !submitting);

  const values = [...options.map((option) => option.value)];
  if (other) values.push(OTHER);
  const pickedOption = options.find((option) => option.value === picked);
  const canSend = !submitting && (picked !== OTHER || text.trim().length > 0);
  /*
   * A fast double press reaches this once. The rows stay open until the caller reports the answer on
   * its way, so a double click on the button, or Enter twice in a row, used to ask twice: the
   * server refuses the second decision and the conversation was carried on from the first only by
   * luck of ordering.
   */
  const sent = useRef(false);
  const send = () => {
    if (!canSend || sent.current) return;
    sent.current = true;
    onSubmit(picked, picked === OTHER ? text.trim() : "");
  };
  useEffect(() => {
    // Nobody told the card the answer is on its way, or it came back refused: it can be pressed again.
    if (!submitting) sent.current = false;
  }, [submitting]);
  const pick = (value: string) => {
    setPicked(value);
    if (value === OTHER) field.current?.focus();
  };

  useHotkeys(
    [
      ...values.slice(0, 9).map((value, index) => ({
        hotkey: String(index + 1) as RegisterableHotkey,
        callback: () => pick(value),
      })),
      {
        hotkey: "Enter" as RegisterableHotkey,
        /*
         * Only when nothing else has focus, or this card does. Enter on a focused link or button
         * elsewhere is that control's, and must not answer a card the person is not looking at.
         */
        callback: (event) => {
          const focused = document.activeElement;
          if (
            focused &&
            focused !== document.body &&
            !card.current?.contains(focused)
          )
            return;
          event.preventDefault();
          send();
        },
        options: { preventDefault: false },
      },
    ],
    { enabled: keyed, conflictBehavior: "allow" },
  );

  const fold = {
    duration: reduceMotion ? 0 : COLLAPSE_SECONDS,
    ease: EASE_OUT,
  };

  return (
    <Stack
      as="figure"
      ref={card}
      className="my-2 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card dark:border-transparent"
      data-slot="decision-card"
    >
      <Stack
        as="figcaption"
        direction="horizontal"
        gap={4}
        paddingInline={4}
        paddingBlockStart={3}
        paddingBlockEnd={2}
      >
        <Stack minHeight={0} className="flex-1" gap={0.5}>
          <Text as="p" weight="medium" size="base">
            {title}
          </Text>
          {caption ? (
            <Text as="p" color="secondary" size="sm">
              {caption}
            </Text>
          ) : null}
        </Stack>
        {/* Swapped in place, so the badge's change of word is the only thing that moves. */}
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            animate={{ opacity: 1, scale: 1 }}
            // The title's line height, centred, so the badge sits level with the title.
            className="flex h-5 shrink-0 items-center"
            exit={{ opacity: 0, scale: 0.9 }}
            initial={{ opacity: 0, scale: 0.9 }}
            key={answer ? "answered" : "waiting"}
            transition={fold}
          >
            {answer ? (
              <Badge tone={answer.tone}>{answer.label}</Badge>
            ) : (
              <Badge tone="caution">Waiting on you</Badge>
            )}
          </motion.span>
        </AnimatePresence>
      </Stack>

      <AnimatePresence initial={false}>
        {waiting ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            initial={{ height: 0, opacity: 0 }}
            key="choices"
            style={{ overflow: "hidden" }}
            transition={fold}
          >
            {children ? (
              <Stack paddingInline={4} paddingBlockEnd={3}>
                {children}
              </Stack>
            ) : null}
            {/*
             * Astryx radios, one group per card: the browser gives them the radio group's keys
             * (Tab to the picked row, Up and Down to move) and screen readers name them as choices.
             */}
            <Stack
              gap={2}
              paddingInline={4}
              paddingBlock={2}
              className="border-border border-t"
            >
              <RadioList
                htmlName={id}
                isDisabled={submitting}
                isLabelHidden
                label={title}
                onChange={pick}
                value={picked}
              >
                {options.map((option, index) => (
                  <RadioListItem
                    description={
                      option.description ? (
                        <Text
                          as="span"
                          className="min-w-0 break-words"
                          type="inherit"
                        >
                          {option.description}
                        </Text>
                      ) : undefined
                    }
                    endContent={<Key index={index} />}
                    key={option.value}
                    label={option.label}
                    value={option.value}
                  />
                ))}
                {other ? (
                  <RadioListItem
                    endContent={<Key index={values.length - 1} />}
                    label={other.placeholder}
                    value={OTHER}
                  />
                ) : null}
              </RadioList>
              {other ? (
                <TextInput
                  isDisabled={submitting}
                  isLabelHidden
                  label="Your answer"
                  onChange={setText}
                  onFocus={() => setPicked(OTHER)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      send();
                    }
                  }}
                  placeholder={other.placeholder}
                  ref={field}
                  value={text}
                />
              ) : null}
              {error ? (
                <Banner role="alert" status="error" title={error} />
              ) : null}
              <Stack direction="horizontal" justify="end">
                <Button
                  isDisabled={!canSend}
                  label={
                    submitting
                      ? "Sending…"
                      : picked === OTHER
                        ? "Send"
                        : (pickedOption?.label ?? "Send")
                  }
                  onClick={send}
                />
              </Stack>
            </Stack>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {answer ? (
          <motion.div
            animate={{ height: "auto", opacity: 1 }}
            initial={{ height: 0, opacity: 0 }}
            key="answer"
            style={{ overflow: "hidden" }}
            transition={{ ...fold, delay: reduceMotion ? 0 : 0.06 }}
          >
            <Stack
              direction="horizontal"
              align="center"
              gap={2}
              paddingInline={4}
              paddingBlock={3}
              className="min-w-0 border-border border-t"
            >
              <IconCheck
                aria-hidden
                className="size-4 shrink-0 text-(--color-text-success)"
              />
              <Text weight="medium">{answer.choice ?? answer.label}</Text>
              {answer.note ? (
                <Text className="min-w-0 truncate" color="secondary">
                  “{answer.note}”
                </Text>
              ) : null}
            </Stack>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Stack>
  );
}

/** The digit that picks a row. Hidden from screen readers: the row is already a radio. */
function Key({ index }: { index: number }) {
  if (index > 8) return null;
  return (
    <kbd
      aria-hidden
      className="ml-auto shrink-0 px-1 font-mono text-(--color-text-secondary) text-xs leading-5"
    >
      {index + 1}
    </kbd>
  );
}
