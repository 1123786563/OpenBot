import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AstryxSurface } from "@/components/astryx-pilot/theme";
import { PageShell } from "@/components/layout/page-shell";
import { LearningReview } from "@/components/settings/learning-review";
import { LearningSharing } from "@/components/settings/learning-sharing";
import { NativeLearningSkills } from "@/components/settings/native-learning-skills";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";

export const Route = createFileRoute("/_authed/settings/learning")({
  component: LearningSettingsPage,
});

export function LearningSettingsPage() {
  const { data: capabilities, isPending } = useQuery(
    deploymentCapabilitiesQueryOptions(),
  );
  const native = capabilities?.mode === "openbot";
  const personal = capabilities?.edition === "personal";
  return (
    <AstryxSurface className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageShell
        title="Learning"
        description={
          native
            ? "Review what your Bots learned and manage access to published skills."
            : personal
              ? "Your recordings and conversations teach your Bots new skills. Review what they learned here."
              : "Every recording you make goes into your own Learning space, and the Skills learned there reach every Bot you use. Choose who else's Bots may use them too."
        }
      >
        <LearningReview />
        {native ? <NativeLearningSkills /> : !isPending && <LearningSharing />}
        <Link
          className="mt-6 inline-block text-sm underline underline-offset-4"
          to="/ideas"
        >
          Open Ideas
        </Link>
      </PageShell>
    </AstryxSurface>
  );
}
