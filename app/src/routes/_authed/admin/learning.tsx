import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageSection, PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import {
  createLearningContainer,
  learningAutomaticQueryOptions,
  learningDeliveryQueryOptions,
  learningKeys,
  learningOverviewQueryOptions,
  learningSettingsQueryOptions,
  saveLearningSettings,
} from "@/lib/learning/queries";
import type {
  LearningAutoAssignState,
  LearningSettings,
  LearningTarget,
} from "../../../../../shared/learning";

export const Route = createFileRoute("/_authed/admin/learning")({
  component: LearningPage,
});
const selectClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";

/** What automatic assignment found, in words, or nothing when there is nothing to say. */
function automaticMessage(
  automatic: LearningAutoAssignState | null | undefined,
  settings: LearningSettings,
  t: TFunction<"admin">,
): string | undefined {
  if (!automatic) return undefined;
  if (
    automatic.state === "assigned" &&
    settings.defaultTarget?.containerId === automatic.containerId
  )
    return t("learning.automatic.assigned", {
      container: automatic.containerId,
    });
  if (automatic.state === "absent")
    return t("learning.automatic.absent", {
      container: automatic.containerId,
    });
  if (automatic.state === "not_entitled")
    return t("learning.automatic.notEntitled");
  if (automatic.state === "unavailable")
    return t("learning.automatic.unavailable");
  return undefined;
}

function TargetFields({
  target,
  onChange,
  label,
}: {
  target: LearningTarget | null;
  onChange: (target: LearningTarget | null) => void;
  label: string;
}) {
  const { t } = useTranslation("admin");
  const fieldId = useId();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-2 text-sm" htmlFor={`${fieldId}-container`}>
        {t("learning.targetFields.container", { label })}
        <Input
          id={`${fieldId}-container`}
          aria-label={t("learning.targetFields.containerAria", { label })}
          value={target?.containerId ?? ""}
          maxLength={64}
          placeholder="support-learning"
          onChange={(event) =>
            onChange(
              event.target.value
                ? { ...target, containerId: event.target.value }
                : null,
            )
          }
        />
      </label>
      <label className="grid gap-2 text-sm" htmlFor={`${fieldId}-revision`}>
        {t("learning.targetFields.revision")}
        <Input
          id={`${fieldId}-revision`}
          aria-label={t("learning.targetFields.revisionAria", { label })}
          value={target?.revision ?? ""}
          disabled={!target}
          placeholder={t("learning.targetFields.latestPublished")}
          maxLength={256}
          onChange={(event) => {
            if (target)
              onChange({
                containerId: target.containerId,
                ...(event.target.value ? { revision: event.target.value } : {}),
              });
          }}
        />
      </label>
    </div>
  );
}

/**
 * The missing container, and how it gets made: a button when this deployment holds a credential that
 * can create it, and always the exact steps for an operator, since the runtime key cannot.
 */
function ContainerSetup({
  automatic,
}: {
  automatic: Extract<LearningAutoAssignState, { state: "absent" }>;
}) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: createLearningContainer,
    onSuccess: async (next) => {
      queryClient.setQueryData(learningKeys.automatic, next);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm">
      {automatic.canCreate && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending
              ? t("learning.setup.creating")
              : t("learning.setup.create", {
                  container: automatic.containerId,
                })}
          </Button>
          <span className="text-muted-foreground">
            {t("learning.setup.usesCredential")}
          </span>
        </div>
      )}
      {(create.error || automatic.createError) && (
        <p role="alert" className="text-destructive">
          {create.error?.message ?? automatic.createError}
        </p>
      )}
      {automatic.instructions && (
        <p>
          <span className="font-medium">{t("learning.setup.toCreateIt")}</span>{" "}
          {automatic.instructions}
        </p>
      )}
    </div>
  );
}

