import { createFileRoute } from "@tanstack/react-router";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { GovernancePage } from "@/components/astryx-pilot/governance";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: AdminApprovalsPage,
});

function AdminApprovalsPage() {
  return (
    <GovernancePage
      description="Set approval rules for members’ Bots and review requests to use shared accounts."
      title="Approvals"
    >
      <TeamApprovalSettings />
    </GovernancePage>
  );
}
