import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Stack } from "@astryxdesign/core/Stack";

export function ConversationLoading({ label }: { label: string }) {
  return (
    <Stack padding={5} align="center">
      <Spinner label={label} />
    </Stack>
  );
}

export function ConversationReadError({
  title,
  description,
  retry,
  retrying,
  retryLabel = "Try again",
}: {
  title: string;
  description?: string;
  retry: () => void;
  retrying: boolean;
  retryLabel?: string;
}) {
  return (
    <Banner
      status="error"
      title={title}
      description={description}
      role="alert"
      endContent={
        <Button
          label={retryLabel}
          isLoading={retrying}
          onClick={retry}
          size="sm"
          variant="secondary"
        />
      }
    />
  );
}
