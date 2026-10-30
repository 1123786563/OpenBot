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
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  // The catalogue is one whole answer, so finding models in it is the page's
  // own work: a name query and a state filter narrow the list before the pager
  // walks it. Both are reading aids only — no filtering happens server-side.
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterState>("all");
  // Bulk opening: the keys of the rows whose checkboxes are on. Selection is
  // over openable models only and survives page turns and filter changes, so
  // "select all" then page around keeps what was picked.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The bulk write while it runs: done/total for the progress sentence, null
  // when no bulk dialog is open. Failures are kept for a notice after the run.
  const [bulk, setBulk] = useState<{
    running: boolean;
    done: number;
    total: number;
  } | null>(null);
  const [failures, setFailures] = useState<
    { model: string; message: string }[]
  >([]);

  const models = catalog.data?.models ?? [];
  const filtered = models.filter((model) => matches(model, query, filter));
  const openable = filtered.filter(
    (model) => !model.open && canOpen(model.priceStatus),
  );
  // A sync can shrink the list under a page already turned to, so the clamp — not the
  // state — decides which page is on screen (the pager clamps its own display the same way).
  const totalPages = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);
  const currentPage = Math.min(page, totalPages);
  const pageModels = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  const toggle = (key: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const openDialog = (
    model: AdminModelCatalogModel,
    state: "open" | "closed",
  ) => {
    setPending({ model, state });
    setReason("");
    setProblem(undefined);
  };

  const openBulkDialog = () => {
    setBulk({ running: false, done: 0, total: selected.size });
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
      setProblem(refusalMessage(error, t));
    }
  };

  // The bulk write is the single-model write, asked once per selected model:
  // one shared reason, one refusal sentence per model that the server refused.
  // A run does not stop on the first refusal — every selection gets its own
  // answer, and the ones that failed are named afterwards.
  const submitBulk = async () => {
    if (!bulk || bulk.running) return;
    if (reason.trim() === "") {
      setProblem(t("modelCatalog.dialog.reasonRequired"));
      return;
    }
    const targets = models.filter(
      (model) =>
        selected.has(modelKey(model)) &&
        !model.open &&
        canOpen(model.priceStatus),
    );
    setBulk({ running: true, done: 0, total: targets.length });
    const failed: { model: string; message: string }[] = [];
    for (const [index, model] of targets.entries()) {
      try {
        await setScope.mutateAsync({
          provider: model.ref.provider,
          model: model.ref.model,
          capability: model.ref.capability,
          state: "open",
          reason: reason.trim(),
        });
      } catch (error) {
        failed.push({
          model: model.ref.model,
          message: refusalMessage(error, t),
        });
      }
      setBulk({ running: true, done: index + 1, total: targets.length });
    }
    setBulk(null);
    setSelected(new Set());
    setFailures(failed);
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
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Input
                aria-label={t("modelCatalog.searchPlaceholder")}
                className="max-w-64"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder={t("modelCatalog.searchPlaceholder")}
                value={query}
              />
              <Select
                onValueChange={(value) => {
                  // null is the Select's "no selection", not a filter state.
                  if (value === null) return;
                  setFilter(value as FilterState);
                  setPage(1);
                }}
                value={filter}
              >
                <SelectTrigger
                  aria-label={t("modelCatalog.filter.all")}
                  className="w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {FILTER_STATES.map((state) => (
                      <SelectItem key={state} value={state}>
                        {t(`modelCatalog.filter.${state}` as never)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {openable.length > 0 ? (
                <Button
                  className="ml-auto"
                  onClick={() =>
                    setSelected(
                      new Set(openable.map((model) => modelKey(model))),
                    )
                  }
                  size="sm"
                  variant="ghost"
                >
                  {t("modelCatalog.selectAll")}
                </Button>
              ) : null}
            </div>
            {selected.size > 0 ? (
              <div className="mb-4 flex items-center gap-2">
                <span className="text-muted-foreground text-sm">
                  {t("modelCatalog.selectedCount", { count: selected.size })}
                </span>
                <Button onClick={openBulkDialog} size="sm">
                  {t("modelCatalog.bulkOpen")}
                </Button>
                <Button
                  onClick={() => setSelected(new Set())}
                  size="sm"
                  variant="ghost"
                >
                  {t("modelCatalog.clearSelection")}
                </Button>
              </div>
            ) : null}
            {failures.length > 0 ? (
              <p className="text-destructive mb-4 text-sm" role="alert">
                {t("modelCatalog.bulk.someFailed", {
                  count: failures.length,
                })}{" "}
                {failures
                  .slice(0, 3)
                  .map((failure) => failure.model)
                  .join(", ")}
              </p>
            ) : null}
            {filtered.length === 0 ? (
              <PageEmpty>{t("modelCatalog.filteredEmpty")}</PageEmpty>
            ) : (
              <PageRows>
                {pageModels.map((model, index) => (
                  <div key={modelKey(model)}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm" className="py-3">
                      {canOpen(model.priceStatus) && !model.open ? (
                        <Checkbox
                          aria-label={model.ref.model}
                          checked={selected.has(modelKey(model))}
                          onCheckedChange={(checked) =>
                            toggle(modelKey(model), checked)
                          }
                        />
                      ) : (
                        <span aria-hidden className="w-4" />
                      )}
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
                            {t("modelCatalog.fields.reason")}:{" "}
                            {model.scope.reason}
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
            )}
          </>
        ) : null}
        {catalog.data && filtered.length > 0 ? (
          <BillingPager
            hasNext={currentPage < totalPages}
            onPage={setPage}
            page={currentPage}
            statusTemplate={t("modelCatalog.pagerStatus")}
            totalCount={filtered.length}
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
      <Dialog
        onOpenChange={(open) => {
          if (!open && !bulk?.running) setBulk(null);
        }}
        open={bulk !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("modelCatalog.bulk.openTitle", { count: bulk?.total ?? 0 })}
            </DialogTitle>
            <DialogDescription>
              {t("modelCatalog.bulk.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <Field data-invalid={problem !== undefined}>
              <FieldLabel htmlFor="model-scope-bulk-reason">
                {t("modelCatalog.dialog.reasonLabel")}
              </FieldLabel>
              <Input
                aria-invalid={problem !== undefined}
                disabled={bulk?.running}
                id="model-scope-bulk-reason"
                name="reason"
                onChange={(event) => setReason(event.target.value)}
                placeholder={t("modelCatalog.dialog.reasonPlaceholder")}
                value={reason}
              />
              {problem ? <FieldError errors={[{ message: problem }]} /> : null}
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button
              disabled={bulk?.running}
              onClick={() => setBulk(null)}
              variant="ghost"
            >
              {t("modelCatalog.dialog.cancel")}
            </Button>
            <Button disabled={bulk?.running} onClick={() => void submitBulk()}>
              {bulk?.running
                ? t("modelCatalog.bulk.progress", {
                    done: bulk.done,
                    total: bulk.total,
                  })
                : t("modelCatalog.dialog.confirm")}
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

/** The state filter's closed vocabulary: every model, or one of the three states. */
const FILTER_STATES = ["all", "open", "closed", "unknown"] as const;
type FilterState = (typeof FILTER_STATES)[number];

/** Only a determinable price can be opened: known and free both pass. */
function canOpen(priceStatus: AdminModelCatalogModel["priceStatus"]): boolean {
  return priceStatus === "known" || priceStatus === "free";
}

/** One model against the reading aids: the query over name and provider, the state filter. */
function matches(
  model: AdminModelCatalogModel,
  query: string,
  filter: FilterState,
): boolean {
  if (filter === "open" && !model.open) return false;
  if (filter === "closed" && model.open) return false;
  if (
    filter === "unknown" &&
    model.priceStatus !== "unknown" &&
    model.priceStatus !== "unmapped"
  ) {
    return false;
  }
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return `${model.ref.model} ${model.ref.provider}`
    .toLowerCase()
    .includes(needle);
}

/** The sentence for a refused write: the server's own refusal, localized when known. */
function refusalMessage(error: unknown, t: TFunction<"admin">): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const key = refusalKey(message);
  // The refusal sentences live in this page's namespace; the i18next typed
  // keys cannot spell the dynamic template, so the read is spelled out here.
  return key ? t(key as never) : t("modelCatalog.operation");
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
