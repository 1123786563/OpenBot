import { IconChevronRight, IconFlask } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { observationScreenFault } from "@/components/ai-observability/state-notice";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  type ObservationDatasetListItem,
  observationDatasetDetailQueryOptions,
  observationDatasetsQueryOptions,
} from "@/lib/ai-observability/datasets";
import {
  observationSubmitExperimentMutationOptions,
  type SubmittedExperimentResult,
} from "@/lib/ai-observability/experiments";

/*
 * The experiments section of the evaluations page (Issue #36): one row that opens the
 * submit dialog. The dialog freezes the T22 contract — dataset version, Bot
 * configuration snapshot, prompt, model and parameters, tool fixtures, judge
 * configuration and version — and the answer says what froze: the config hash, the
 * canary count of fields the redaction policy refused, and whether an identical
 * configuration had already been frozen (replayed — nothing new was created).
 *
 * The section reads the same datasets list the page's own datasets section shows —
 * the shared query key dedupes the fetch — because a submission must choose a frozen
 * version this Bot actually holds. Where that read could not answer, no entry is
 * drawn: a refused or unavailable scope has nothing to submit against, the same
 * discipline the save entry follows.
 */

type SubmitDraft = {
  name: string;
  datasetId: string;
  versionId: string;
  prompt: string;
  modelName: string;
  modelParameters: string;
  botConfig: string;
  toolFixtures: string;
  judgeConfig: string;
  judgeVersion: string;
};

const EMPTY_DRAFT: SubmitDraft = {
  name: "",
  datasetId: "",
  versionId: "",
  prompt: "",
  modelName: "",
  modelParameters: "{}",
  botConfig: "{}",
  toolFixtures: "{}",
  judgeConfig: "{}",
  judgeVersion: "",
};

/** The JSON-object fields of the frozen contract: `{value}` when the text parses, `{null}` when not. */
function parseJsonObject(raw: string): {
  value: Record<string, unknown> | null;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { value: null };
    }
    return { value: parsed as Record<string, unknown> };
  } catch {
    return { value: null };
  }
}

export function ObservationExperimentsSection({ botId }: { botId: string }) {
  const { t } = useTranslation("ai-observability-evaluations");
  const screen = useQuery(observationDatasetsQueryOptions(botId));

  // Pending renders nothing (the page's other sections hold the frame); a fault draws
  // no entry, because the datasets read is the submission's own precondition.
  if (screen.isPending || screen.error) return null;
  const answer = screen.data;
  if (answer === undefined || answer.view !== "list") return null;

  return (
    <PageSection
      description={t("submit.rowDescription")}
      title={t("submit.rowTitle")}
    >
      <SubmitExperimentRow botId={botId} datasets={answer.result.datasets} />
      {answer.result.datasets.length === 0 ? (
        <p className="mt-6 text-muted-foreground text-sm" role="status">
          {t("availability.empty.description")}
        </p>
      ) : null}
    </PageSection>
  );
}

