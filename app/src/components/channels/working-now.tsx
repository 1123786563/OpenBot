import { LinkProvider } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/VStack";
import { IconArrowUpRight } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { ChannelAvatar } from "@/components/channels/avatar";
import { untitledLine } from "@/lib/channels/label";
import type { ChannelSummary } from "@/lib/channels/queries";

export function WorkingNow({
  channels,
}: {
  channels: ChannelSummary[] | undefined;
}) {
  const working = channels?.find((channel) => channel.busy);
  if (!working) return null;
  const title = working.summary || untitledLine(working) || "New conversation";
  const route = working.agentIds.length > 1 ? "/group" : "/channel";
  return (
    <section aria-labelledby="working-now-heading">
      <VStack gap={2}>
        <h2 id="working-now-heading" className="text-base font-semibold">
          In progress
        </h2>
        <LinkProvider component={Link}>
          <List density="balanced">
            <ListItem
              href={`${route}/${encodeURIComponent(working.id)}`}
              label={`${working.name} is working`}
              description={title}
              startContent={
                <ChannelAvatar
                  participantIds={working.agentIds}
                  size={28}
                  typing
                />
              }
              endContent={<IconArrowUpRight aria-hidden="true" size="1rem" />}
            />
          </List>
        </LinkProvider>
      </VStack>
    </section>
  );
}
