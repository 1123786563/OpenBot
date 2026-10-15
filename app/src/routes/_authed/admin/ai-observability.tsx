import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { ObservabilityPlaceholder } from "@/components/ai-observability/placeholder";

/**
 * Placeholder for the admin chain (#42): collection summary, ingest health and export status.
 * Access stays whatever `_authed/admin` already enforces; nothing new is decided here.
 */
export const Route = createFileRoute("/_authed/admin/ai-observability")({
  component: AdminObservabilityPage,
});

function AdminObservabilityPage() {
  const { t } = useTranslation("ai-observability-admin");
  return (
    <PageShell title={t("placeholder.title")}>
      <ObservabilityPlaceholder namespace="ai-observability-admin" />
    </PageShell>
  );
}
