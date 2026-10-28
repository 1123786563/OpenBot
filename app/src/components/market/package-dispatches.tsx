import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { WbTag } from "@/components/market/wb";
import { usePackageDispatchVerify } from "@/lib/plugin-packages/mutations";
import {
  type PluginPackageScope,
  pluginPackageDispatchesQueryOptions,
  pluginPackageDispatchInspectionQueryOptions,
} from "@/lib/plugin-packages/queries";
import type {
  PackageDispatchState,
  PackageInstallDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The dispatch ledger of the install detail, PKG10 (#469).
 *
 * WHAT A PERSON SEES HERE. Every tool call a Bot made through this package,
 * with the calls whose effect is unknown first. An unknown call says exactly
 * that: what was sent, on which account, and why OpenBot won't send it again.
 * Settled calls show their receipt facts. Nothing here invents a completion.
 *
 * WHAT IS DELIBERATELY ABSENT. A retry button, in any form. An unknown call is
 * never resent; the only action offered is "check with the app", and only when
 * the inspection says a verified vendor query protocol exists (canQueryVendor).
 * Progress a person can already see elsewhere stays there: conversations, runs
 * and receipts keep being the record; this section only adds the ledger facts.
 */

const STATE_KEY = {
  prepared: "packages.dispatches.statePrepared",
  dispatched: "packages.dispatches.stateDispatched",
  succeeded: "packages.dispatches.stateSucceeded",
  failed: "packages.dispatches.stateFailed",
  unknown: "packages.dispatches.stateUnknown",
  cancelled: "packages.dispatches.stateCancelled",
} as const;

const STATE_TONE: Record<PackageDispatchState, string> = {
  prepared: "text-foreground/60",
  dispatched: "text-foreground/60",
  succeeded: "text-emerald-600",
  failed: "text-foreground/70",
  unknown: "text-amber-600",
  cancelled: "text-foreground/50",
};

/*
 * The wire states are closed, but a newer server or a trimmed test fixture can
 * still hand us an unseen value: it must read as a sentence. The fallback is
 * the unknown-effect label — the honest one for a row we cannot classify.
 */
type DispatchStateKey =
  | (typeof STATE_KEY)[PackageDispatchState]
  | "packages.dispatches.stateUnknown";

function dispatchStateKey(state: string): DispatchStateKey {
  return (
    (STATE_KEY as Record<string, DispatchStateKey>)[state] ??
    "packages.dispatches.stateUnknown"
  );
}

const EFFECT_LABEL = {
  confirmed: "packages.dispatches.effect.confirmed",
  none: "packages.dispatches.effect.none",
  unknown: "packages.dispatches.effect.unknown",
} as const;

type EffectKey = (typeof EFFECT_LABEL)[keyof typeof EFFECT_LABEL];

function effectKey(status: unknown): EffectKey | null {
  if (typeof status !== "string") return null;
  return (EFFECT_LABEL as Record<string, EffectKey>)[status] ?? null;
}

/** Unknown first (they need a person), then newest first. */
function orderOf(
  left: { state: string; createdAt: string },
  right: { state: string; createdAt: string },
): number {
  const leftUnknown = left.state === "unknown" ? 0 : 1;
  const rightUnknown = right.state === "unknown" ? 0 : 1;
  if (leftUnknown !== rightUnknown) return leftUnknown - rightUnknown;
  return left.createdAt < right.createdAt ? 1 : -1;
}

function shortDigest(digest: string): string {
  return digest.slice(0, 8);
}

export function PackageDispatchesSection({
  scope,
  install,
}: {
  scope: PluginPackageScope;
  install: PackageInstallDTO;
}) {
  const { t } = useTranslation("market");
  const dispatches = useQuery(
    pluginPackageDispatchesQueryOptions(scope, install.installId),
  );
  const [open, setOpen] = React.useState<string | null>(null);
  const rows = [...(dispatches.data ?? [])].sort(orderOf);

  return (
    <section>
      <h3 className="text-sm font-medium text-foreground">
        {t("packages.dispatches.title")}
      </h3>
      <p className="mt-1 text-xs text-foreground/50">
        {t("packages.dispatches.summary")}
      </p>
      {dispatches.isError ? (
        <p className="mt-2 text-sm text-foreground/50">
          {t("packages.dispatches.loadError")}
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-foreground/50">
          {t("packages.dispatches.noDispatches")}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.operationId}
              className="rounded-lg bg-foreground/[0.03] px-3 py-2"
            >
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-2 text-left"
                aria-expanded={open === row.operationId}
                onClick={() =>
                  setOpen(open === row.operationId ? null : row.operationId)
                }
              >
                <WbTag className={STATE_TONE[row.state]}>
                  {t(dispatchStateKey(row.state))}
                </WbTag>
                <code className="min-w-0 truncate font-mono text-xs text-foreground/70">
                  {row.toolRef}
                </code>
                <span className="ml-auto text-xs text-foreground/40">
                  {new Date(row.createdAt).toLocaleString()}
                </span>
              </button>
              {open === row.operationId ? (
                <PackageDispatchInspection
                  scope={scope}
                  installId={install.installId}
                  operationId={row.operationId}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PackageDispatchInspection({
  scope,
  installId,
  operationId,
}: {
  scope: PluginPackageScope;
  installId: string;
  operationId: string;
}) {
  const { t } = useTranslation("market");
  const queryClient = useQueryClient();
  const inspection = useQuery(
    pluginPackageDispatchInspectionQueryOptions(scope, installId, operationId),
  );
  const verify = usePackageDispatchVerify(queryClient);
  const data = inspection.data;

  if (inspection.isError) {
    return (
      <p className="mt-2 text-sm text-foreground/50">
        {t("packages.dispatches.loadError")}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="mt-2 text-sm text-foreground/50">
        {t("packages.dispatches.loading")}
      </p>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 border-t border-foreground/5 pt-2">
      {data.verification.kind === "unknown" ? (
        <>
          <p className="text-sm text-foreground/80">
            {data.verification.canQueryVendor
              ? t("packages.dispatches.reasonUnresolved")
              : t("packages.dispatches.reasonNoProtocol")}
          </p>
          {data.recovery ? (
            <p className="text-sm text-foreground/60">
              {data.recovery.ready
                ? t("packages.dispatches.recoveryReady")
                : t("packages.dispatches.recoveryBlocked", {
                    code: data.recovery.refusalCode,
                  })}
            </p>
          ) : null}
          {data.verification.canQueryVendor ? (
            <button
              type="button"
              className="self-start text-sm text-foreground underline decoration-foreground/30 underline-offset-4"
              disabled={verify.isPending}
              onClick={() => verify.mutate({ scope, installId, operationId })}
            >
              {t("packages.dispatches.verifyAction")}
            </button>
          ) : null}
          {verify.data ? (
            <p className="text-sm text-foreground/60">
              {verify.data.outcome === "unresolved"
                ? t("packages.dispatches.verifyUnresolved")
                : t("packages.dispatches.verifyVerified")}
            </p>
          ) : null}
          {verify.isError ? (
            <p className="text-sm text-foreground/60">
              {t("packages.dispatches.verifyFailed")}
            </p>
          ) : null}
          <section>
            <h4 className="text-xs font-medium text-foreground/60">
              {t("packages.dispatches.relatedReceiptsTitle")}
            </h4>
            {data.verification.relatedReceipts.length === 0 ? (
              <p className="mt-1 text-sm text-foreground/50">
                {t("packages.dispatches.relatedReceiptsNone")}
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {data.verification.relatedReceipts.map((receipt) => (
                  <li
                    key={receipt.operationId}
                    className="flex flex-wrap items-center gap-2 text-xs text-foreground/60"
                  >
                    <WbTag className={STATE_TONE[receipt.state]}>
                      {t(dispatchStateKey(receipt.state))}
                    </WbTag>
                    <code className="min-w-0 truncate font-mono">
                      {receipt.toolRef}
                    </code>
                    {(() => {
                      const effect = effectKey(
                        receipt.receiptRef?.effectStatus,
                      );
                      return effect ? <span>{t(effect)}</span> : null;
                    })()}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : data.verification.kind === "definite" ? (
        <p className="text-sm text-foreground/80">
          {(() => {
            const effect = effectKey(data.dispatch.receiptRef?.effectStatus);
            return effect ? t(effect) : t("packages.dispatches.stateSettled");
          })()}
          {data.dispatch.receiptRef?.verifiedVia === "vendor_query"
            ? t("packages.dispatches.verifiedByVendor")
            : null}
        </p>
      ) : (
        <p className="text-sm text-foreground/50">
          {t("packages.dispatches.stateDispatched")}
        </p>
      )}
      <section>
        <h4 className="text-xs font-medium text-foreground/60">
          {t("packages.dispatches.evidenceTitle")}
        </h4>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-foreground/60">
          <dt>{t("packages.dispatches.evidenceAccount")}</dt>
          <dd className="truncate font-mono">
            {data.evidence.accountHandle ??
              t("packages.dispatches.evidenceAccountNone")}
          </dd>
          <dt>{t("packages.dispatches.evidenceArgs")}</dt>
          <dd className="truncate font-mono">
            {shortDigest(data.evidence.argsDigest)}
          </dd>
          <dt>{t("packages.dispatches.evidenceGeneration")}</dt>
          <dd className="font-mono">{data.evidence.connectionGeneration}</dd>
        </dl>
      </section>
    </div>
  );
}
