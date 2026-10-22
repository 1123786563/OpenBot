import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChatPanel } from "@/components/craft/chat-panel";
import { OutputPanel } from "@/components/craft/output-panel";
import { SandboxStatusIndicator } from "@/components/craft/sandbox-status-indicator";
import { SessionSidebar } from "@/components/craft/session-sidebar";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  CraftSessionUnavailableError,
  scopedCraftSessionQueryOptions,
} from "@/lib/craft/queries";

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
  // The detail read is the scope's own answer (MT091 / Issue #134, AC1): the pair rides the
  // request and the entry files under the scope's cache prefix, so a cross-scope id — another
  // company's session, indistinguishable from one that never existed — reaches this pane as the
  // typed unavailable error below, never as another scope's rows.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const session = useQuery(
    scopedCraftSessionQueryOptions(queryClient, scope, sessionId),
  );

  if (session.error instanceof CraftSessionUnavailableError) {
    return (
      <div className="flex min-h-0 flex-1">
        <SessionSidebar />
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            {t("session.unavailable")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <SessionSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <h1 className="truncate text-sm font-medium">
            {session.data?.name ?? t("session.untitled")}
          </h1>
          <div className="ml-auto">
            <SandboxStatusIndicator sessionId={sessionId} />
          </div>
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
