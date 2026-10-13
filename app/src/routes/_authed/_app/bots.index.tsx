import { IconPlus } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { CreateAgentDialog } from "@/components/agents/create-agent-dialog";
import { BotRoster } from "@/components/bots/bot-roster";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";

/** Creating a Bot is a search-parameter state, so the roster stays mounted and Back closes it. */
export const Route = createFileRoute("/_authed/_app/bots/")({
  validateSearch: z.object({ new: z.boolean().optional() }),
  component: BotsPage,
});

function BotsPage() {
  const { t } = useTranslation("agents");
  const { new: creating } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PageShell
      action={
        <Button
          render={(props) => (
            <Link {...props} search={{ new: true }} to="/bots" />
          )}
          size="lg"
        >
          <IconPlus />
          {t("pages.bots.newBot")}
        </Button>
      }
      description={t("pages.bots.description")}
      title={t("pages.bots.title")}
    >
      <BotRoster />
      <CreateAgentDialog
        onClose={() => void navigate({ search: {} })}
        onCreated={(agentId) =>
          void navigate({
            params: { agentId },
            search: {},
            to: "/bots/$agentId",
          })
        }
        open={creating === true}
      />
    </PageShell>
  );
}
