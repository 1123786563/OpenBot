import { IconArchive, IconClock, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { verifyCleanupMutationOptions } from "@/lib/hindsight/mutations";
import {
  type CleanupStatus,
  scopedCleanupStatusQueryOptions,
} from "@/lib/hindsight/queries";
import { useDateTime } from "@/lib/i18n/datetime";

/**
 * The cleanup progress of what the person forgot (#390 AC3 / #391 AC3): the three legs the
 * claim would stand on, each with its own observed answer, and the "All controlled copies are
 * cleared" sentence ONLY while every leg holds actual evidence. A leg without evidence says so
 * — a missing backup registry is no evidence, not a shortcut to cleared — and the external
 * model logs are named separately in every state, because they were never this deployment's
 * copies to clear.
 *
 * "Check now" is the explicit action behind the picture: re-probe the person's own confirmed
 * deletions and reconcile the backup manifests. The settle re-reads the status, so the legs
 * update to what the probe actually observed.
 */
export function MemoryCleanupSection() {
  const { t } = useTranslation("agents");
  // The picture rides the scope the screen holds, like every other memory call (MT089).
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const cleanup = useQuery(scopedCleanupStatusQueryOptions(queryClient, scope));
  const verify = useMutation(verifyCleanupMutationOptions(queryClient, scope));
  return (
    <PageSection
      action={
        <Button
          disabled={
            verify.isPending || cleanup.isPending || cleanup.data === null
          }
          onClick={() => verify.mutate(undefined)}
          size="sm"
          variant="ghost"
        >
          {verify.isPending
            ? t("memory.cleanup.checking")
            : t("memory.cleanup.check")}
        </Button>
      }
      description={t("memory.cleanup.description")}
      title={t("memory.cleanup.title")}
    >
      {cleanup.isPending ? null : cleanup.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {cleanup.error.message}
        </p>
      ) : cleanup.data === null ? (
        <PageEmpty>{t("memory.unmounted")}</PageEmpty>
      ) : (
        <>
          {/* The claim is a fact the server already decided; the screen states it or stays silent. */}
          {cleanup.data.controlledCopiesCleared ? (
            <p className="mt-4 text-sm">{t("memory.cleanup.claim")}</p>
          ) : (
            <p className="mt-4 text-muted-foreground text-sm">
              {t("memory.cleanup.notCleared")}
            </p>
          )}
          <PageRows>
            <ActiveDataRow status={cleanup.data} />
            <Separator />
            <PayloadsRow status={cleanup.data} />
            <Separator />
            <BackupsRow status={cleanup.data} />
          </PageRows>
          <p className="mt-4 text-muted-foreground text-sm">
            {t("memory.cleanup.external")}
          </p>
          {verify.error ? (
            <p role="alert" className="mt-4 text-destructive text-sm">
              {verify.error.message}
            </p>
          ) : null}
        </>
      )}
    </PageSection>
  );
}

/** One read-only leg row: what it holds, what it doesn't, and nothing inferred between. */
function LegRow({
  icon,
  title,
  value,
  children,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {children}
      </ItemContent>
      {/* Read-only: the state in the row's own words, no chevron promising a destination. */}
      <ItemActions>
        <span className="text-muted-foreground text-sm">{value}</span>
      </ItemActions>
    </Item>
  );
}

/**
 * The active-data leg: the person's own forgotten records, deleted and verified absent. A
 * person with nothing forgotten makes no claim, and an open backup-restore gate holds every
 * verdict until its replay lands.
 */
