import { Button } from "@astryxdesign/core/Button";
import { IconLayoutSidebar } from "@tabler/icons-react";
import { useId, useRef } from "react";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import {
  AstryxBrand,
  astryxPilot,
  astryxScope,
} from "@/components/astryx-pilot/theme";
import { SidebarInset, useSidebar } from "@/components/ui/sidebar";
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
      className={
        astryxPilot
          ? "astryx-web-shell h-svh overflow-hidden"
          : "h-svh overflow-hidden"
      }
      name={astryxPilot ? "astryx-admin" : "admin"}
      pageToggle={!astryxPilot}
      width={astryxPilot ? "280px" : "300px"}
    >
      {astryxPilot ? (
        <AstryxAdminFrame />
      ) : (
        <>
          <AdminSidebar />
          <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
            <Outlet />
          </SidebarInset>
        </>
      )}
    </SidebarShell>
  );
}

function AstryxAdminFrame() {
  const navId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;

  return (
    <>
      <AdminSidebar preview={{ id: navId, returnFocus: trigger }} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header {...astryxScope} className="astryx-web-bar">
          <Button
            aria-controls={
              isMobile ? (expanded ? `${navId}-dialog` : undefined) : navId
            }
            aria-expanded={expanded}
            aria-haspopup={isMobile ? "dialog" : undefined}
            icon={<IconLayoutSidebar aria-hidden size={20} />}
            isIconOnly
            label={
              expanded ? "Close Admin navigation" : "Open Admin navigation"
            }
            onClick={toggleSidebar}
            ref={trigger}
            variant="ghost"
          />
          <AstryxBrand />
          <span className="astryx-admin-context">Team Admin</span>
        </header>
        <Outlet />
      </SidebarInset>
    </>
  );
}
