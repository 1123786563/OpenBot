import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChatPanel } from "@/components/craft/chat-panel";
import { OutputPanel } from "@/components/craft/output-panel";
import { SessionSidebar } from "@/components/craft/session-sidebar";
import { craftSessionQueryOptions } from "@/lib/craft/queries";

/**
 * One craft session, in three panes: the roster, the conversation, and the output (preview, files,
 * artifacts). The conversation is the fixed width in the middle that grows with the window; the
 * output pane is a fixed viewport on the right. Nothing here scrolls as a whole — each pane scrolls
 * inside itself, matching the `_app` shell's "one viewport, never scrolls" rule.
 */
export const Route = createFileRoute("/_authed/_app/craft/$sessionId")({
  component: CraftSessionView,
});

function CraftSessionView() {
  const { sessionId } = Route.useParams();
  const { t } = useTranslation("craft");
  const session = useQuery(craftSessionQueryOptions(sessionId));

  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="truncate text-sm font-medium">
            {session.data?.name ?? t("session.untitled")}
          </h1>
        </header>
        <div className="min-h-0 flex-1 border-r border-border">
          <ChatPanel sessionId={sessionId} />
        </div>
      </div>
      <div className="w-[420px] shrink-0">
        <OutputPanel sessionId={sessionId} />
      </div>
    </div>
  );
}
