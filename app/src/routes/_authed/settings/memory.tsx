import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryCleanupSection } from "@/components/memory/cleanup-progress";
import { JudgmentReviewSections } from "@/components/memory/judgment-review";
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
      <JudgmentReviewSections />
      <MemoryCleanupSection />
    </PageShell>
  );
}
