import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BillingPager } from "@/components/billing/pager";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type GatewayCatalogSyncResult,
  runCatalogSyncMutationOptions,
  setModelScopeMutationOptions,
} from "@/lib/gateway/mutations";
import {
  type AdminModelCatalogModel,
  gatewayModelCatalogQueryOptions,
} from "@/lib/gateway/queries";
import { useDateTime } from "@/lib/i18n/datetime";

export const Route = createFileRoute("/_authed/admin/model-catalog")({
  component: ModelCatalogPage,
});

/** How many models one page of the list holds. The catalog arrives whole; the pager walks it. */
const PAGE_SIZE = 50;

/**
 * The administrator's model catalog (Bifrost 03.7): every model the gateway's
 * last successful sync listed, with its price status and the open-scope
 * decision.
 *
 * THE CATALOG EXISTING IS NOT THE MODEL BEING OPEN. This page never lets a
 * sync speak for an administrator: a model arrives closed by default and the
 * open button — with a required reason — is the only thing that opens it.
 * Closing records its own reason, which is what a user-facing screen shows
 * when the model is unavailable.
 *
 * THE SERVER HOLDS THE DECISION. Every state on this page is read back from
 * the server's answer; the buttons only ask. A refused change shows the
 * server's own sentence, and the list is re-read afterwards, so the screen
 * never shows a decision the server does not hold.
 */

/** The refusal codes the server can answer a scope change with. */
const SCOPE_REFUSAL_KEYS = [
  "model_scope_reason_required",
  "model_scope_reason_too_long",
  "model_scope_ref_not_in_catalog",
  "model_scope_price_missing",
  "model_scope_price_unknown",
  "model_scope_input_invalid",
  "model_scope_state_invalid",
] as const;

function refusalKey(message: string): string | undefined {
  return (SCOPE_REFUSAL_KEYS as readonly string[]).includes(message)
    ? `modelCatalog.refusals.${message}`
    : undefined;
}

