import { Banner } from "@astryxdesign/core/Banner";
import { Link } from "@astryxdesign/core/Link";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ReadError } from "@/components/layout/read-status";
import { canKeepCachedRead } from "@/lib/client";

export function ConversationLoading({ label }: { label: string }) {
  return (
    <Stack padding={5} align="center" gap={2} role="status">
      <Spinner aria-hidden />
      <Text as="p" type="supporting">
        {label}
      </Text>
    </Stack>
  );
}

export function ConversationReadError({
  title,
  description,
  retry,
  retrying,
  retryLabel = "Try again",
  retryBelow,
  focusAfterRetry,
}: {
  title: string;
  description?: string;
  retry?: (() => void) | undefined;
  retrying: boolean;
  retryLabel?: string;
  retryBelow?: boolean;
  focusAfterRetry?: () => HTMLElement | null;
}) {
  return (
    <ReadError
      focusAfterRetry={focusAfterRetry}
      message={title}
      description={description}
      retry={retry}
      retrying={retrying}
      retryLabel={retryLabel}
      retryBelow={retryBelow}
    />
  );
}

/**
 * A conversation this person can no longer read, and the way back.
 *
 * The content is already gone from the screen: nothing here is theirs to see any more, so what is
 * left is why, and where to go next. Reached by an old link or from another person's history, the
 * alternative was an empty page with no control at all.
 */
export function ConversationAccessEnded({
  title = "Conversation access ended.",
}: {
  /** The sentence for a page that is not a conversation's own: a group conversation names itself. */
  title?: string;
}) {
  return (
    <Stack gap={3} padding={5}>
      <Banner collapsible={false} role="alert" status="error" title={title} />
      <Link href="/" isStandalone>
        Back to Home
      </Link>
    </Stack>
  );
}

/**
 * A conversation that could not be opened, or that this person can no longer read.
 *
 * Which of the two it is, is the server's answer and not a guess from the screen: a refused read
 * (401, 403, 404) means the content is not theirs to see any more, and trying again cannot change
 * that. Any other failure keeps its Try again beside the way back, so somebody whose conversation
 * would not load is never left with no control at all.
 */
export function ConversationUnavailable({
  title,
  denied,
  description,
  error,
  retry,
  retrying = false,
}: {
  /** Said when the read failed and can be tried again. */
  title: string;
  /** Said instead when the server refused the read. */
  denied: string;
  description?: string;
  error: Error | null;
  retry?: () => void;
  retrying?: boolean;
}) {
  if (!canKeepCachedRead(error))
    return <ConversationAccessEnded title={denied} />;
  return (
    <Stack gap={3} padding={5}>
      <ConversationReadError
        description={description}
        retry={retry}
        retryBelow
        retrying={retrying}
        title={title}
      />
      <Link href="/" isStandalone>
        Back to Home
      </Link>
    </Stack>
  );
}
