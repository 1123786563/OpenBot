import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ComputersPage } from "@/components/manage/computers-page";

import { PilotComputerPage } from "@/components/manage/pilot-computer-actions";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

function ComputerSettings() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  return personal ? <ComputersPage /> : <PilotComputerPage />;
}

export const Route = createFileRoute("/_authed/settings/_personal/computer")({
  component: ComputerSettings,
});
