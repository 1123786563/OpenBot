import { IconCircleCheck, IconScale } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  type ScopedCache,
  useScopedCache,
} from "@/lib/enterprise/tenant/scoped-cache";
import {
  confirmJudgmentMutationOptions,
  editJudgmentMutationOptions,
  forgetJudgmentMutationOptions,
  rejectJudgmentMutationOptions,
} from "@/lib/hindsight/mutations";
import {
  type JudgmentCandidate,
  type JudgmentScope,
  type ReviewedJudgment,
  scopedAdoptedJudgmentsQueryOptions,
  scopedJudgmentCandidatesQueryOptions,
} from "@/lib/hindsight/queries";
import {
  sensitiveConfirmationRefused,
  sensitiveRefusalNote,
} from "@/lib/hindsight/sensitive-refusal";
import { useDateTime } from "@/lib/i18n/datetime";
import { EvidenceDialog } from "./evidence";

/**
 * The judgment review surface (#389 AC2): every candidate with its complete basis — content,
 * source and time — and the person's three decisions on it. Confirming adopts it, editing
 * re-asserts the words alone (the basis and its authority never move through the edit), and
 * rejecting closes it.
 *
 * The adopted half is the SERVER's own listing (FIX-W12 FR2-3): what the person confirmed or
 * edited, re-read on every visit, so a reload or a fresh session still shows the judgments
 * they stand behind — with the same edit, basis and forget actions the candidates have. The
 * listing re-verifies current authorization row by row, so a judgment whose basis died is
 * simply not in it until the authority returns.
 */
export function JudgmentReviewSections() {
  const { t } = useTranslation("agents");
  // Both halves ride the scope the screen holds, like every other memory call (MT089).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const candidates = useQuery(
    scopedJudgmentCandidatesQueryOptions(queryClient, scope),
  );
  const adopted = useQuery(
    scopedAdoptedJudgmentsQueryOptions(queryClient, scope),
  );
  /** The instant the last judgment forget took effect, for the honest "stopped" sentence. */
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  return (
    <>
      <PageSection
        description={t("memory.judgments.description")}
        title={t("memory.judgments.title")}
      >
        {candidates.isPending ? null : candidates.error ? (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {candidates.error.message}
          </p>
        ) : candidates.data.length ? (
          <PageRows>
            {candidates.data.map((candidate, index) => (
              <Fragment key={candidate.id}>
                {index > 0 ? <Separator /> : null}
                <CandidateRow candidate={candidate} scope={scope} />
              </Fragment>
            ))}
          </PageRows>
        ) : (
          <PageEmpty>{t("memory.judgments.empty")}</PageEmpty>
        )}
      </PageSection>
      <PageSection
        description={t("memory.judgments.adoptedDescription")}
        title={t("memory.judgments.adoptedTitle")}
      >
        {adopted.isPending ? null : adopted.error ? (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {adopted.error.message}
          </p>
        ) : adopted.data.length ? (
          <PageRows>
            {adopted.data.map((judgment, index) => (
              <Fragment key={judgment.id}>
                {index > 0 ? <Separator /> : null}
                <AdoptedRow
                  judgment={judgment}
                  scope={scope}
                  onForgotten={(at) => setStoppedAt(at)}
                />
              </Fragment>
            ))}
          </PageRows>
        ) : (
          <PageEmpty>{t("memory.judgments.adoptedEmpty")}</PageEmpty>
        )}
        {/* Outside the length branch on purpose (FR2-5): forgetting the LAST judgment still
            leaves the honest "stopped" sentence on the page, beside the empty state. */}
        {stoppedAt !== null ? <StoppedNote at={stoppedAt} /> : null}
      </PageSection>
    </>
  );
}

