import { createFileRoute, Outlet } from "@tanstack/react-router";
import { MAIN_CONTENT_ID, SkipToContent } from "@/components/layout/skip-to-content";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarShell width="300px">
      <SkipToContent />
      <SettingsSidebar />
      <main id={MAIN_CONTENT_ID} className="flex-1">
        <Outlet />
      </main>
    </SidebarShell>
  );
}