function ActiveDataRow({ status }: { status: CleanupStatus }) {
  const { t } = useTranslation("agents");
  const { activeData } = status;
  const inProgress =
    activeData.outstanding + activeData.unverified + activeData.resurrected;
  let value: string;
  if (activeData.documents === 0) value = t("memory.cleanup.nothingValue");
  else if (activeData.blockedByOpenRestore) value = t("memory.cleanup.onHold");
  else if (activeData.cleared) value = t("memory.cleanup.clearedValue");
  else value = t("memory.cleanup.pendingValue", { n: inProgress });
  let note: string;
  if (activeData.documents === 0) note = t("memory.cleanup.activeNothing");
  else if (activeData.blockedByOpenRestore)
    note = t("memory.cleanup.onHoldNote");
  else if (activeData.cleared) note = t("memory.cleanup.activeCleared");
  else
    note = t("memory.cleanup.activePending", {
      n: inProgress,
      total: activeData.documents,
    });
  return (
    <LegRow
      icon={<IconTrash />}
      title={t("memory.cleanup.active")}
      value={value}
    >
      <ObservedNote at={activeData.observedAt} />
      <ItemDescription className="line-clamp-none">{note}</ItemDescription>
    </LegRow>
  );
}

/** When the observation the active-data verdict stands on was recorded, if ever. */
function ObservedNote({ at }: { at: string | null }) {
  const { t } = useTranslation("agents");
  const { formatDateTime } = useDateTime();
  return (
    <ItemDescription className="line-clamp-none">
      {at === null
        ? t("memory.cleanup.notCheckedYet")
        : t("memory.cleanup.activeChecked", { when: formatDateTime(at) })}
    </ItemDescription>
  );
}

/**
 * The finished-payload leg: terminal operations measured against the DECLARED retention
 * window. An undeclared window is not evidence, and a check that could not run says so with
 * the reason it recorded.
 */
function PayloadsRow({ status }: { status: CleanupStatus }) {
  const { t } = useTranslation("agents");
  const payloads = status.finishedTaskPayloads;
  let value: string;
  if (!payloads.checked) value = t("memory.cleanup.uncheckedValue");
  else if (payloads.cleared) value = t("memory.cleanup.clearedValue");
  // FIX-OCR2 (O2-M8): an undeclared retention window is not evidence, so the value column
  // must say so too — it used to fall through to "0 to clear" while the note beside it said
  // there was nothing to measure against, and a glance at the column alone read "cleared".
  else if (payloads.retentionDays === null)
    value = t("memory.cleanup.noEvidenceValue");
  else
    value = t("memory.cleanup.pendingValue", { n: payloads.beyondWindow ?? 0 });
  let note: string;
  if (!payloads.checked)
    note = payloads.reason ?? t("memory.cleanup.payloadsUnchecked");
  else if (payloads.cleared) note = t("memory.cleanup.payloadsCleared");
  else if (payloads.retentionDays === null)
    note = t("memory.cleanup.payloadsNoWindow");
  else
    note = t("memory.cleanup.payloadsPending", {
      n: payloads.beyondWindow ?? 0,
    });
  return (
    <LegRow
      icon={<IconClock />}
      title={t("memory.cleanup.payloads")}
      value={value}
    >
      <ItemDescription className="line-clamp-none">{note}</ItemDescription>
    </LegRow>
  );
}

/**
 * The controlled-backup leg: copies the backup job registered, with their purge evidence. An
 * empty registry beside confirmed deletions is NO evidence, never a cleared shortcut.
 */
function BackupsRow({ status }: { status: CleanupStatus }) {
  const { t } = useTranslation("agents");
  const backups = status.controlledBackups;
  let value: string;
  if (backups.cleared) value = t("memory.cleanup.clearedValue");
  else if (backups.outstanding === null)
    value = t("memory.cleanup.noEvidenceValue");
  else value = t("memory.cleanup.pendingValue", { n: backups.outstanding });
  let note: string;
  if (backups.cleared) note = t("memory.cleanup.backupsCleared");
  else if (backups.outstanding === null) note = t("memory.cleanup.backupsNone");
  else
    note = t("memory.cleanup.backupsPending", {
      n: backups.outstanding,
    });
  return (
    <LegRow
      icon={<IconArchive />}
      title={t("memory.cleanup.backups")}
      value={value}
    >
      <ItemDescription className="line-clamp-none">{note}</ItemDescription>
    </LegRow>
  );
}
