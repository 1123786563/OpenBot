import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";

export const Route = createFileRoute("/_authed/admin/observability")({
  // Authorization is inherited: every /admin/* child is behind the admin-role check in
  // routes/_authed/admin/route.tsx, including a direct URL.
  component: AdminObservabilityPage,
});

/*
 * Placeholder frame: the scope summary, collection health and unbound-records screens (T33/T36)
 * replace the body. Until Opik is configured the honest content is the disabled state.
 */
function AdminObservabilityPage() {
  const { t } = useTranslation("obs-admin");
  return (
    <PageShell
      description={t("states.disabled.description")}
      title={t("title")}
    >
      <p className="mt-6 text-muted-foreground text-sm">
        {t("states.disabled.title")}
      </p>
    </PageShell>
  );
}
