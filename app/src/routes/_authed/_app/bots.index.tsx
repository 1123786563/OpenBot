import { IconBook, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import { NewBotSheet } from "@/components/agents/new-bot-sheet";
import { NewBotAction } from "@/components/astryx-pilot/bot-actions";
import {
  AstryxBotsSurface,
  AstryxBrand,
  astryxPilot,
} from "@/components/astryx-pilot/theme";
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

/** Just longer than the sheet's 200ms exit, so it has finished sliding away before the page changes. */
const SHEET_CLOSE_MS = 240;

/** Creating a Bot is a search-parameter state, so the roster stays mounted and Back closes it. */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: BotsPage,
});

function BotsPage() {
  const { new: creating } = Route.useSearch();
  const navigate = Route.useNavigate();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return (
    <AstryxBotsSurface>
      <PageShell
        action={<NewBotAction primary />}
        description={
          personal
            ? "Your Bots for everyday work."
            : "Manage your Bots and access those shared with you."
        }
        title="Bots"
        eyebrow={astryxPilot ? <AstryxBrand /> : undefined}
      >
        <BotRoster />
        {personal ? <WhatYourBotsKnow /> : null}
        <NewBotSheet
          onClose={() => void navigate({ search: {} })}
          onCreated={(agentId) => {
            /*
             * Close first, then go. Navigating straight to the Bot unmounted this page with the sheet
             * still on it, so it vanished instead of sliding away. Replacing the `?new` entry means Back
             * from the new Bot lands on the roster, not on an empty sheet.
             */
            void navigate({ replace: true, search: {} });
            window.setTimeout(
              () =>
                void navigate({
                  params: { agentId },
                  search: {},
                  to: "/bots/$agentId",
                }),
              SHEET_CLOSE_MS,
            );
          }}
          open={creating === true}
          returnFocus={() =>
            document.querySelector<HTMLAnchorElement>(
              "[data-slot=page-header] a[href*='new=true']",
            )
          }
        />
      </PageShell>
    </AstryxBotsSurface>
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
