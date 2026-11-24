import { createFileRoute } from "@tanstack/react-router";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { personalOnly } from "@/lib/edition-guard";

export const Route = createFileRoute("/_authed/_app/connections/browse/arcade")(
  {
    beforeLoad: personalOnly("/connections"),
    component: () => <BrokerDirectory provider="arcade" />,
  },
);
