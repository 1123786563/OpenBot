import { IconPlayerPause } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { setBotPausedMutationOptions } from "@/lib/bot-lifecycle/mutations";
import { botLifecycleQueryOptions } from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";

/**
 * "Paused, tap to resume", wherever a paused Bot is shown.
 *
 * Renders nothing while the Bot runs, or while its state is loading, so a surface can drop it in
 * above a conversation or a profile without deciding anything itself.
 */
export function BotPausedBanner({ agentId }: { agentId: string }) {
  const { t } = useTranslation("computer");
  const lifecycle = useQuery(botLifecycleQueryOptions(agentId));
  const resume = useMutation(setBotPausedMutationOptions(queryClient));
  if (!lifecycle.data?.paused) return null;
  return (
    <Button
      className="w-full justify-center gap-2"
      disabled={resume.isPending}
      onClick={() => resume.mutate({ agentId, paused: false })}
      variant="secondary"
    >
      <IconPlayerPause />
      {resume.isPending ? t("paused.resuming") : t("paused.tapToResume")}
    </Button>
  );
}
