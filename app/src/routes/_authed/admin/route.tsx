import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useId, useRef } from "react";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import {
  ShellNavigationHeader,
  SidebarShell,
} from "@/components/layout/sidebar-shell";
import { SidebarInset } from "@/components/ui/sidebar";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { personalAdminRedirect } from "@/lib/manage-paths";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context, location }) => {
    /*
     * The personal edition has no Admin. An old address opens the same page under Settings, or
     * Settings itself, never an empty page.
     */
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (capabilities?.edition === "personal") {
      throw redirect({
        href: personalAdminRedirect(location.pathname),
        replace: true,
      });
    }
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user?.role !== "admin") {
      throw redirect({ to: "/" });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  return (
    // The same inset panel as the app's shell; see `_app.tsx`.
    <SidebarShell
      className="astryx-management-shell h-svh overflow-hidden"
      name="admin"
      pageToggle={false}
      width="22rem"
    >
      <AdminFrame />
    </SidebarShell>
  );
}

/**
 * The frame inside the sidebar provider: it reads sidebar state (`ShellNavigationHeader` uses
 * `useSidebar`), so it must be `SidebarShell`'s child, not the shell itself.
 */
function AdminFrame() {
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <AdminSidebar navId={navId} returnFocus={trigger} />
      <SidebarInset
        id="main-content"
        tabIndex={-1}
        className="astryx-management-main min-h-0 min-w-0 overflow-hidden"
      >
        <ShellNavigationHeader navId={navId} trigger={trigger} />
        <Outlet />
      </SidebarInset>
    </>
  );
}
