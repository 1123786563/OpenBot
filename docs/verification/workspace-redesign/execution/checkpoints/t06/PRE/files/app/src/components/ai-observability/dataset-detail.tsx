import { IconLock } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { observationDatasetDetailQueryOptions } from "@/lib/ai-observability/datasets";
import { useDateTime } from "@/lib/i18n/datetime";
import { observationScreenFault, StateNotice } from "./state-notice";

/*
 * The frozen version history of one dataset (Issue #27). The page is deliberately the most
 * read-only surface in the app: every row states what froze, when, under which projection
 * policy, and by which content hash — and offers nothing that could change it, because the
 * database's no-UPDATE trigger is the truth and a UI control that disagreed with it would
 * be a lie with a button on it. Editing a case creates a *new* version; that happens on the
 * save flow of the list page, not here.
 */
export function ObservationDatasetDetailPage({
  agentId,
  datasetId,
}: {
  agentId: string;
  datasetId: string;
}) {
  const { t } = useTranslation("ai-observability-datasets");
  const { formatDateTime } = useDateTime();
  const screen = useQuery(
    observationDatasetDetailQueryOptions(agentId, datasetId),
  );

  const loaded = screen.data?.view === "detail" ? screen.data.result : null;
  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = observationScreenFault(screen);

  return (
    <PageShell
      backButton={{
        label: t("detail.back"),
        linkProps: {
          params: { agentId },
          to: "/bots/$agentId/evaluations",
        },
      }}
      description={t("page.description")}
      /* A pending read keeps the title blank rather than flashing the placeholder
       * (T21-rev F5): the honest name arrives with the data, and an empty title is
       * not a claim. A fault answers with the placeholder — the page it names is
       * genuinely an unnamed, failed read. */
      title={
        screen.isPending
          ? ""
          : loaded
            ? loaded.dataset.name
            : t("detail.untitled")
      }
    >
      {screen.isPending ? null : fault !== null ? (
        <StateNotice
          className="mt-6"
          description={t(`availability.${fault}.description`)}
          title={t(`availability.${fault}.title`)}
        />
      ) : !loaded || loaded.versions.length === 0 ? (
        <PageEmpty>{t("detail.noVersions")}</PageEmpty>
      ) : (
        <PageSection
          description={t("version.description")}
          title={t("version.title")}
        >
          <PageRows>
            {loaded.versions.map((version, index) => (
              <Fragment key={version.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconLock className="size-4 text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {formatDateTime(version.createdAt, {
                        dateStyle: "medium",
                        timeStyle: "medium",
                      })}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      <span className="break-all font-mono text-xs">
                        {version.contentHash}
                      </span>
                      {" · "}
                      {t("version.policy", {
                        policy: version.redactionPolicyVersion,
                      })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <span className="text-muted-foreground text-xs">
                      {t("version.cases", { count: version.caseCount })}
                    </span>
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      )}
    </PageShell>
  );
}
