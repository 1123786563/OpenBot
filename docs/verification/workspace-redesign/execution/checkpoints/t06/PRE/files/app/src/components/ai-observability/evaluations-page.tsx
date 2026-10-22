import { useTranslation } from "react-i18next";
import { ObservationDatasetsBody } from "@/components/ai-observability/datasets-list";
import { ObservationExperimentsSection } from "@/components/ai-observability/experiments-section";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";

/*
 * The evaluations page (Issue #36): the one URL the route convention recorded for
 * datasets and experiments together. The Bot frame answers to the evaluations
 * namespace — the page is broader than its datasets section — and each chain's body
 * keeps its own data module, fault vocabulary and sentences. The experiment results
 * live one route deeper, at /bots/$agentId/evaluations/experiments/$experimentId/
 * $executionId, which a submission links to.
 */
export function ObservationEvaluationsPage({ agentId }: { agentId: string }) {
  const { t } = useTranslation("ai-observability-evaluations");
  return (
    <BotSubpage
      agentId={agentId}
      description={t("page.description")}
      title={t("page.title")}
    >
      {(agent) => (
        <>
          <ObservationDatasetsBody botId={agent.id} />
          <ObservationExperimentsSection botId={agent.id} />
        </>
      )}
    </BotSubpage>
  );
}
