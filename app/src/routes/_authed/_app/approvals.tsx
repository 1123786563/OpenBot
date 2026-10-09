import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ApprovalInbox } from "@/components/approvals/inbox";
import { PageShell } from "@/components/layout/page-shell";
export const Route = createFileRoute("/_authed/_app/approvals")({
  component: ApprovalsPage,
});
function ApprovalsPage() {
  const { t } = useTranslation("approvals");
  return (
    <PageShell title={t("title")} description={t("description")}>
      <ApprovalInbox />
    </PageShell>
  );
}
