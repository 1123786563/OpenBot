import {
  IconChevronRight,
  IconDatabase,
  IconDatabaseImport,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StateNotice } from "@/components/ai-observability/state-notice";
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
  type CaseReviewOutcome,
  type ObservationDatasetListItem,
  observationDatasetsQueryOptions,
  observationReviewCaseMutationOptions,
  observationSaveCaseMutationOptions,
  type SavedDatasetVersionResult,
} from "@/lib/ai-observability/datasets";
import { useDateTime } from "@/lib/i18n/datetime";
import { queryClient } from "@/query-client";
import type { SafeText, SafeValue } from "../../../../shared/ai-observability";

/*
 * The creator's dataset list (Issue #27): one page that both invites the save flow — review
 * one case from a run, watch the projection, freeze it — and answers what the scope already
 * holds. Every fact comes from the wire contract in shared/ai-observability-datasets.ts;
 * every fact the wire could not answer keeps its own availability sentence, never a guess.
 *
 * Versions are immutable by construction and the page says so with what it refuses to offer:
 * a dataset row navigates, a version row (on the detail page) does not edit — there is no
 * second kind of truth to reconcile with the database's no-UPDATE trigger.
 */

/** The one translation the preview's markers need — narrow so typed keys still check. */
type MarkerTranslate = (key: "marker.omitted" | "marker.truncated") => string;

/** A projected field as one line of text: the content, or the state that explains its absence. */
function safeTextLine(text: SafeText, t: MarkerTranslate): string {
  if (text.state === "omitted") return t("marker.omitted");
  if (text.state === "truncated")
    return `${text.text} · ${t("marker.truncated")}`;
  return text.text;
}

function safeValueLine(value: SafeValue, t: MarkerTranslate): string {
  if (value.state === "omitted") return t("marker.omitted");
  const shown =
    value.state === "truncated"
      ? `${JSON.stringify(value.value) ?? "null"} · ${t("marker.truncated")}`
      : (JSON.stringify(value.value) ?? "null");
  return shown;
}

/**
 * The datasets section of the evaluations page: the frozen-version list and the save
 * flow. The Bot frame lives one level up, on ObservationEvaluationsPage — the page the
 * experiment chains (#36 #37) add their sections beside, per the route convention's
 * one-URL decision — so this body is a mountable unit without the authenticated
 * runtime the layout drags in.
 */
export function ObservationDatasetsBody({ botId }: { botId: string }) {
  const { t } = useTranslation("ai-observability-datasets");
  const screen = useQuery(observationDatasetsQueryOptions(botId));

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const answer = screen.data;
  const fault = screen.error
    ? "unavailable"
    : answer === undefined || answer.view === "fault"
      ? (answer?.fault ?? "unavailable")
      : null;

  if (fault !== null) {
    return (
      <StateNotice
        className="mt-6"
        description={t(`availability.${fault}.description`)}
        title={t(`availability.${fault}.title`)}
      />
    );
  }
  if (answer === undefined || answer.view !== "list") return null;

  const { datasets } = answer.result;
  return (
    <>
      {/*
       * The save invitation only exists where the read answered: a disabled or refused scope
       * has nothing to save into, and drawing the entry would promise a write the store
       * already refused.
       */}
      <PageSection
        description={t("save.rowDescription")}
        title={t("save.rowTitle")}
      >
        <SaveCaseSection botId={botId} />
      </PageSection>
      <PageSection description={t("list.description")} title={t("list.title")}>
        {datasets.length === 0 ? (
          <StateNotice
            className="mt-6"
            description={t("availability.empty.description")}
            title={t("availability.empty.title")}
          />
        ) : (
          <PageRows>
            {datasets.map((dataset, index) => (
              <DatasetRow
                botId={botId}
                dataset={dataset}
                key={dataset.id}
                showSeparator={index > 0}
              />
            ))}
          </PageRows>
        )}
      </PageSection>
    </>
  );
}

