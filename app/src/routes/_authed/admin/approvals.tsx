import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TeamApprovalSettings } from "@/components/approvals/team-settings";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/approvals")({
  component: AdminApprovalsPage,
});

function AdminApprovalsPage() {
  const { t } = useTranslation("admin");
  return (
    <PageShell
      description={t("approvals.description")}
      title={t("approvals.title")}
    >
      <TeamApprovalSettings />
    </PageShell>
  );
}
