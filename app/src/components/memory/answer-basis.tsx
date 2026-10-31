import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { AnswerMemoryBasisPointer } from "@/lib/hindsight/answer-basis";
import { EvidenceDialog } from "./evidence";

/**
 * The answer-basis surface (#387 AC1; FIX-W14 FR3-1): the id set an answer actually carried,
 * drawn under the answer on the chat face. The expansion re-checks current authorization per
 * id, so a basis that has since been forgotten or lost its authorization answers unavailable,
 * never content.
 *
 * #732: the Settings listing ("what may the next answer use") was the old engine's read and
 * left with it; the memory service owns that view now.
 */
export function MemoryAnswerBasisSection({
  basis,
}: {
  /**
   * The answer's own pointer set, present on the chat answer face. Server-composed from the
   * block injected into that run's prompt and carried on the answer's AG-UI metadata.
   */
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
