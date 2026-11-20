import { Button } from "@astryxdesign/core/Button";
import { IconArrowRight, IconListCheck } from "@tabler/icons-react";
import { createLink } from "@tanstack/react-router";
import { astryxPilot } from "@/components/astryx-pilot/theme";
import { BotActivitySections } from "@/components/bot-profile/activity";
import { BotDetailSurface } from "@/components/bot-profile/detail-surface";
import { BotNeedsYou } from "@/components/needs-you/board";
import { useMuse } from "../context";
import { MuseEmpty, MuseScreen } from "../ui";

const ActivityBotLink = createLink(Button);

/**
 * Activity: what the centre Bot is waiting on you for, then what it is doing, has scheduled and has
 * finished. Both are OpenBot's own sections from the Bot's page, under OpenMuse's title.
 */
export function ActivityScreen() {
  const { bot } = useMuse();
  return (
    <MuseScreen title="Activity">
      {bot ? (
        <BotDetailSurface>
          {astryxPilot && (
            <div className="mb-4 self-start">
              <ActivityBotLink
                to="/bots/$agentId"
                params={{ agentId: bot.id }}
                icon={<IconArrowRight aria-hidden size={16} />}
                label={`View ${bot.name}`}
                variant="secondary"
              />
            </div>
          )}
          <div className="[&>section:first-child]:mt-0">
            <BotNeedsYou agentId={bot.id} />
            <BotActivitySections agentId={bot.id} />
          </div>
        </BotDetailSurface>
      ) : (
        <NoBot />
      )}
    </MuseScreen>
  );
}

export function NoBot() {
  return (
    <MuseEmpty
      detail="Create one with New Bot on the Bots page."
      icon={IconListCheck}
      title="No Bots yet"
    />
  );
}
