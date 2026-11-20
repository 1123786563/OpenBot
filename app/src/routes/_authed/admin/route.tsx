import { useId, useRef } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { AstryxNavigationToggle } from "@/components/astryx-pilot/navigation-toggle";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import { AstryxBrand, astryxScope } from "@/components/astryx-pilot/theme";
import { SidebarInset } from "@/components/ui/sidebar";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { personalAdminRedirect } from "@/lib/manage-paths";
import "@/components/admin/astryx-admin.css";
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
    <SidebarShell
      className="astryx-web-shell h-svh overflow-hidden"
      name="astryx-admin"
      pageToggle={false}
      width="280px"
    >
      <AstryxAdminFrame />
    </SidebarShell>
  );
}

function AstryxAdminFrame() {
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <>
      <AdminSidebar preview={{ id: navId, returnFocus: trigger }} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header {...astryxScope} className="astryx-web-bar">
          <AstryxNavigationToggle
            navId={navId}
            drawerId={`${navId}-dialog`}
            label="Admin navigation"
            trigger={trigger}
          />
          <AstryxBrand />
          <span className="astryx-admin-context">Team Admin</span>
        </header>
        <Outlet />
      </SidebarInset>
    </>
  );
}
