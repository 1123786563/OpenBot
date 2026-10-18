import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { client } from "@/lib/client";

/**
 * The administrator's view of the authorized legacy-billing cleanup (Bifrost 21.7).
 *
 * THIS PAGE READS, IT NEVER EXECUTES. The cleanup's execution door is an operator script on
 * the server (`server/src/billing/cleanup-execution.ts`), gated on a fresh dry-run plus an
 * explicit authorization record — there is no button here and must never grow one: a
 * destructive mass deletion one accidental click away is the failure the three-factor gate
 * exists to make impossible. What an administrator needs from this screen is the answer to
 * "what did that authorized run actually do, and did the verification agree": the deleted /
 * retained / quarantined counts, how a deleted row can be recovered, and whether the
 * post-execution accounting checks passed — all read back from the audit trail, which is the
 * one durable record (the deletion receipt is written in the same transaction as the
 * deletions themselves).
 */

/** The read route's answer, as the server builds it (21.7's produced contract). */
type CleanupExecutionView = {
  executionId: string;
  executedAt: string;
  authorizedBy: string;
  verificationPending: boolean;
  report: {
    binding?: { scopeHash?: string };
    deleted?: {
      totalRows: number;
      byTable: { table: string; rows: number; recordIds: string[] }[];
    };
    retained?: { totalRows: number };
    quarantine?: { totalRows: number };
    recovery?: { method: string; capturedRows: number };
    postVerification?: {
      passed: boolean;
      deletedAbsent: boolean;
      retainedUnchanged: boolean;
      protectedSurface: { tables: string[]; unchanged: boolean };
    };
    accountingSmoke?: {
      passed: boolean;
      companyFootprintUnchanged: boolean;
      personalFootprintUnchanged: boolean;
      grantReserveSettlePassed: boolean;
    };
  };
};

/** One labelled fact, so the report reads as a sheet rather than a sentence. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-medium break-all">{value}</span>
    </div>
  );
}

export function BillingCleanupExecutionCard() {
  const { t } = useTranslation("admin");
  const execution = useQuery({
    queryKey: ["billing", "cleanup-execution"],
    queryFn: () =>
      client("/api/admin/billing/cleanup/execution", {
        fallbackKey: "billing.cleanupExecution",
      }).then(
        (response) =>
          response.json() as Promise<{
            execution: CleanupExecutionView | null;
          }>,
      ),
  });

  if (execution.isPending) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("billingCleanup.loading")}
      </p>
    );
  }
  if (execution.isError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t("billingCleanup.loadProblem")}
      </p>
    );
  }
  const view = execution.data.execution;
  if (!view) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-testid="cleanup-execution-empty"
      >
        {t("billingCleanup.empty")}
      </p>
    );
  }
  const { report } = view;
  return (
    <div
      className="flex max-w-2xl flex-col gap-4 text-sm"
      data-testid="cleanup-execution-report"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            view.verificationPending
              ? "bg-amber-100 text-amber-900 rounded px-2 py-0.5 text-xs font-medium"
              : "bg-emerald-100 text-emerald-900 rounded px-2 py-0.5 text-xs font-medium"
          }
        >
          {view.verificationPending
            ? t("billingCleanup.pendingVerification")
            : t("billingCleanup.verified")}
        </span>
        <span className="text-muted-foreground text-xs">
          {t("billingCleanup.executedAt", { time: view.executedAt })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Fact
          label={t("billingCleanup.deleted")}
          value={String(report.deleted?.totalRows ?? 0)}
        />
        <Fact
          label={t("billingCleanup.retained")}
          value={String(report.retained?.totalRows ?? 0)}
        />
        <Fact
          label={t("billingCleanup.quarantined")}
          value={String(report.quarantine?.totalRows ?? 0)}
        />
        <Fact
          label={t("billingCleanup.recoverableRows")}
          value={String(report.recovery?.capturedRows ?? 0)}
        />
      </div>
      {report.deleted && report.deleted.byTable.length > 0 ? (
        <div>
          <p className="text-muted-foreground text-xs">
            {t("billingCleanup.byTable")}
          </p>
          <ul className="mt-1 space-y-0.5">
            {report.deleted.byTable.map((entry) => (
              <li key={entry.table} className="break-all">
                {entry.table}: {entry.rows}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Fact
          label={t("billingCleanup.authorizedBy")}
          value={view.authorizedBy}
        />
        <Fact
          label={t("billingCleanup.scopeHash")}
          value={(report.binding?.scopeHash ?? "").slice(0, 16) || "—"}
        />
      </div>
      {report.postVerification ? (
        <div>
          <p className="text-xs font-medium">
            {t("billingCleanup.verificationTitle")}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              {t("billingCleanup.deletedAbsent")}:{" "}
              {report.postVerification.deletedAbsent
                ? t("billingCleanup.pass")
                : t("billingCleanup.fail")}
            </li>
            <li>
              {t("billingCleanup.retainedUnchanged")}:{" "}
              {report.postVerification.retainedUnchanged
                ? t("billingCleanup.pass")
                : t("billingCleanup.fail")}
            </li>
            <li>
              {t("billingCleanup.protectedUnchanged")} (
              {report.postVerification.protectedSurface.tables.join(", ")}):{" "}
              {report.postVerification.protectedSurface.unchanged
                ? t("billingCleanup.pass")
                : t("billingCleanup.fail")}
            </li>
          </ul>
        </div>
      ) : (
        <p className="text-muted-foreground">
          {t("billingCleanup.verificationMissing")}
        </p>
      )}
      {report.accountingSmoke ? (
        <div>
          <p className="text-xs font-medium">
            {t("billingCleanup.accountingTitle")}
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            <li>
              {t("billingCleanup.companyFootprint")}:{" "}
              {report.accountingSmoke.companyFootprintUnchanged
                ? t("billingCleanup.pass")
                : t("billingCleanup.fail")}
            </li>
            <li>
              {t("billingCleanup.personalFootprint")}:{" "}
              {report.accountingSmoke.personalFootprintUnchanged
                ? t("billingCleanup.pass")
                : t("billingCleanup.fail")}
            </li>
            <li>
              {t("billingCleanup.grantReserveSettle")}:{" "}
              {report.accountingSmoke.grantReserveSettlePassed
                ? t("billingCleanup.pass")
                : t("billingCleanup.fail")}
            </li>
          </ul>
        </div>
      ) : null}
      {report.recovery ? (
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("billingCleanup.recoveryLabel")}: {report.recovery.method}
        </p>
      ) : null}
    </div>
  );
}
