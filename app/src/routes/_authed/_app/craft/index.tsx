import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SessionSidebar } from "@/components/craft/session-sidebar";

/**
 * The craft home: the session roster plus a "pick one" placeholder. There is no default session — a
 * fresh install holds nothing to open, and auto-creating one on visit would mint rows nobody asked
 * for. The composer lives inside a session, so this screen is the roster and an invitation only.
 */
export const Route = createFileRoute("/_authed/_app/craft/")({
  component: CraftIndex,
});

function CraftIndex() {
  const { t } = useTranslation("craft");
  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar />
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {t("session.noneSelected")}
        </p>
      </div>
    </div>
  );
}
