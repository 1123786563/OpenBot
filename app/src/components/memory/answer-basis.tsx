import { IconQuote } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import type { AnswerMemoryBasisPointer } from "@/lib/hindsight/answer-basis";
import {
  type EvidenceRestriction,
  type PersonalMemoryEntry,
  scopedPersonalMemoriesQueryOptions,
} from "@/lib/hindsight/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import { EvidenceDialog } from "./evidence";

/**
 * The answer-basis surface (FIX-W12 FR2-3, #387 AC1; FIX-W14 FR3-1): the person's own Hindsight
 * memory entries — the confirmed preferences and source-bound facts a Bot's answers read — each
 * with the one action that closes scenario 1's loop: expand its basis NOW, and from the
 * expansion correct it or forget it. The listing arrives re-verified against current
 * authorization, so an entry that lost its authorization is simply not here until the authority
 * returns, and every row that IS here expands to what the next answer may still use.
 *
 * FIX-W14 adds the OTHER mount: passed `basis` (the id set an answer actually carried), the same
 * section draws that answer's own basis line under it on the chat face instead of the living
 * listing (see `AnswerBasisControl`). One component, two questions: "what may the next answer
 * use" on Settings, "what did THIS answer use" under the answer itself.
 */
export function MemoryAnswerBasisSection({
  basis,
}: {
  /**
   * The answer's own pointer set (FIX-W14, FR3-1 of #387), present on the chat answer face.
   * Server-composed from the block injected into that run's prompt and carried on the answer's
   * AG-UI metadata; the expansion re-checks current authorization per id, so a basis that has
   * since been forgotten or lost its authorization answers unavailable, never content.
   */
  basis?: readonly AnswerMemoryBasisPointer[];
} = {}) {
  // Before any hook, so each mount below keeps its own unconditional hook order: the chat face
  // asks about one answer, the settings face lists what may still be used.
  if (basis !== undefined) return <AnswerBasisControl basis={basis} />;
  return <MemoryAnswerBasisListing />;
}

/**
 * The chat answer face's basis (FIX-W14, #387 AC1): the memories THIS answer used, and the one
 * control that expands them through the evidence seam. What expands is the answer's own id set,
 * never the living listing — the person can tell exactly which entries the answer drew on, and
 * correct or forget one from there; the next answer carries the corrected set.
 */
function AnswerBasisControl({
  basis,
}: {
  basis: readonly AnswerMemoryBasisPointer[];
}) {
  const { t } = useTranslation("agents");
  const [showingBasis, setShowingBasis] = useState(false);
  // No id, no row: an answer with no memory behind it shows no basis rather than an empty one.
  if (basis.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground text-xs">
        {t("memory.answerBasis.answerUsed")}
      </span>
      <Button onClick={() => setShowingBasis(true)} size="sm" variant="outline">
        {t("memory.answerBasis.show")}
      </Button>
      {showingBasis ? (
        <EvidenceDialog
          ids={basis.map((entry) => entry.id)}
          title={t("memory.answerBasis.answerUsed")}
          onClose={() => setShowingBasis(false)}
        />
      ) : null}
    </div>
  );
}

/** Settings → Memory: the living entries a next answer may use, newest change first. */
function MemoryAnswerBasisListing() {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  // The listing rides the scope the screen holds, like every other memory call (MT089).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const memories = useQuery(
    scopedPersonalMemoriesQueryOptions(queryClient, scope),
  );
  /** The instant the last forget took effect — kept here, where the row itself may vanish. */
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);
  return (
    <PageSection
      description={t("memory.answerBasis.description")}
      title={t("memory.answerBasis.title")}
    >
      {memories.isPending ? null : memories.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {memories.error.message}
        </p>
      ) : memories.data === null ? (
        <PageEmpty>{t("memory.unmounted")}</PageEmpty>
      ) : memories.data.length ? (
        <PageRows>
          {memories.data.map((entry, index) => (
            <Fragment key={entry.id}>
              {index > 0 ? <Separator /> : null}
              <MemoryEntryRow
                entry={entry}
                onForgotten={(at) => setStoppedAt(at)}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty>{t("memory.answerBasis.empty")}</PageEmpty>
      )}
      {/* Outside the length branch on purpose: the forgotten entry leaves the list, the
          honest "stopped" sentence stays. */}
      {stoppedAt !== null ? (
        <p className="mt-4 text-muted-foreground text-sm">
          {t("memory.evidence.stopped", { when: formatDateTime(stoppedAt) })}
        </p>
      ) : null}
    </PageSection>
  );
}

/** One memory entry: the fact, where it came from, and the basis expansion beneath it. */
function MemoryEntryRow({
  entry,
  onForgotten,
}: {
  entry: PersonalMemoryEntry;
  onForgotten: (stoppedAt: string) => void;
}) {
  const { t } = useTranslation("agents");
  const restrictionLabel = useRestrictionLabel();
  const { formatDateTime } = useDateTime();
  const [showingBasis, setShowingBasis] = useState(false);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconQuote />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none whitespace-pre-wrap">
          {entry.content}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {entry.provenance}
          {" · "}
          {entry.kind === "preference"
            ? t("memory.evidence.confirmedAt", {
                when: formatDateTime(entry.markedGenericAt),
              })
            : t("memory.evidence.readAt", {
                when: formatDateTime(entry.formedAt),
              })}
          {entry.kind === "source_bound"
            ? ` · ${restrictionLabel(entry.restriction)}`
            : ""}
        </ItemDescription>
        <ItemFooter>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => setShowingBasis(true)}
              size="sm"
              variant="outline"
            >
              {t("memory.answerBasis.basis")}
            </Button>
          </div>
        </ItemFooter>
      </ItemContent>
      {showingBasis ? (
        <EvidenceDialog
          ids={[entry.id]}
          title={entry.content}
          onClose={() => setShowingBasis(false)}
          onForgotten={onForgotten}
        />
      ) : null}
    </Item>
  );
}

/**
 * The restriction's plain name — the one fact the person needs, from the same words the
 * judgment scopes use. A hook so each call site keeps its literal key.
 */
function useRestrictionLabel() {
  const { t } = useTranslation("agents");
  return (restriction: EvidenceRestriction): string => {
    switch (restriction.kind) {
      case "team":
        return t("memory.judgments.scope.team");
      case "source":
        return t("memory.judgments.scope.source");
      default:
        return t("memory.judgments.scope.bot");
    }
  };
}
