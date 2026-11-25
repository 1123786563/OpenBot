import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import {
  IconArrowUp,
  IconLoader2,
  IconMicrophone,
  IconPlayerStopFilled,
  IconX,
} from "@tabler/icons-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef } from "react";
import { LiveWaveform } from "@/components/ui/live-waveform";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { useDictation } from "./use-dictation";

type Dictation = ReturnType<typeof useDictation>;
const MotionStack = motion.create(Stack);

export function DictationButton({
  dictation,
  disabled,
  onStarted,
}: {
  dictation: Dictation;
  disabled: boolean;
  /** Live dictation began: the caret goes to the box, so Enter stops it there. */
  onStarted?: () => void;
}) {
  if (!dictation.available) return null;
  if (dictation.mode === "live")
    return (
      <LiveDictationButton
        dictation={dictation}
        disabled={disabled}
        onStarted={onStarted}
      />
    );
  return (
    <IconButton
      data-slot="composer-dictate"
      icon={<IconMicrophone className="size-4" />}
      isDisabled={disabled || !dictation.supported || dictation.busy}
      label="Dictate a message"
      onClick={() => void dictation.session.start()}
      size="sm"
      tooltip={
        dictation.supported
          ? "Dictate a message"
          : "Dictation needs a supported browser and a secure (HTTPS) connection"
      }
      type="button"
      variant="ghost"
    />
  );
}

/**
 * LIVE DICTATION'S ONE BUTTON. The microphone starts it, and while it listens the same button is Stop,
 * in the same place and size, so the way out is where the way in was. Stopping keeps every word in
 * the box and sends nothing; Enter in the box does the same.
 */
function LiveDictationButton({
  dictation,
  disabled,
  onStarted,
}: {
  dictation: Dictation;
  disabled: boolean;
  onStarted?: () => void;
}) {
  const { session, state, active } = dictation.live;
  if (!active)
    return (
      <IconButton
        data-slot="composer-dictate"
        icon={<IconMicrophone className="size-4" />}
        isDisabled={disabled}
        label="Dictate a message"
        onClick={() => {
          void session.start();
          onStarted?.();
        }}
        size="sm"
        tooltip="Dictate a message"
        type="button"
        variant="ghost"
      />
    );
  const stopping = state.phase === "stopping";
  return (
    <IconButton
      data-slot="composer-dictate-stop"
      data-state={state.phase}
      icon={
        <>
          {state.phase === "listening" && (
            <Stack
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-primary/40 motion-safe:animate-pulse"
            />
          )}
          {stopping ? (
            <IconLoader2
              aria-hidden="true"
              className="size-4 motion-safe:animate-spin"
            />
          ) : (
            <IconPlayerStopFilled className="size-3.5" />
          )}
        </>
      }
      isDisabled={stopping}
      label={stopping ? "Finishing dictation" : "Stop dictation"}
      onClick={session.stop}
      size="sm"
      tooltip="Stop dictation"
      type="button"
      variant="ghost"
    />
  );
}

/** What live dictation says above the box: that it is listening, waiting on the system, or a problem. */
export function LiveDictationNotice({ dictation }: { dictation: Dictation }) {
  const { state, session } = dictation.live;
  if (dictation.mode !== "live") return null;
  if (state.phase === "listening" || state.phase === "stopping")
    return (
      <Text className="sr-only" role="status">
        {state.phase === "listening" ? "Listening" : "Finishing dictation"}
      </Text>
    );
  if (state.phase === "preparing")
    return (
      <Text as="p" className="pb-2 text-muted-foreground text-sm" role="status">
        Waiting for permission to use the microphone and speech recognition.
      </Text>
    );
  if (state.phase !== "error") return null;
  return (
    <HStack align="start" className="pb-2" gap={2}>
      <Text
        as="p"
        className="min-w-0 flex-1 text-destructive text-sm"
        data-slot="composer-dictate-error"
        role="alert"
      >
        {state.error}
      </Text>
      <IconButton
        icon={<IconX />}
        label="Dismiss"
        onClick={session.release}
        size="sm"
        tooltip="Dismiss"
        type="button"
        variant="ghost"
      />
    </HStack>
  );
}

