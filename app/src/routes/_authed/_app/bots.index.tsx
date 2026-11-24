import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { IconBook, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ComponentProps, useRef } from "react";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { BotRoster } from "@/components/bots/bot-roster";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

declare module "@tanstack/react-router" {
  interface HistoryState {
    createdBotId?: string;
  }
}

/** Creating a Bot is a search-parameter state, so the roster stays mounted and Back closes it. */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: z.object({
    new: z.boolean().optional(),
    q: z.string().optional().catch(undefined),
  }),
  component: BotsPage,
});

function CreateBotLink({
  href: _href,
  ...props
}: ComponentProps<"a"> & { to?: string }) {
  return (
    <Link
      {...props}
      id="bots-new"
      to="/bots"
      search={(previous) => ({ ...previous, new: true })}
    />
  );
}

function BotsPage() {
  const { new: creating, q = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const createdBot = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <PageShell
      action={
        <AstryxButton
          as={CreateBotLink}
          className="bot-primary-action"
          href="/bots?new=true"
          icon={<IconPlus size="1em" aria-hidden="true" />}
          label="New Bot"
          size="lg"
          variant="primary"
        />
      }
      description={
        personal
          ? "Your Bots for everyday work."
          : "Manage your Bots and access those shared with you."
      }
      headingRef={heading}
      title="Bots"
    >
      <BotRoster
        focusAfterRetry={() => heading.current}
        search={q}
        onSearchChange={(value) =>
          void navigate({
            replace: true,
            resetScroll: false,
            search: (previous) => ({ ...previous, q: value || undefined }),
          })
        }
      />
      {personal ? <WhatYourBotsKnow /> : null}
      <NewBotSheet
        finalFocus={() =>
          createdBot.current ? false : document.getElementById("bots-new")
        }
        onClose={() =>
          void navigate({
            replace: true,
            search: (previous) => ({ ...previous, new: undefined }),
          })
        }
        onCreated={(agentId) => {
          createdBot.current = agentId;
          void navigate({
            replace: true,
            search: (previous) => ({ ...previous, new: undefined }),
          });
        }}
        onOpenChangeComplete={(open) => {
          const agentId = createdBot.current;
          if (open || !agentId) return;
          createdBot.current = null;
          void navigate({
            params: { agentId },
            search: {},
            state: { createdBotId: agentId },
            to: "/bots/$agentId",
          });
        }}
        open={creating === true}
      />
    </PageShell>
  );
}

/**
 * Capabilities, in the personal edition, where it is not a page of its own: what a person's Bots
 * know how to do, beneath the Bots themselves. No Memory row: the personal edition has no memory
 * (see `offersMemory`).
 */
function WhatYourBotsKnow() {
  return (
    <PageSection title="What your Bots know">
      <PageRows>
        <Item render={<Link to="/capabilities/skills" />} size="sm">
          <ItemMedia variant="icon">
            <IconBook />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Skills</ItemTitle>
            <ItemDescription>
              Step-by-step instructions you wrote or your Bots learned.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>
    </PageSection>
  );
}
