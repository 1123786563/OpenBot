import { IconLayoutSidebar } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { ChannelItemContent } from "@/components/app-sidebar/channel-item-content";
import { PageRows } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/i18n";
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

export function MessageListPreference() {
  const descriptionId = useId();
  const preferences = useUserPreferences();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const save = useMutation(
    saveUserPreferencesMutationOptions(queryClient, preferences.userId),
  );
  const emphasis =
    (save.isPending ? save.variables?.messageListEmphasis : undefined) ??
    preferences.data?.messageListEmphasis;

  return (
    <PageRows>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconLayoutSidebar />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-auto">
            {t("settings.messageList.title", "Message list emphasis")}
          </ItemTitle>
          <ItemDescription className="line-clamp-none" id={descriptionId}>
            {t(
              "settings.messageList.description",
              "Show the conversation title or the Bot name first in the sidebar.",
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions className="max-sm:basis-full">
          <Select
            value={emphasis ?? null}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (value === "agent" || value === "thread") {
                save.mutate({ messageListEmphasis: value });
              }
            }}
          >
            <SelectTrigger
              aria-describedby={descriptionId}
              aria-label={t(
                "settings.messageList.title",
                "Message list emphasis",
              )}
              className="max-sm:w-full"
            >
              <SelectValue>
                {emphasis
                  ? emphasis === "agent"
                    ? t("settings.messageList.botName", "Bot name")
                    : t(
                        "settings.messageList.conversationTitle",
                        "Conversation title",
                      )
                  : t("settings.messageList.loading", "Loading…")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="thread">
                {t(
                  "settings.messageList.conversationTitle",
                  "Conversation title",
                )}
              </SelectItem>
              <SelectItem value="agent">
                {t("settings.messageList.botName", "Bot name")}
              </SelectItem>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {preferences.error.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            {t("frame.tryAgain", "Try again")}
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          {t("settings.messageList.saving", "Saving…")}
        </p>
      ) : null}
      {emphasis ? (
        <div className="flex justify-center px-6 pt-3 pb-6">
          <figure
            aria-label={t(
              "settings.messageList.preview",
              "Message list preview",
            )}
            className="flex h-16 w-full max-w-xs items-center rounded-lg border border-border bg-sidebar px-3"
          >
            <ChannelItemContent
              participantIds={["message-list-preview"]}
              name={t("settings.messageList.sampleName", "General Assistant")}
              title={t("settings.messageList.sampleTitle", "Plan next week")}
              lastMessageAt={t("settings.messageList.sampleTime", "2h")}
              emphasis={emphasis}
            />
          </figure>
        </div>
      ) : null}
    </PageRows>
  );
}