/** One candidate: the claim, where it came from, and Confirm / Edit / Reject beneath it. */
function CandidateRow({
  candidate,
  scope,
}: {
  candidate: JudgmentCandidate;
  scope: ScopedCache;
}) {
  const { t } = useTranslation("agents");
  const { t: tErrors } = useTranslation("errors");
  const { formatDateTime } = useDateTime();
  const scopeLabel = useScopeLabel();
  const queryClient = useQueryClient();
  const confirm = useMutation(
    confirmJudgmentMutationOptions(queryClient, scope),
  );
  const edit = useMutation(editJudgmentMutationOptions(queryClient, scope));
  const reject = useMutation(rejectJudgmentMutationOptions(queryClient, scope));
  const [editing, setEditing] = useState(false);
  const [showingBasis, setShowingBasis] = useState(false);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconScale />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {candidate.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {candidate.provenance}
          {" · "}
          {t("memory.judgments.proposed", {
            when: formatDateTime(candidate.proposedAt),
          })}
          {" · "}
          {scopeLabel(candidate.scope)}
        </ItemDescription>
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setShowingBasis(true)}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.showBasis", {
                n: candidate.evidence.length,
              })}
            </Button>
            <Button
              disabled={confirm.isPending}
              onClick={() => confirm.mutate({ id: candidate.id })}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.confirm")}
            </Button>
            <Button
              onClick={() => {
                edit.reset();
                setEditing(true);
              }}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.edit")}
            </Button>
            <Button
              disabled={reject.isPending}
              onClick={() => reject.mutate(candidate.id)}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.reject")}
            </Button>
          </div>
        </ItemFooter>
        {!editing && (confirm.error || edit.error || reject.error) && (
          <p role="alert" className="text-destructive text-sm">
            {sensitiveRefusalNote(
              confirm.error ?? edit.error ?? reject.error,
              tErrors,
            ) ??
              confirm.error?.message ??
              edit.error?.message ??
              reject.error?.message}
          </p>
        )}
        {!editing && sensitiveConfirmationRefused(confirm.error) && (
          /*
           * O3-M4: the gate's second look. The refusal above said sensitive material needs
           * the person's own second confirmation; this button IS that confirmation, and the
           * retry carries it — the confirm is no longer a dead end for medical, financial
           * or customer text.
           */
          <Button
            className="mt-2"
            disabled={confirm.isPending}
            onClick={() =>
              confirm.mutate({
                id: candidate.id,
                confirmSensitive: true,
              })
            }
            size="sm"
            variant="outline"
          >
            {t("memory.judgments.confirmSensitive")}
          </Button>
        )}
      </ItemContent>
      {editing ? (
        <EditJudgmentDialog
          content={candidate.content}
          error={edit.error?.message ?? null}
          onClose={() => setEditing(false)}
          onSave={(content) =>
            edit.mutate(
              { id: candidate.id, input: { content } },
              {
                onSuccess: () => setEditing(false),
              },
            )
          }
          saving={edit.isPending}
          title={candidate.provenance}
        />
      ) : null}
      {showingBasis ? (
        <EvidenceDialog
          ids={candidate.evidence.map((basis) => basis.id)}
          title={candidate.content}
          onClose={() => setShowingBasis(false)}
        />
      ) : null}
    </Item>
  );
}

