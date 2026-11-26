import { createFileRoute, Outlet } from "@tanstack/react-router";
import {
  ShellNavigationHeader,
  SidebarShell,
} from "@/components/layout/sidebar-shell";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { useId, useRef } from "react";

export const Route = createFileRoute("/_authed/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell
      className="h-svh overflow-hidden"
      name="settings"
      pageToggle={false}
      width="300px"
    >
      <SettingsFrame />
    </SidebarShell>
  );
}

/**
 * The frame inside the sidebar provider: it reads sidebar state (`ShellNavigationHeader` uses
 * `useSidebar`), so it must be `SidebarShell`'s child, not the shell itself.
 */
function SettingsFrame() {
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <SettingsSidebar navId={navId} returnFocus={trigger} />
      <SidebarInset
        id="main-content"
        tabIndex={-1}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <ShellNavigationHeader navId={navId} trigger={trigger} />
        <Outlet />
      </SidebarInset>
    </>
  );
}
