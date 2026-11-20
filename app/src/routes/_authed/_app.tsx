import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AstryxWebShell } from "@/components/astryx-pilot/web-shell";

export const Route = createFileRoute("/_authed/_app")({
  component: () => (
    <AstryxWebShell>
      <Outlet />
    </AstryxWebShell>
  ),
});