/** One adopted judgment: manage its words, or forget it entirely. */
function AdoptedRow({
  judgment,
  scope,
  onForgotten,
}: {
  judgment: ReviewedJudgment;
  scope: ScopedCache;
  onForgotten: (stoppedAt: string) => void;
}) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  const scopeLabel = useScopeLabel();
  const queryClient = useQueryClient();
  const edit = useMutation(editJudgmentMutationOptions(queryClient, scope));
  const forget = useMutation(forgetJudgmentMutationOptions(queryClient, scope));
  const [editing, setEditing] = useState(false);
  const [showingBasis, setShowingBasis] = useState(false);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconCircleCheck />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {judgment.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {judgment.provenance}
          {" · "}
          {t(
            judgment.reviewState === "edited"
              ? "memory.judgments.adopted.edited"
              : "memory.judgments.adopted.confirmed",
            { when: formatDateTime(judgment.reviewedAt) },
          )}
          {" · "}
          {scopeLabel(judgment.scope)}
        </ItemDescription>
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setShowingBasis(true)}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.showBasis", {
                n: judgment.evidence.length,
              })}
            </Button>
            <Button
              onClick={() => {
                edit.reset();
                setEditing(true);
              }}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.edit")}
            </Button>
            <Button
              disabled={forget.isPending}
              onClick={() =>
                forget.mutate(judgment.id, {
                  onSuccess: (revocation) =>
                    onForgotten(revocation.stoppedUsingAt),
                })
              }
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.forget")}
            </Button>
          </div>
        </ItemFooter>
        {!editing && (edit.error || forget.error) && (
          <p role="alert" className="text-destructive text-sm">
            {edit.error?.message || forget.error?.message}
          </p>
        )}
      </ItemContent>
      {editing ? (
        <EditJudgmentDialog
          content={judgment.content}
          error={edit.error?.message ?? null}
          onClose={() => setEditing(false)}
          onSave={(content) =>
            edit.mutate(
              { id: judgment.id, input: { content } },
              {
                onSuccess: () => setEditing(false),
              },
            )
          }
          saving={edit.isPending}
          title={judgment.provenance}
        />
      ) : null}
      {showingBasis ? (
        <EvidenceDialog
          ids={judgment.evidence.map((basis) => basis.id)}
          title={judgment.content}
          onClose={() => setShowingBasis(false)}
        />
      ) : null}
    </Item>
  );
}

/** The honest forget note (#390 AC3): stopped now, remote copies never claimed cleared. */
function StoppedNote({ at }: { at: string }) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  return (
    <p className="mt-4 text-muted-foreground text-sm">
      {t("memory.evidence.stopped", { when: formatDateTime(at) })}
    </p>
  );
}

/** A judgment's words in a dialog. Saving rewrites the words; the basis never moves through it. */
function EditJudgmentDialog({
  content: initial,
  title,
  saving,
  error,
  onSave,
  onClose,
}: {
  content: string;
  title: string;
  saving: boolean;
  error: string | null;
  onSave: (content: string, confirmSensitive?: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  const { t: tErrors } = useTranslation("errors");
  const [content, setContent] = useState(initial);
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("memory.judgments.editTitle")}</DialogTitle>
          <DialogDescription>
            {t("memory.judgments.editBody")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <Field>
            <FieldLabel className="sr-only" htmlFor="judgment-edit">
              {t("memory.judgments.contentLabel")}
            </FieldLabel>
            <Textarea
              autoFocus
              id="judgment-edit"
              maxLength={6000}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              value={content}
            />
          </Field>
          <p className="text-muted-foreground text-sm">{title}</p>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {sensitiveRefusalNote(error, tErrors) ?? error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          {error !== null && sensitiveConfirmationRefused(new Error(error)) && (
            // O3-M4: the gate's second look, inside the edit it refused.
            <Button
              disabled={saving || !content.trim()}
              onClick={() => onSave(content, true)}
              size="sm"
              variant="outline"
            >
              {t("memory.judgments.confirmSensitive")}
            </Button>
          )}
          <Button onClick={onClose} size="sm" variant="outline">
            {t("memory.judgments.cancel")}
          </Button>
          <Button
            disabled={saving || !content.trim()}
            onClick={() => onSave(content)}
            size="sm"
          >
            {t("memory.judgments.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The scope's plain name — the one fact the person needs, never the id it rides on. A hook so
 * each call site keeps its literal key and the typed bundle checks every one of them.
 */
function useScopeLabel() {
  const { t } = useTranslation("agents");
  return (scope: JudgmentScope): string => {
    switch (scope.kind) {
      case "general":
        return t("memory.judgments.scope.general");
      case "team":
        return t("memory.judgments.scope.team");
      case "source":
        return t("memory.judgments.scope.source");
      default:
        return t("memory.judgments.scope.bot");
    }
  };
}
