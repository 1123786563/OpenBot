import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { pilotComputerQueryOptions } from "@/lib/computers/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

/**
 * What the personal edition keeps of Admin: the plugins, skills, credentials, computer and activity
 * pages, under Settings because there is no Admin to hold them.
 *
 * The team edition keeps management in Admin. Enrolled users can also manage their own pilot computer in Settings.
 */
export const Route = createFileRoute("/_authed/settings/_personal")({
  beforeLoad: async ({ context, location }) => {
    const capabilities = await context.queryClient
      .ensureQueryData(deploymentCapabilitiesQueryOptions())
      .catch(() => undefined);
    if (capabilities?.edition === "personal") return;
    if (location.pathname.replace(/\/$/, "") === "/settings/computer") {
      const pilot = await context.queryClient
        .ensureQueryData(pilotComputerQueryOptions())
        .catch(() => undefined);
      if (pilot) return;
    }
    throw redirect({ to: "/settings" });
  },
  component: Outlet,
});
