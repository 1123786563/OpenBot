import { Button } from "@astryxdesign/core/Button";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  BROWSER_DOWNLOAD_LIMIT,
  browserDownloadPath,
  manualBrowserDownloads,
} from "@openbot/shared/browser-download";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ReadError } from "@/components/layout/read-status";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { ClientError, client } from "@/lib/client";

export function ManualDownloadDelivery({ computerId }: { computerId: string }) {
  const [fileId, setFileId] = useState("");
  const [botId, setBotId] = useState("");
  const files = useQuery({
    queryKey: ["browser", "manual-downloads", computerId],
    queryFn: async ({ signal }) => {
      try {
        const response = await client(
          `/api/computers/${encodeURIComponent(computerId)}/browser-downloads`,
          { signal, fallback: "Couldn't load browser downloads." },
        );
        return manualBrowserDownloads.parse(await response.json()).downloads;
      } catch (error) {
        if (error instanceof ClientError && error.status === 404) return null;
        throw error;
      }
    },
  });
  const bots = useQuery({
    ...agentListQueryOptions(),
    enabled: Boolean(files.data?.length),
    select: (agents) =>
      agents.filter((agent) => agent.mine && !agent.isolationActive),
  });
  const delivery = useMutation({
    mutationFn: async ({
      fileId,
      botId,
    }: {
      fileId: string;
      botId: string;
    }) => {
      await client(
        `/api/computers/${encodeURIComponent(botId)}/browser-downloads/deliver`,
        {
          method: "POST",
          body: { id: fileId },
          fallback: "Couldn't deliver the download.",
        },
      );
      return browserDownloadPath(fileId);
    },
  });
  if (files.isError)
    return (
      <ReadError
        message="Couldn't load browser downloads."
        retry={files.refetch}
      />
    );
  if (!files.data) return null;

  return (
    <VStack gap={3} align="start">
      <Text as="h2" weight="semibold">
        Browser downloads
      </Text>
      <Button
        label="Refresh downloads"
        isLoading={files.isFetching}
        clickAction={async () => {
          await files.refetch();
        }}
      />
      {files.data.length === 0 ? (
        <Text as="p" color="secondary">
          Completed downloads appear here after you refresh.
        </Text>
      ) : (
        <>
          <Selector
            label="Downloaded file"
            placeholder="Choose a download"
            value={fileId}
            onChange={(value) => {
              setFileId(value);
              delivery.reset();
            }}
            isDisabled={delivery.isPending}
            options={files.data.map((file) => ({
              value: file.id,
              label: file.name,
              description:
                file.bytes > BROWSER_DOWNLOAD_LIMIT
                  ? "Exceeds the 16 MiB delivery limit"
                  : new Date(file.downloadedAt).toLocaleString(),
              disabled: file.bytes > BROWSER_DOWNLOAD_LIMIT,
            }))}
          />
          {bots.isError ? (
            <ReadError
              message="Couldn't load your Bots."
              retry={bots.refetch}
            />
          ) : (
            <Selector
              label="Recipient Bot"
              placeholder="Choose one of your Bots"
              emptyText="No eligible Bots"
              value={botId}
              onChange={(value) => {
                setBotId(value);
                delivery.reset();
              }}
              isDisabled={delivery.isPending}
              isLoading={bots.isPending}
              options={(bots.data ?? []).map((bot) => ({
                value: bot.id,
                label: bot.name,
              }))}
            />
          )}
          <Button
            label="Deliver to Bot"
            variant="primary"
            isLoading={delivery.isPending}
            isDisabled={
              !files.data.some(
                (file) =>
                  file.id === fileId && file.bytes <= BROWSER_DOWNLOAD_LIMIT,
              ) || !bots.data?.some((bot) => bot.id === botId)
            }
            onClick={() => delivery.mutate({ fileId, botId })}
          />
          {delivery.isError && (
            <Text as="p" role="alert">
              {delivery.error instanceof ClientError
                ? delivery.error.message
                : "Couldn't deliver the download."}
            </Text>
          )}
          {delivery.isSuccess && (
            <Text
              as="p"
              role="status"
            >{`Saved in the Bot workspace as ${delivery.data}.`}</Text>
          )}
        </>
      )}
    </VStack>
  );
}
