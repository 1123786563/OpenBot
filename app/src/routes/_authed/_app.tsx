import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppSidebar } from "@/components/app-sidebar/app-sidebar";
import { SelfHostBanner } from "@/components/layout/self-host-banner";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import {
  MAIN_CONTENT_ID,
  SkipToContent,
} from "@/components/layout/skip-to-content";

export const Route = createFileRoute("/_authed/_app")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // One viewport, never scrolls: panes scroll inside it. A growable shell lets the transcript's
    // scroller size against the page, grow it, and grow again.
    <SidebarShell className="h-svh overflow-hidden" width="340px">
      <SkipToContent />
      <AppSidebar />
      <main
        id={MAIN_CONTENT_ID}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
      >
        <SelfHostBanner />
        <Outlet />
      </main>
    </SidebarShell>
  );
}