function DatasetRow({
  botId,
  dataset,
  showSeparator,
}: {
  botId: string;
  dataset: ObservationDatasetListItem;
  showSeparator: boolean;
}) {
  const { t } = useTranslation("ai-observability-datasets");
  const { formatDateTime } = useDateTime();
  return (
    <>
      {showSeparator ? <Separator /> : null}
      <Item
        render={
          <Link
            params={{ agentId: botId, datasetId: dataset.id }}
            to="/bots/$agentId/evaluations/$datasetId"
          />
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconDatabase className="size-4 text-muted-foreground" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{dataset.name}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {[
              t(`sync.${dataset.syncState}`),
              t("list.versions", { count: dataset.versionCount }),
              dataset.latestVersionAt === null
                ? t("row.noVersion")
                : formatDateTime(dataset.latestVersionAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
            ].join(" · ")}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
    </>
  );
}

type SaveDraft = {
  runId: string;
  datasetName: string;
  input: string;
  referenceOutput: string;
  fixtures: string;
};

const EMPTY_DRAFT: SaveDraft = {
  runId: "",
  datasetName: "",
  input: "",
  referenceOutput: "",
  fixtures: "{}",
};

/** Parses the fixtures textarea: `{ok: value}` when it is a JSON object, `{ok: null}` when not. */
function parseFixtures(raw: string): { value: Record<string, unknown> | null } {
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

/**
 * The save entry: one row that opens the review-and-save dialog. Review and save are two
 * presses on purpose (T20's two operations): the first shows exactly what the redaction
 * policy would freeze, the second freezes it — and any edit after the review clears the
 * preview, because what was reviewed is the only thing that may be saved.
 */
function SaveCaseSection({ botId }: { botId: string }) {
  const { t } = useTranslation("ai-observability-datasets");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SaveDraft>(EMPTY_DRAFT);
  const [review, setReview] = useState<{
    snapshot: string;
    outcome: CaseReviewOutcome;
  } | null>(null);
  const [reviewRefusal, setReviewRefusal] = useState<string | null | undefined>(
    undefined,
  );
  const [saved, setSaved] = useState<SavedDatasetVersionResult | null>(null);
  const [saveRefusal, setSaveRefusal] = useState<string | null | undefined>(
    undefined,
  );

  /*
   * The dialog's generation (OCR round 2, R2-02): closing raises it, so an in-flight
   * review or save whose answer lands after the reset is a fact about a dialog that
   * is gone — it must not write the reopened blank's state.
   */
  const dialogSession = useRef(0);

  const reviewCase = useMutation(observationReviewCaseMutationOptions());
  const saveCase = useMutation(observationSaveCaseMutationOptions(queryClient));

  const fixtures = parseFixtures(draft.fixtures);
  const complete =
    draft.runId.trim() !== "" &&
    draft.datasetName.trim() !== "" &&
    draft.input.trim() !== "" &&
    draft.referenceOutput.trim() !== "";
  // The preview vouches for exactly this draft; one keystroke after the review retires it.
  const snapshot = JSON.stringify([
    draft.runId,
    draft.input,
    draft.referenceOutput,
    draft.fixtures,
  ]);
  const reviewed = review !== null && review.snapshot === snapshot;

  const fragment = () => ({
    input: draft.input,
    referenceOutput: draft.referenceOutput,
    toolFixtures: fixtures.value ?? {},
  });

  const startReview = () => {
    setReviewRefusal(undefined);
    if (!complete || fixtures.value === null) return;
    const session = dialogSession.current;
    reviewCase.mutate(
      {
        botId,
        body: {
          runId: draft.runId,
          decision: "approved",
          cases: [fragment()],
        },
      },
      {
        onSuccess: (attempt) => {
          if (dialogSession.current !== session) return;
          if (attempt.ok) {
            setReview({ snapshot, outcome: attempt.result });
          } else {
            setReview(null);
            setReviewRefusal(attempt.refusal);
          }
        },
        // A request that never answered at all (the network layer rejected before
        // any HTTP verdict) is its own sentence, not a silently re-enabled button.
        onError: () => {
          if (dialogSession.current !== session) return;
          setReviewRefusal(null);
        },
      },
    );
  };

  const startSave = () => {
    setSaveRefusal(undefined);
    if (!reviewed) return;
    const session = dialogSession.current;
    saveCase.mutate(
      {
        botId,
        body: {
          datasetName: draft.datasetName,
          runId: draft.runId,
          cases: [fragment()],
        },
      },
      {
        onSuccess: (attempt) => {
          if (dialogSession.current !== session) return;
          if (attempt.ok) {
            setSaved(attempt.result);
          } else {
            setSaveRefusal(attempt.refusal);
          }
        },
        // A request that never answered at all (the network layer rejected before
        // any HTTP verdict) is its own sentence, not a silently re-enabled button.
        onError: () => {
          if (dialogSession.current !== session) return;
          setSaveRefusal(null);
        },
      },
    );
  };

  const closeDialog = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // The dialog resets: a reopened entry starts from a blank slate, not from the last
      // freeze's leftovers — a stale preview is a promise about content that is gone.
      // The session bump retires any in-flight answer so it cannot write the reset.
      dialogSession.current += 1;
      setDraft(EMPTY_DRAFT);
      setReview(null);
      setReviewRefusal(undefined);
      setSaved(null);
      setSaveRefusal(undefined);
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
            <IconDatabaseImport className="size-4 text-muted-foreground" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{t("save.rowTitle")}</ItemTitle>
            <ItemDescription className="line-clamp-none">
              {t("save.dialogDescription")}
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
            <DialogTitle>{t("save.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("save.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="dataset-save-run">
                  {t("save.runId")}
                </FieldLabel>
                <Input
                  id="dataset-save-run"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      runId: event.target.value,
                    }))
                  }
                  value={draft.runId}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dataset-save-name">
                  {t("save.datasetName")}
                </FieldLabel>
                <Input
                  id="dataset-save-name"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      datasetName: event.target.value,
                    }))
                  }
                  value={draft.datasetName}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dataset-save-input">
                  {t("save.caseInput")}
                </FieldLabel>
                <Textarea
                  className="h-24"
                  id="dataset-save-input"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      input: event.target.value,
                    }))
                  }
                  value={draft.input}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dataset-save-reference">
                  {t("save.referenceOutput")}
                </FieldLabel>
                <Textarea
                  className="h-24"
                  id="dataset-save-reference"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      referenceOutput: event.target.value,
                    }))
                  }
                  value={draft.referenceOutput}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="dataset-save-fixtures">
                  {t("save.toolFixtures")}
                </FieldLabel>
                <Textarea
                  className="h-20 font-mono text-sm"
                  id="dataset-save-fixtures"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      fixtures: event.target.value,
                    }))
                  }
                  value={draft.fixtures}
                />
              </Field>
            </FieldGroup>

            {!complete ? (
              <p className="mt-3 text-muted-foreground text-xs">
                {t("save.incomplete")}
              </p>
            ) : null}
            {complete && fixtures.value === null ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {t("save.fixturesInvalid")}
              </p>
            ) : null}

            {reviewed && review?.outcome.preview[0] ? (
              <div
                className="mt-4 flex flex-col gap-1 rounded-lg border p-3 text-sm"
                role="status"
              >
                <p className="font-medium">{t("save.previewTitle")}</p>
                <span>
                  {t("preview.input")}:{" "}
                  {safeTextLine(review.outcome.preview[0].safeInput, t)}
                </span>
                <span>
                  {t("preview.referenceOutput")}:{" "}
                  {safeTextLine(review.outcome.preview[0].referenceOutput, t)}
                </span>
                <span>
                  {t("preview.toolFixtures")}:{" "}
                  {safeValueLine(review.outcome.preview[0].toolFixtures, t)}
                </span>
                {review.outcome.canaryFindings > 0 ? (
                  <p className="text-muted-foreground">
                    {t("save.canary", { count: review.outcome.canaryFindings })}
                  </p>
                ) : null}
              </div>
            ) : complete && reviewRefusal === undefined && review !== null ? (
              <p className="mt-3 text-muted-foreground text-xs">
                {t("save.mustReview")}
              </p>
            ) : null}

            {reviewRefusal !== undefined ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {reviewRefusal === null
                  ? t("error.unreachable")
                  : t(`error.${reviewRefusal}`, {
                      defaultValue: t("error.unreachable"),
                    })}
              </p>
            ) : null}

            {saved ? (
              <div
                className="mt-4 flex flex-col gap-1 rounded-lg border p-3 text-sm"
                role="status"
              >
                <p>
                  {saved.replayed
                    ? t("save.savedReplay", {
                        hash: saved.version.contentHash,
                        name: saved.datasetName,
                      })
                    : t("save.savedNew", {
                        hash: saved.version.contentHash,
                        name: saved.datasetName,
                      })}
                </p>
                <p className="text-muted-foreground">
                  {t("save.savedCases", { count: saved.version.caseCount })}
                </p>
              </div>
            ) : null}

            {saveRefusal !== undefined ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {saveRefusal === null
                  ? t("error.unreachable")
                  : t(`error.${saveRefusal}`, {
                      defaultValue: t("error.unreachable"),
                    })}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              disabled={
                reviewCase.isPending || !complete || fixtures.value === null
              }
              onClick={startReview}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("save.review")}
            </Button>
            <Button
              disabled={!reviewed || saveCase.isPending || reviewCase.isPending}
              onClick={startSave}
              size="sm"
              type="button"
            >
              {t("save.save")}
            </Button>
            <Button
              onClick={() => closeDialog(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("save.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