export function LearningPage() {
  const { t } = useTranslation("admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(learningSettingsQueryOptions());
  const automatic = useQuery(learningAutomaticQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const roster = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const [draft, setDraft] = useState<LearningSettings | null>(null);
  const [selected, setSelected] = useState("");
  const [saved, setSaved] = useState(false);
  const overview = useQuery(
    learningOverviewQueryOptions(selected || undefined),
  );
  const delivery = useQuery(learningDeliveryQueryOptions(selected));
  const settings = draft ?? settingsQuery.data;
  // About what is saved, so it steps aside while an edit is in progress.
  const automaticNote =
    settingsQuery.data && !draft
      ? automaticMessage(automatic.data, settingsQuery.data, t)
      : undefined;
  const save = useMutation({
    mutationFn: saveLearningSettings,
    onSuccess: async (next) => {
      queryClient.setQueryData(learningKeys.settings, next);
      setDraft(null);
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
  function change(next: LearningSettings) {
    setDraft(next);
    setSaved(false);
    save.reset();
  }
  const botIds = [
    ...new Set([
      ...roster.map((agent) => agent.id),
      ...Object.keys(settings?.agents ?? {}),
    ]),
  ];
  const nameFor = (id: string) =>
    roster.find((agent) => agent.id === id)?.name ?? id;
  const snapshot = overview.data;

  return (
    <PageShell
      title={t("learning.title")}
      description={t("learning.description")}
    >
      <PageSection
        title="Participation"
        description="Changes to container assignments apply to new threads. Existing threads keep their first assignment. Containers must already exist in the same Intelligence project. Until anything is saved here, OpenBot assigns that project's openbot container automatically."
      >
        {settingsQuery.isPending && (
          <p role="status">{t("learning.loading")}</p>
        )}
        {settingsQuery.error && (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {settingsQuery.error.message}
          </p>
        )}
        {settings && (
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(settings);
            }}
          >
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  change({ ...settings, enabled: event.target.checked })
                }
              />
              {t("learning.participation.enable")}
            </label>
            <TargetFields
              label={t("learning.participation.default")}
              target={settings.defaultTarget}
              onChange={(defaultTarget) =>
                change({ ...settings, defaultTarget })
              }
            />
            {automaticNote && (
              <p role="status" className="text-sm">
                {automaticNote}
              </p>
            )}
            {!draft && automatic.data?.state === "absent" && (
              <ContainerSetup automatic={automatic.data} />
            )}
            <p className="text-muted-foreground text-sm">
              {t("learning.participation.idHint")}
            </p>
            <fieldset className="grid gap-4">
              <legend className="mb-3 font-medium">
                {t("learning.participation.perBot")}
              </legend>
              {(agents.error || hiddenAgents.error) && (
                <p role="alert" className="mt-4 text-destructive text-sm">
                  {t("learning.participation.rosterError")}
                </p>
              )}
              {botIds.map((id) => {
                const override = settings.agents[id];
                const mode = !Object.hasOwn(settings.agents, id)
                  ? "inherit"
                  : override === null
                    ? "exclude"
                    : "container";
                return (
                  <div key={id} className="grid gap-3 rounded-lg border p-4">
                    <label className="grid gap-2 text-sm font-medium">
                      {nameFor(id)}
                      <select
                        className={selectClass}
                        aria-label={t("learning.participation.botAria", {
                          name: nameFor(id),
                        })}
                        value={mode}
                        onChange={(event) => {
                          const mappings = { ...settings.agents };
                          if (event.target.value === "inherit")
                            delete mappings[id];
                          else
                            mappings[id] =
                              event.target.value === "exclude"
                                ? null
                                : {
                                    containerId:
                                      settings.defaultTarget?.containerId ?? "",
                                  };
                          change({ ...settings, agents: mappings });
                        }}
                      >
                        <option value="inherit">
                          {t("learning.participation.useDefault")}
                        </option>
                        <option value="exclude">
                          {t("learning.participation.exclude")}
                        </option>
                        <option value="container">
                          {t("learning.participation.useContainer")}
                        </option>
                      </select>
                    </label>
                    {mode === "container" && (
                      <TargetFields
                        label={nameFor(id)}
                        target={override ?? null}
                        onChange={(target) =>
                          change({
                            ...settings,
                            agents: {
                              ...settings.agents,
                              [id]: target ?? { containerId: "" },
                            },
                          })
                        }
                      />
                    )}
                  </div>
                );
              })}
            </fieldset>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t("learning.saving") : t("learning.save")}
              </Button>
              {saved && (
                <p role="status" className="text-sm">
                  {t("learning.saved")}
                </p>
              )}
            </div>
            {save.error && (
              <p role="alert" className="mt-4 text-destructive text-sm">
                {save.error.message}
              </p>
            )}
          </form>
        )}
      </PageSection>
      <PageSection
        title={t("learning.review.title")}
        description={t("learning.review.description")}
      >
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm">
            {t("learning.review.inspectFor")}
            <select
              className={selectClass}
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">{t("learning.review.deploymentDefault")}</option>
              {botIds.map((id) => (
                <option key={id} value={id}>
                  {nameFor(id)}
                </option>
              ))}
            </select>
          </label>
          {overview.isPending && (
            <p role="status">{t("learning.review.checking")}</p>
          )}
          {overview.error && (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {overview.error.message}
            </p>
          )}
          {snapshot && (
            <>
              <p className="text-sm">
                {snapshot.configuration === "configured"
                  ? `${snapshot.container?.name} (${snapshot.container?.id})`
                  : snapshot.configuration === "invalid"
                    ? t("learning.review.invalid")
                    : snapshot.configuration === "selection_required"
                      ? t("learning.review.selectionRequired")
                      : t("learning.review.notAssigned")}
              </p>
              <dl className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">
                    {t("learning.review.threadsReady")}
                  </dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.pendingThreadCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("learning.review.candidates")}
                  </dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.pendingCandidateCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("learning.review.publishedSkills")}
                  </dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.publishedSkillCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t("learning.review.insights")}
                  </dt>
                  <dd className="font-semibold text-xl">
                    {snapshot.insightCount}
                  </dd>
                </div>
              </dl>
              <p className="text-sm">
                {snapshot.hasActiveRun
                  ? t("learning.review.analysisRunning")
                  : snapshot.latestRunStatus
                    ? t("learning.review.latestAnalysis", {
                        status: snapshot.latestRunStatus,
                      })
                    : t("learning.review.noAnalysis")}
              </p>
              <div className="flex flex-wrap gap-4 text-sm underline">
                <a
                  href={snapshot.links.learning}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("learning.review.manageLink")}
                </a>
                {snapshot.links.candidates && (
                  <a
                    href={snapshot.links.candidates}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("learning.review.candidatesLink")}
                  </a>
                )}
                {snapshot.links.runs && (
                  <a
                    href={snapshot.links.runs}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("learning.review.runsLink")}
                  </a>
                )}
              </div>
            </>
          )}
          {selected && (
            <div className="grid gap-2 rounded-lg border p-4 text-sm">
              <h3 className="font-medium">{t("learning.delivery.title")}</h3>
              {delivery.isPending ? (
                <p>{t("learning.delivery.checking")}</p>
              ) : delivery.error ? (
                <p role="alert">{delivery.error.message}</p>
              ) : (
                delivery.data && (
                  <>
                    <p>
                      {!delivery.data.configured
                        ? t("learning.delivery.off")
                        : !delivery.data.initialized
                          ? t("learning.delivery.waitingSnapshot")
                          : delivery.data.stale
                            ? t("learning.delivery.stale")
                            : t("learning.delivery.verified")}
                    </p>
                    {delivery.data.revision && (
                      <p>
                        {t("learning.delivery.loadedRevision", {
                          revision: delivery.data.revision,
                        })}
                      </p>
                    )}
                    {delivery.data.lastCheckedAt && (
                      <p>
                        {t("learning.delivery.lastChecked", {
                          time: formatDateTime(delivery.data.lastCheckedAt),
                        })}
                      </p>
                    )}
                    {delivery.data.error && (
                      <p role="alert">{delivery.data.error.message}</p>
                    )}
                  </>
                )
              )}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={overview.isFetching || delivery.isFetching}
            onClick={() => {
              void overview.refetch();
              if (selected) void delivery.refetch();
            }}
          >
            {t("learning.review.refresh")}
          </Button>
          <p className="text-muted-foreground text-sm">
            {t("learning.review.permissionsNote")}
          </p>
        </div>
      </PageSection>
    </PageShell>
  );
}
