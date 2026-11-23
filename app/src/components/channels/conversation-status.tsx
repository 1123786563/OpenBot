import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ReadError } from "@/components/layout/read-status";

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
}: {
  title: string;
  description?: string;
  retry: () => void;
  retrying: boolean;
  retryLabel?: string;
  retryBelow?: boolean;
}) {
  return (
    <ReadError
      message={title}
      description={description}
      retry={retry}
      retrying={retrying}
      retryLabel={retryLabel}
      retryBelow={retryBelow}
    />
  );
}
