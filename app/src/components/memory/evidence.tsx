import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  type EvidenceInspection,
  scopedEvidenceInspectionQueryOptions,
} from "@/lib/hindsight/queries";
import { useDateTime } from "@/lib/i18n/datetime";

/**
 * The basis behind an answer citation, expanded (#387 AC1): every id the caller cited,
 * re-decided NOW by the evidence seam. An entry the person can no longer see draws
 * "Unavailable" and nothing else — no content, no source, no date — because the seam refuses to
 * distinguish a revoked basis from one that never existed, and the screen does not invent the
 * difference.
 *
 * #732: read-only. Correcting and forgetting an entry were the old engine's write faces and
 * left with it; the memory service owns those actions now.
 */
export function EvidenceDialog({
  ids,
  title,
  onClose,
}: {
  ids: string[];
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("agents");
  // The expansion rides the scope the screen holds, like every other memory call (MT089).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const inspection = useQuery(
    scopedEvidenceInspectionQueryOptions(queryClient, scope, ids),
  );
  return (
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
                <EvidenceEntry entry={entry} key={entry.id} />
              ))
            )}
          </div>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            {t("memory.evidence.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One expanded basis entry: the fact, where it came from and its time. */
function EvidenceEntry({ entry }: { entry: EvidenceInspection }) {
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
    </div>
  );
}
