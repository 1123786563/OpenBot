import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { ReactNode } from "react";

/**
 * One line saying something is under way, with who is doing it.
 *
 * For a wait the person did not start and cannot watch: a Bot asked by their Bot, a routine firing,
 * a sign-in or an approval somebody else has to finish. Drawn where the result will appear, so the
 * person looks at the right spot.
 *
 * It borrows the shimmer a running tool line uses, so every kind of "working on it" in the
 * transcript reads the same.
 */
export function ProgressRow({
  label,
  media,
}: {
  /** What is under way, as a person would say it: "Asking Ana…". */
  label: string;
  /** Who is doing it, drawn before the words: a Bot's avatar. */
  media?: ReactNode;
}) {
  return (
    <Stack
      as="p"
      align="center"
      className="text-muted-foreground text-sm"
      data-testid="progress-row"
      gap={2}
      // `status` rather than `alert`: progress, not an interruption.
      role="status"
    >
      {media ? (
        <Stack as="span" aria-hidden="true">
          {media}
        </Stack>
      ) : null}
      <Text as="span" className="tool-line-running" color="inherit">
        {label}
      </Text>
    </Stack>
  );
}
