import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectory } from "@/components/plugins/broker-directory";

/** Composio's directory, behind the guard that it answers only on a Composio deployment. */
export const Route = createFileRoute("/_authed/admin/plugins/composio")({
  component: () => <BrokerDirectory provider="composio" />,
});
