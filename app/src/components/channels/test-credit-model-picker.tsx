import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  saveTestCreditModel,
  testCreditModelKey,
  testCreditModelQuery,
} from "@/lib/models/test-credit-model";

const inherited = ":inherit";
const unavailable = ":unavailable";

export function TestCreditModelPicker({
  botId,
  threadId,
  disabled,
  readOnly,
}: {
  botId: string;
  threadId?: string;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const queries = useQueryClient();
  const query = testCreditModelQuery(botId, threadId);
  const models = useQuery(query);
  const save = useMutation({
    mutationFn: (id: string) => {
      const picked = models.data?.options.find((option) => option.id === id);
      if (id === inherited) return saveTestCreditModel(botId, threadId, null);
      if (!picked) throw new Error("Choose a verified model.");
      return saveTestCreditModel(botId, threadId, {
        id: picked.id,
        revision: picked.revision,
      });
    },
    onSuccess: (data) => queries.setQueryData(query.queryKey, data),
    onSettled: () =>
      queries.invalidateQueries({ queryKey: [...testCreditModelKey, botId] }),
  });
  if (models.isPending) return <p role="status">Loading models…</p>;
  if (!models.data)
    return (
      <Stack gap={1}>
        <p role="alert">{models.error?.message}</p>
        <Button
          size="sm"
          label="Retry models"
          onClick={() => void models.refetch()}
        />
      </Stack>
    );

  const { options, saved, quote, reason, source } = models.data;
  const savedOption = options.find(
    ({ id, revision }) => id === saved?.id && revision === saved.revision,
  );
  const model = quote && `${quote.provider}/${quote.model}`;
  const defaults = source === "bot" ? "Bot default" : "Administrator default";
  const inheritLabel =
    !saved && model
      ? `${defaults} · ${model}`
      : threadId
        ? "Use Bot or administrator default"
        : "Use administrator default";
  return (
    <Stack gap={1}>
      <Selector
        label={threadId ? "Conversation model" : "Bot default model"}
        isLabelHidden={Boolean(threadId)}
        isDisabled={disabled || save.isPending}
        isReadOnly={readOnly}
        isLoading={save.isPending}
        size="sm"
        variant={threadId ? "ghost" : "input"}
        value={saved ? (savedOption?.id ?? unavailable) : inherited}
        options={[
          { value: inherited, label: inheritLabel },
          ...options.map(({ id, provider, model }) => ({
            value: id,
            label: `${provider}/${model}`,
          })),
          ...(saved && !savedOption
            ? [
                {
                  value: unavailable,
                  label: "Saved model unavailable",
                  disabled: true,
                },
              ]
            : []),
        ]}
        onChange={(id) => save.mutate(id)}
      />
      {reason || save.error ? (
        <p role="alert">{save.error?.message ?? reason}</p>
      ) : null}
    </Stack>
  );
}
