import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  correctEvidenceMutationOptions,
  forgetJudgmentMutationOptions,
  forgetPreferenceEvidenceMutationOptions,
  forgetSourceBoundEvidenceMutationOptions,
} from "@/lib/hindsight/mutations";
import {
  type EvidenceInspection,
  scopedEvidenceInspectionQueryOptions,
} from "@/lib/hindsight/queries";
import { useDateTime } from "@/lib/i18n/datetime";

/**
 * The basis behind a judgment or a memory entry, expanded (#387 AC1): every id the caller
 * cited, re-decided NOW by the evidence seam. An entry the person can no longer see draws
 * "Unavailable" and nothing else — no content, no source, no date — because the seam refuses to
 * distinguish a revoked basis from one that never existed, and the screen does not invent the
 * difference.
 *
 * The person can also act FROM an entry (#387 AC2): correct a preference basis, forget any
 * forgettable one. Both settle the namespace, so the expansion the person is reading refreshes
 * into its after-state on its own — the forgotten entry becomes unavailable, not vanished.
 * Editing a judgment entry stays on the review surface, where the judgment's own row lives.
 */
export function EvidenceDialog({
  ids,
  title,
  onClose,
  onForgotten,
}: {
  ids: string[];
  title: string;
  onClose: () => void;
  /**
   * Where a forget's honest instant also goes when the dialog's own row may not survive it
   * (the answer-basis listing drops the entry that was forgotten). The dialog's own note
   * says it either way.
   */
  onForgotten?: (stoppedAt: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  // The expansion rides the scope the screen holds, like every other memory call (MT089).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const inspection = useQuery(
    scopedEvidenceInspectionQueryOptions(queryClient, scope, ids),
  );
  const correct = useMutation(
    correctEvidenceMutationOptions(queryClient, scope),
  );
  const forgetPreference = useMutation(
    forgetPreferenceEvidenceMutationOptions(queryClient, scope),
  );
  const forgetSourceBound = useMutation(
    forgetSourceBoundEvidenceMutationOptions(queryClient, scope),
  );
  const forgetJudgment = useMutation(
    forgetJudgmentMutationOptions(queryClient, scope),
  );
  const [correcting, setCorrecting] = useState<EvidenceInspection | null>(null);
  /** The instant the last forget took effect, so the screen says "stopped" and nothing wider. */
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  const [corrected, setCorrected] = useState(false);
  /**
   * Why the last forget did not take effect, in the dialog itself: this is the one path that
   * removes a memory, so a failure the screen swallowed would read as success — the entry
   * stays, but the person believes it is forgotten. Shown until the next attempt starts.
   */
  const [forgetError, setForgetError] = useState<string | null>(null);
  // The mutation a forget rides, by the entry's own kind: a preference basis forgets through
  // the preferences seam, a source-bound one through the source-bound seam, a judgment through
  // the judgment seam — and an entry that is not available offers nothing to forget.
  const forgetRun = (entry: EvidenceInspection) => {
    if (entry.state !== "available") return undefined;
    if (entry.kind === "preference") return forgetPreference;
    if (entry.kind === "source_bound") return forgetSourceBound;
    return forgetJudgment;
  };
  const forget = (entry: EvidenceInspection) => {
    const run = forgetRun(entry);
    if (run === undefined) return;
    setForgetError(null);
    run.mutate(entry.id, {
      onSuccess: (revocation) => {
        setStoppedAt(revocation.stoppedUsingAt);
        onForgotten?.(revocation.stoppedUsingAt);
      },
      onError: (thrown: Error) => setForgetError(thrown.message),
    });
  };
  return (
    <>
      <Dialog onOpenChange={(next) => !next && onClose()} open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("memory.evidence.title")}</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 overflow-y-auto">
            <div className="flex flex-col gap-4">
              {inspection.isPending ? null : inspection.error ? (
                <p role="alert" className="text-destructive text-sm">
                  {inspection.error.message}
                </p>
              ) : (
                inspection.data.map((entry) => (
                  <EvidenceEntry
                    entry={entry}
                    key={entry.id}
                    onCorrect={() => {
                      correct.reset();
                      setCorrected(false);
                      setCorrecting(entry);
                    }}
                    onForget={() => forget(entry)}
                    pending={
                      forgetPreference.isPending ||
                      forgetSourceBound.isPending ||
                      forgetJudgment.isPending
                    }
                  />
                ))
              )}
              {corrected ? (
                <p className="text-muted-foreground text-sm">
                  {t("memory.evidence.corrected")}
                </p>
              ) : null}
              {stoppedAt !== null ? (
                <p className="text-muted-foreground text-sm">
                  {t("memory.evidence.stopped", {
                    when: formatDateTime(stoppedAt),
                  })}
                </p>
              ) : null}
              {forgetError !== null ? (
                <p role="alert" className="text-destructive text-sm">
                  {forgetError}
                </p>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={onClose} size="sm" variant="outline">
              {t("memory.evidence.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {correcting !== null ? (
        <CorrectEvidenceDialog
          entry={correcting}
          error={correct.error?.message ?? null}
          onClose={() => setCorrecting(null)}
          onSave={(content) =>
            correct.mutate(
              { id: correcting.id, input: { content } },
              {
                onSuccess: () => {
                  setCorrecting(null);
                  setCorrected(true);
                },
              },
            )
          }
          saving={correct.isPending}
        />
      ) : null}
    </>
  );
}

/** One expanded basis entry: the fact, where it came from, its time, and what may act on it. */
function EvidenceEntry({
  entry,
  onCorrect,
  onForget,
  pending,
}: {
  entry: EvidenceInspection;
  onCorrect: () => void;
  onForget: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  if (entry.state === "unavailable") {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {t("memory.evidence.unavailable")}
        </p>
        <p className="text-muted-foreground text-sm">
          {t("memory.evidence.unavailableNote")}
        </p>
      </div>
    );
  }
  const times: string[] = [];
  if (entry.kind === "preference") {
    times.push(
      t("memory.evidence.confirmedAt", {
        when: formatDateTime(entry.markedGenericAt),
      }),
    );
    if (entry.supersededTimeUnknown) {
      times.push(t("memory.evidence.endedUnknown"));
    } else if (entry.effectiveFrom !== null && entry.effectiveUntil !== null) {
      times.push(
        t("memory.evidence.valid", {
          from: formatDateTime(entry.effectiveFrom),
          until: formatDateTime(entry.effectiveUntil),
        }),
      );
    } else if (entry.effectiveUntil !== null) {
      times.push(
        t("memory.evidence.validUntil", {
          when: formatDateTime(entry.effectiveUntil),
        }),
      );
    } else if (entry.effectiveFrom !== null) {
      times.push(
        t("memory.evidence.validFrom", {
          when: formatDateTime(entry.effectiveFrom),
        }),
      );
    } else {
      times.push(t("memory.evidence.current"));
    }
  } else if (entry.kind === "source_bound") {
    times.push(
      t("memory.evidence.readAt", { when: formatDateTime(entry.formedAt) }),
    );
  } else {
    times.push(
      t("memory.evidence.confirmedAt", {
        when: formatDateTime(entry.reviewedAt),
      }),
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="whitespace-pre-wrap text-sm">{entry.content}</p>
      <p className="text-muted-foreground text-sm">
        {t("memory.evidence.from", { source: entry.provenance })}
        {times.map((time) => ` · ${time}`)}
      </p>
      {entry.kind === "derived_judgment" && entry.evidence.length > 0 ? (
        /* One level deep: the chain continues by expanding THAT judgment, never all at once. */
        <ul className="flex flex-col gap-1">
          {entry.evidence.map((basis) => (
            <li className="text-muted-foreground text-sm" key={basis.id}>
              {basis.content}
              {" · "}
              {t("memory.evidence.from", { source: basis.provenance })}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-1 flex flex-wrap gap-2">
        {entry.kind === "preference" && entry.actions.includes("correct") ? (
          <Button onClick={onCorrect} size="sm" variant="outline">
            {t("memory.evidence.correct")}
          </Button>
        ) : null}
        {entry.actions.includes("forget") ? (
          <Button
            disabled={pending}
            onClick={onForget}
            size="sm"
            variant="outline"
          >
            {t("memory.evidence.forget")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A preference basis's correction (#387 AC2): the fact as it is now supersedes the old window. */
function CorrectEvidenceDialog({
  entry,
  saving,
  error,
  onSave,
  onClose,
}: {
  entry: EvidenceInspection;
  saving: boolean;
  error: string | null;
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  const initial = entry.state === "available" ? entry.content : "";
  const [content, setContent] = useState(initial);
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("memory.evidence.correctTitle")}</DialogTitle>
          <DialogDescription>
            {t("memory.evidence.correctBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Field>
            <FieldLabel className="sr-only" htmlFor="evidence-correction">
              {t("memory.evidence.contentLabel")}
            </FieldLabel>
            <Textarea
              autoFocus
              id="evidence-correction"
              maxLength={6000}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              value={content}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            {t("memory.evidence.cancel")}
          </Button>
          <Button
            disabled={saving || !content.trim()}
            onClick={() => onSave(content)}
            size="sm"
          >
            {t("memory.evidence.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
