import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApprovalSettings } from "@/components/approvals/settings";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/settings/approvals")({
  component: ApprovalsSettingsPage,
});

function ApprovalsSettingsPage() {
  const { t } = useTranslation("approvals");
  return (
    <PageShell description={t("description")} title={t("title")}>
      <ApprovalSettings />
    </PageShell>
  );
}
