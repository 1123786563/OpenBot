import { useQuery } from "@tanstack/react-query";
import { linkOptions, useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { useTranslation } from "@/i18n";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export function CapabilitiesShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  const memory = Boolean(
    matchRoute({ to: "/capabilities/memory", fuzzy: true }),
  );
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";

  return (
    <CapabilityPage
      backButton={
        personal
          ? {
              label: t("nav.bots", "Bots"),
              linkProps: linkOptions({ to: "/bots" }),
            }
          : undefined
      }
      className="@container"
      title={memory ? t("nav.memory", "Memory") : t("nav.skills", "Skills")}
      description={
        memory
          ? "Manage what your Bots remember about you and how you work."
          : "Write reusable instructions your Bots can follow, and review skills shared with you."
      }
    >
      {children}
    </CapabilityPage>
  );
}