function SubmitExperimentRow({
  botId,
  datasets,
}: {
  botId: string;
  datasets: readonly ObservationDatasetListItem[];
}) {
  const { t } = useTranslation("ai-observability-evaluations");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SubmitDraft>(EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState<SubmittedExperimentResult | null>(
    null,
  );
  const [refusal, setRefusal] = useState<string | null | undefined>(undefined);

  /*
   * The dialog's generation (OCR round 2, R2-03): closing raises it, so an in-flight
   * submission whose answer lands after the reset is a fact about a submission that
   * is gone — it must not write the reopened blank dialog's state.
   */
  const dialogSession = useRef(0);

  const submitExperiment = useMutation(
    observationSubmitExperimentMutationOptions(),
  );

  const jsonFields = {
    botConfig: parseJsonObject(draft.botConfig),
    modelParameters: parseJsonObject(draft.modelParameters),
    toolFixtures: parseJsonObject(draft.toolFixtures),
    judgeConfig: parseJsonObject(draft.judgeConfig),
  };
  const jsonInvalid = Object.values(jsonFields).some(
    (field) => field.value === null,
  );
  const complete =
    draft.name.trim() !== "" &&
    draft.versionId !== "" &&
    draft.prompt.trim() !== "" &&
    draft.modelName.trim() !== "" &&
    draft.judgeVersion.trim() !== "";

  // The version choices follow the chosen dataset; the datasets list above the dialog
  // is the same query key, so the detail read is the only extra fetch.
  const datasetId = draft.datasetId;
  const detail = useQuery({
    ...observationDatasetDetailQueryOptions(botId, datasetId),
    enabled: open && datasetId !== "",
  });
  const versions =
    detail.data?.view === "detail" ? detail.data.result.versions : [];
  /*
   * The version select's one fault sentence (OCR round 2, R2-04): the shared screen
   * derivation covers both halves — the read's fault view and a transport-level
   * error (detail.error) — where the data?.view check alone left the dropdown
   * silently empty and, with versionId required, the submit silently locked.
   */
  const versionsFault = observationScreenFault(detail);

  const update = (patch: Partial<SubmitDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const startSubmit = () => {
    setRefusal(undefined);
    if (!complete || jsonInvalid) return;
    const session = dialogSession.current;
    submitExperiment.mutate(
      {
        botId,
        body: {
          name: draft.name,
          datasetVersionId: draft.versionId,
          config: {
            botConfig: jsonFields.botConfig.value ?? {},
            prompt: draft.prompt,
            modelName: draft.modelName,
            modelParameters: jsonFields.modelParameters.value ?? {},
            toolFixtures: jsonFields.toolFixtures.value ?? {},
            judgeConfig: jsonFields.judgeConfig.value ?? {},
            judgeVersion: draft.judgeVersion,
          },
        },
      },
      {
        onSuccess: (attempt) => {
          if (dialogSession.current !== session) return;
          if (attempt.ok) {
            setSubmitted(attempt.result);
          } else {
            setRefusal(attempt.refusal);
          }
        },
        // A request that never answered at all (the network layer rejected before
        // any HTTP verdict) is its own sentence, not a silently re-enabled button.
        onError: () => {
          if (dialogSession.current !== session) return;
          setRefusal(null);
        },
      },
    );
  };

  const closeDialog = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // A reopened dialog starts from a blank slate — the last submission's answer
      // is a fact about a submission that is gone. The session bump retires any
      // in-flight answer so it cannot write over the reset.
      dialogSession.current += 1;
      setDraft(EMPTY_DRAFT);
      setSubmitted(null);
      setRefusal(undefined);
    }
  };

  return (
    <>
      <PageRows>
        <Item
          render={
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-haspopup="dialog"
            />
          }
          size="sm"
        >
          <ItemMedia variant="icon">
            <IconFlask className="size-4 text-muted-foreground" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("submit.rowTitle")}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {t("submit.dialogDescription")}
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <IconChevronRight className="size-4 text-muted-foreground" />
          </ItemActions>
        </Item>
      </PageRows>

      <Dialog onOpenChange={closeDialog} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("submit.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("submit.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="experiment-submit-name">
                  {t("submit.name")}
                </FieldLabel>
                <Input
                  id="experiment-submit-name"
                  onChange={(event) => update({ name: event.target.value })}
                  value={draft.name}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-dataset">
                  {t("submit.dataset")}
                </FieldLabel>
                <select
                  aria-label={t("submit.dataset")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  id="experiment-submit-dataset"
                  onChange={(event) =>
                    update({
                      datasetId: event.target.value,
                      versionId: "",
                    })
                  }
                  value={draft.datasetId}
                >
                  <option value="" />
                  {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-version">
                  {t("submit.version")}
                </FieldLabel>
                <select
                  aria-label={t("submit.version")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  disabled={draft.datasetId === ""}
                  id="experiment-submit-version"
                  onChange={(event) =>
                    update({ versionId: event.target.value })
                  }
                  value={draft.versionId}
                >
                  <option value="" />
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {t("submit.versionCases", {
                        count: version.caseCount,
                        id: version.id,
                      })}
                    </option>
                  ))}
                </select>
                {draft.datasetId !== "" && versionsFault !== null ? (
                  <p className="text-destructive text-sm" role="alert">
                    {t("submit.versionsUnavailable")}
                  </p>
                ) : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-prompt">
                  {t("submit.prompt")}
                </FieldLabel>
                <Textarea
                  className="h-24"
                  id="experiment-submit-prompt"
                  onChange={(event) => update({ prompt: event.target.value })}
                  value={draft.prompt}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-model">
                  {t("submit.modelName")}
                </FieldLabel>
                <Input
                  id="experiment-submit-model"
                  onChange={(event) =>
                    update({ modelName: event.target.value })
                  }
                  value={draft.modelName}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-model-parameters">
                  {t("submit.modelParameters")}
                </FieldLabel>
                <Textarea
                  className="h-20 font-mono text-sm"
                  id="experiment-submit-model-parameters"
                  onChange={(event) =>
                    update({ modelParameters: event.target.value })
                  }
                  value={draft.modelParameters}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-bot-config">
                  {t("submit.botConfig")}
                </FieldLabel>
                <Textarea
                  className="h-20 font-mono text-sm"
                  id="experiment-submit-bot-config"
                  onChange={(event) =>
                    update({ botConfig: event.target.value })
                  }
                  value={draft.botConfig}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-tool-fixtures">
                  {t("submit.toolFixtures")}
                </FieldLabel>
                <Textarea
                  className="h-20 font-mono text-sm"
                  id="experiment-submit-tool-fixtures"
                  onChange={(event) =>
                    update({ toolFixtures: event.target.value })
                  }
                  value={draft.toolFixtures}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-judge-config">
                  {t("submit.judgeConfig")}
                </FieldLabel>
                <Textarea
                  className="h-20 font-mono text-sm"
                  id="experiment-submit-judge-config"
                  onChange={(event) =>
                    update({ judgeConfig: event.target.value })
                  }
                  value={draft.judgeConfig}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="experiment-submit-judge-version">
                  {t("submit.judgeVersion")}
                </FieldLabel>
                <Input
                  id="experiment-submit-judge-version"
                  onChange={(event) =>
                    update({ judgeVersion: event.target.value })
                  }
                  value={draft.judgeVersion}
                />
              </Field>
            </FieldGroup>

            {!complete ? (
              <p className="mt-3 text-muted-foreground text-xs">
                {t("submit.incomplete")}
              </p>
            ) : null}
            {complete && jsonInvalid ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {t("submit.jsonInvalid")}
              </p>
            ) : null}

            {submitted ? (
              <div
                className="mt-4 flex flex-col gap-2 rounded-lg border p-3 text-sm"
                role="status"
              >
                <p>
                  {submitted.replayed
                    ? t("submit.submittedReplay")
                    : t("submit.submittedNew")}
                </p>
                <span className="break-all font-mono text-xs">
                  {submitted.configHash}
                </span>
                {submitted.canaryFindings > 0 ? (
                  <p className="text-muted-foreground">
                    {t("submit.canary", { count: submitted.canaryFindings })}
                  </p>
                ) : null}
                <Separator />
                <Link
                  className="text-sm underline underline-offset-4"
                  params={{
                    agentId: botId,
                    experimentId: submitted.experimentId,
                    executionId: submitted.executionId,
                  }}
                  to="/bots/$agentId/evaluations/experiments/$experimentId/$executionId"
                >
                  {t("submit.viewResults")}
                </Link>
              </div>
            ) : null}

            {refusal !== undefined ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {refusal === null
                  ? t("error.unreachable")
                  : t(`error.${refusal}`, {
                      defaultValue: t("error.unreachable"),
                    })}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              disabled={!complete || jsonInvalid || submitExperiment.isPending}
              onClick={startSubmit}
              size="sm"
              type="button"
            >
              {t("submit.submit")}
            </Button>
            <Button
              onClick={() => closeDialog(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("submit.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
