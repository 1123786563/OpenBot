import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SidebarShell } from "@/components/layout/sidebar-shell";
import {
  MAIN_CONTENT_ID,
  SkipToContent,
} from "@/components/layout/skip-to-content";
import { currentUserQueryOptions } from "../../../lib/auth/queries";

export const Route = createFileRoute("/_authed/admin")({
  beforeLoad: async ({ context }) => {
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
    <SidebarShell width="256px">
      <SkipToContent />
      <AdminSidebar />
      <main id={MAIN_CONTENT_ID} className="flex-1">
        <Outlet />
      </main>
    </SidebarShell>
  );
}