function ModelCatalogPage() {
  const { t } = useTranslation("admin");
  const { formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const catalog = useQuery(gatewayModelCatalogQueryOptions());
  const setScope = useMutation(setModelScopeMutationOptions(queryClient));
  // The manual trigger (03.5): the same sync the server's timer runs, fired
  // now. The outcome displayed is the server's own answer — never a verdict
  // the page guessed.
  const sync = useMutation(runCatalogSyncMutationOptions(queryClient));

  /** The model a dialog is open for, and the state being asked for. */
  const [pending, setPending] = useState<{
    model: AdminModelCatalogModel;
    state: "open" | "closed";
  } | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  // A sync can shrink the list under a page already turned to, so the clamp — not the
  // state — decides which page is on screen (the pager clamps its own display the same way).
  const models = catalog.data?.models ?? [];
  const totalPages = Math.max(Math.ceil(models.length / PAGE_SIZE), 1);
  const currentPage = Math.min(page, totalPages);
  const pageModels = models.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const openDialog = (
    model: AdminModelCatalogModel,
    state: "open" | "closed",
  ) => {
    setPending({ model, state });
    setReason("");
    setProblem(undefined);
  };

  const submit = async () => {
    if (!pending) return;
    if (reason.trim() === "") {
      setProblem(t("modelCatalog.dialog.reasonRequired"));
      return;
    }
    try {
      await setScope.mutateAsync({
        provider: pending.model.ref.provider,
        model: pending.model.ref.model,
        capability: pending.model.ref.capability,
        state: pending.state,
        reason: reason.trim(),
      });
      setPending(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      const key = refusalKey(message);
      setProblem(
        key
          ? // The refusal sentences live in this page's namespace; the i18next
            // typed keys cannot spell the dynamic template, so the read is
            // spelled out here.
            t(key as never)
          : t("modelCatalog.operation"),
      );
    }
  };

  return (
    <PageShell
      description={t("modelCatalog.description")}
      title={t("modelCatalog.title")}
    >
      <PageSection
        description={t("modelCatalog.sync.description")}
        title={t("modelCatalog.sync.title")}
      >
        <div className="flex items-center gap-3">
          <Button
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
            size="sm"
          >
            {sync.isPending
              ? t("modelCatalog.sync.running")
              : t("modelCatalog.sync.button")}
          </Button>
          <span
            className="text-muted-foreground text-sm"
            data-testid="catalog-sync-result"
          >
            {syncLine(sync.data, sync.isError, t, formatDateTime)}
          </span>
        </div>
      </PageSection>

      <PageSection
        description={t("modelCatalog.syncHint")}
        title={t("modelCatalog.listTitle")}
      >
        {catalog.isPending ? <PageRowsSkeleton rows={4} /> : null}
        {catalog.isError ? (
          <PageEmpty>{t("modelCatalog.loadError")}</PageEmpty>
        ) : null}
        {catalog.data && models.length === 0 ? (
          <PageEmpty>{t("modelCatalog.empty")}</PageEmpty>
        ) : null}
        {catalog.data && models.length > 0 ? (
          <PageRows>
            {pageModels.map((model, index) => (
              <div key={modelKey(model)}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm" className="py-3">
                  <ItemContent>
                    <ItemTitle>
                      {model.ref.model}
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        · {model.ref.provider} · {model.ref.capability}
                      </span>
                    </ItemTitle>
                    <ItemDescription>
                      {priceLine(model, t)}
                      {" · "}
                      {scopeLine(model, t)}
                      {model.scope
                        ? ` · ${t("modelCatalog.scope.changedBy", {
                            by: model.scope.changedBy,
                            at: formatDateTime(model.scope.changedAt),
                          })}`
                        : null}
                    </ItemDescription>
                    {model.scope ? (
                      <ItemDescription>
                        {t("modelCatalog.fields.reason")}: {model.scope.reason}
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    {model.open ? (
                      <Button
                        onClick={() => openDialog(model, "closed")}
                        size="sm"
                        variant="outline"
                      >
                        {t("modelCatalog.close")}
                      </Button>
                    ) : (
                      <Button
                        disabled={model.priceStatus === "unknown"}
                        onClick={() => openDialog(model, "open")}
                        size="sm"
                        variant="outline"
                      >
                        {t("modelCatalog.open")}
                      </Button>
                    )}
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        ) : null}
        {catalog.data && models.length > 0 ? (
          <BillingPager
            hasNext={currentPage < totalPages}
            onPage={setPage}
            page={currentPage}
            statusTemplate={t("modelCatalog.pagerStatus")}
            totalCount={models.length}
            totalPages={totalPages}
          />
        ) : null}
      </PageSection>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        open={pending !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pending?.state === "open"
                ? t("modelCatalog.dialog.openTitle")
                : t("modelCatalog.dialog.closeTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("modelCatalog.dialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Field data-invalid={problem !== undefined}>
              <FieldLabel htmlFor="model-scope-reason">
                {t("modelCatalog.dialog.reasonLabel")}
              </FieldLabel>
              <Input
                aria-invalid={problem !== undefined}
                id="model-scope-reason"
                name="reason"
                onChange={(event) => setReason(event.target.value)}
                placeholder={t("modelCatalog.dialog.reasonPlaceholder")}
                value={reason}
              />
              {problem ? <FieldError errors={[{ message: problem }]} /> : null}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setPending(null)} variant="ghost">
              {t("modelCatalog.dialog.cancel")}
            </Button>
            <Button disabled={setScope.isPending} onClick={() => void submit()}>
              {t("modelCatalog.dialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function modelKey(model: AdminModelCatalogModel): string {
  return `${model.ref.provider}|${model.ref.model}|${model.ref.capability}`;
}

/**
 * The sentence the manual sync's outcome earns: what the server answered —
 * the synced time and snapshot counts, the failing layer's fixed reason
 * code, or the unavailable sentence when the trigger never ran. Nothing
 * here is a verdict the page made up.
 */
function syncLine(
  data: GatewayCatalogSyncResult | undefined,
  errored: boolean,
  t: TFunction<"admin">,
  formatDateTime: (value: string) => string,
): string {
  if (data?.status === "ok") {
    return t("modelCatalog.sync.resultSuccess", {
      at: formatDateTime(data.syncedAt),
      appended: data.appended,
      skipped: data.skipped,
    });
  }
  if (data?.status === "failed") {
    return t("modelCatalog.sync.resultFailed", {
      reason: data.reasonCode,
    });
  }
  if (errored) {
    return t("modelCatalog.sync.resultUnavailable");
  }
  return "";
}

/** The price sentence: the classification, plus what is missing when it is unknown. */
function priceLine(
  model: AdminModelCatalogModel,
  t: TFunction<"admin">,
): string {
  const label = t(`modelCatalog.price.${model.priceStatus}` as never);
  if (
    model.priceStatus === "unknown" &&
    model.priceMissingDims &&
    model.priceMissingDims.length > 0
  ) {
    return `${label} (${t("modelCatalog.price.unknownDetail", {
      dims: model.priceMissingDims
        .map((missing) => missing.dimension)
        .join(", "),
    })})`;
  }
  return label;
}

/** The availability sentence: the state, or the default a sync arrives at. */
function scopeLine(
  model: AdminModelCatalogModel,
  t: TFunction<"admin">,
): string {
  if (!model.scope) return t("modelCatalog.scope.default");
  return model.scope.state === "open"
    ? t("modelCatalog.scope.open")
    : t("modelCatalog.scope.closed");
}
