import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectory } from "@/components/plugins/broker-directory";

/** Arcade's directory, behind the guard that it answers only on an Arcade deployment. */
export const Route = createFileRoute("/_authed/admin/plugins/arcade")({
  component: () => <BrokerDirectory provider="arcade" />,
});