/** Keep the editor mounted and its footprint stable while recording takes its place. */
export function DictationSurface({
  dictation,
  canSend,
  children,
  className,
}: {
  dictation: Dictation;
  canSend: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Stack className={cn("min-w-0", className)}>
      <Stack className="relative min-w-0">
        <Stack
          aria-hidden={dictation.busy || undefined}
          className={cn(
            /*
             * NO TRANSLATE AT REST, NOT EVEN ZERO. Tailwind's `translate-y-0` sets the `translate`
             * property to `0px`, which is not `none`, and any translate makes this box the containing
             * block for `position: fixed` descendants. The @ menu is one: it is placed at the caret in
             * viewport coordinates, and was drawn that far again from this box's corner, off the bottom
             * of the screen. The idle state therefore names no translate at all.
             *
             * `translate` in the transition list, not `transform`: Tailwind v4's translate utilities
             * set the `translate` property, so a transition on `transform` never animated the lift.
             */
            "min-w-0 transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none motion-reduce:translate-none",
            dictation.busy
              ? "pointer-events-none -translate-y-1 opacity-0"
              : "opacity-100",
          )}
          inert={dictation.busy}
        >
          {children}
        </Stack>
        {dictation.busy && (
          <RecordingControls dictation={dictation} canSend={canSend} />
        )}
      </Stack>
    </Stack>
  );
}

function RecordingControls({
  dictation,
  canSend,
}: {
  dictation: Dictation;
  canSend: boolean;
}) {
  const { state, session } = dictation;
  const reduceMotion = useReducedMotion();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  const recording = state.phase === "recording";
  const transcribing = state.phase === "transcribing";
  const transition = {
    duration: reduceMotion ? 0 : ENTRANCE_SECONDS,
    ease: EASE_OUT,
  };
  const arrive = { opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 3 };
  const time = `${Math.floor(state.seconds / 60)}:${String(state.seconds % 60).padStart(2, "0")}`;
  return (
    <MotionStack
      animate={{ opacity: 1, y: 0 }}
      className="absolute inset-0 min-w-0"
      direction="horizontal"
      gap={3}
      initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : 4 }}
      transition={transition}
      vAlign="center"
    >
      <IconButton
        data-slot="composer-dictate-cancel"
        icon={<IconX className="size-4" />}
        label="Cancel dictation"
        onClick={session.cancel}
        ref={cancel}
        size="sm"
        tooltip="Cancel dictation"
        type="button"
        variant="ghost"
      />
      <MotionStack
        animate={{ opacity: 1, y: 0 }}
        className="max-h-full min-w-0 flex-1 overflow-y-auto"
        initial={arrive}
        key={
          state.phase === "error" || state.phase === "requesting"
            ? state.phase
            : "waveform"
        }
        transition={transition}
      >
        {state.phase === "error" ? (
          <Text as="p" className="text-destructive text-sm" role="alert">
            {state.error}
          </Text>
        ) : state.phase === "requesting" ? (
          <Text as="p" className="text-muted-foreground text-sm" role="status">
            Waiting for microphone permission…
          </Text>
        ) : (
          <HStack align="center" className="min-w-0" gap={3}>
            <Text className="sr-only" role="status">
              {transcribing ? "Transcribing…" : "Listening"}
            </Text>
            <LiveWaveform
              className="flex-1 text-foreground"
              height={28}
              processing={transcribing}
              stream={state.stream}
            />
            <Text
              aria-label="Recording duration"
              className="shrink-0 text-muted-foreground text-xs"
              hasTabularNumbers
              role="timer"
            >
              {time}
            </Text>
          </HStack>
        )}
      </MotionStack>
      <MotionStack
        animate={{ opacity: 1, y: 0 }}
        className="shrink-0"
        initial={arrive}
        key={state.phase === "error" ? "recovery" : "actions"}
        transition={transition}
      >
        {state.phase === "error" ? (
          <Button
            label={state.canRetry ? "Retry" : "Record again"}
            onClick={() =>
              void (state.canRetry ? session.retry() : session.start())
            }
            size="sm"
            type="button"
            variant="ghost"
          />
        ) : (
          <HStack align="center" className="shrink-0" gap={2}>
            <IconButton
              data-slot="composer-dictate-stop"
              icon={<IconPlayerStopFilled className="size-3.5" />}
              isDisabled={!recording}
              label="Stop and transcribe"
              onClick={() => void session.finish("draft")}
              size="sm"
              tooltip="Stop and add to draft"
              type="button"
              variant="ghost"
            />
            <IconButton
              icon={
                <MotionStack
                  animate={{ opacity: 1, scale: 1 }}
                  className="inline-flex"
                  initial={{
                    opacity: reduceMotion ? 1 : 0,
                    scale: reduceMotion ? 1 : 0.85,
                  }}
                  key={transcribing ? "transcribing" : "send"}
                  transition={transition}
                >
                  {transcribing ? (
                    <IconLoader2
                      aria-hidden="true"
                      className="size-4 motion-safe:animate-spin"
                    />
                  ) : (
                    <IconArrowUp className="size-4" />
                  )}
                </MotionStack>
              }
              isDisabled={!recording || !canSend}
              label="Transcribe and send"
              onClick={() => void session.finish("send")}
              size="sm"
              tooltip="Transcribe and send"
              type="button"
              variant="primary"
            />
          </HStack>
        )}
      </MotionStack>
    </MotionStack>
  );
}
