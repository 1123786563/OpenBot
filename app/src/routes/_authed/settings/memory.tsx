import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { MemoryPauseControlsSection } from "@/components/memory/pause-controls";

export const Route = createFileRoute("/_authed/settings/memory")({
  component: MemorySettingsPage,
});

function MemorySettingsPage() {
  const { t } = useTranslation("settings");
  return (
    <PageShell
      action={<RememberFact />}
      description={t("memoryPage.description")}
      title={t("memoryPage.title")}
    >
      <MemoryPauseControlsSection />
      <MemoryList />
    </PageShell>
  );
}
