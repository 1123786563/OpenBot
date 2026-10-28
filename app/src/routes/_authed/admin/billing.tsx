import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BillingCleanupExecutionCard } from "@/components/admin/billing-cleanup-execution-card";
import { BillingRecoveryReviewCard } from "@/components/admin/billing-recovery-review-card";
import { PageSection, PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/billing")({
  component: BillingAdminPage,
});

/**
 * The administrator's credit-grant screen (Bifrost #222, 02.8): one entry, one form. The form
 * itself carries the ticket's whole contract — see the component — so this file stays the URL
 * and the frame, the same division the gateway screen draws.
 */
function BillingAdminPage() {
  const { t } = useTranslation("admin");
  return (
    <PageShell
      description={t("billingPage.description")}
      title={t("billingPage.title")}
    >
      <PageSection
        description={t("overview.access.billing.description")}
        title={t("overview.access.billing.title")}
      >
        <AdminCreditGrantCard />
      </PageSection>
      <PageSection
        description={t("billingCleanup.sectionDescription")}
        title={t("billingCleanup.sectionTitle")}
      >
        <BillingCleanupExecutionCard />
      </PageSection>
      <PageSection
        description={t("recoveryReview.sectionDescription")}
        title={t("recoveryReview.sectionTitle")}
      >
        <BillingRecoveryReviewCard />
      </PageSection>
    </PageShell>
  );
}
