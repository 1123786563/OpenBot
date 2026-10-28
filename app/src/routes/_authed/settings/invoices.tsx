import {
  IconAlertTriangle,
  IconDownload,
  IconRefresh,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  InvoiceMethodLabel,
  InvoiceStatusPill,
} from "@/components/billing/invoice-status";
import { BillingPager } from "@/components/billing/pager";
import { PageSection, PageShell } from "@/components/layout/page-shell";
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
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { money } from "@/lib/billing/format";
import {
  type BillingInvoice,
  BillingUnavailableError,
  type InvoiceWindow,
} from "@/lib/billing/invoices";
import {
  scopedInvoiceDetailQueryOptions,
  scopedInvoicesQueryOptions,
} from "@/lib/billing/scoped";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { useDateTime } from "@/lib/i18n/datetime";

export const Route = createFileRoute("/_authed/settings/invoices")({
  component: RouteComponent,
  /*
   * `?range=` and `?page=` are the filter and the page the reader is on, in the URL rather than
   * component state: a bill somebody wants to query is a bill they will send a link to, and a
   * filter that reset itself on reload would make that link useless.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    range: RangeKey;
    page: number;
  } => {
    const range = String(search.range ?? "all");
    const parsed = Number.parseInt(String(search.page ?? "1"), 10);
    return {
      range: isRangeKey(range) ? range : "all",
      page: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1,
    };
  },
});

/**
 * 账单管理: what this deployment has been billed, and the receipt for each one.
 *
 * A bill here is a payment order this deployment raised and settled itself, read as a statement —
 * so the bill number is the order id a person already has in their channel's records, and the
 * payment method is the channel that carried the money. Nothing on this page is fetched from the
 * billing provider, and nothing on it needs to be.
 *
 * The page reads the way the question does: narrow it to a window, scan the rows, open the one
 * you came for.
 */

/** The saved windows. `all` is the whole history, which for a new deployment is one page. */
const RANGES = ["3m", "6m", "12m", "all"] as const;
type RangeKey = (typeof RANGES)[number];

function isRangeKey(value: string): value is RangeKey {
  return (RANGES as readonly string[]).includes(value);
}

/** How many months a saved window reaches back. `all` reaches back to nothing at all. */
const RANGE_MONTHS: Record<RangeKey, number | null> = {
  "3m": 3,
  "6m": 6,
  "12m": 12,
  all: null,
};

/*
 * The label keys, spelled out rather than built with a template literal: i18next's `t` is typed
 * over the keys it can actually find, and a `invoicesPage.ranges.${RangeKey}` string is not one of
 * them. Spelling four of them out is also what makes a missing translation a build error rather
 * than a chip reading "invoicesPage.ranges.3m".
 */
const RANGE_LABELS = {
  "3m": "invoicesPage.ranges.3m",
  "6m": "invoicesPage.ranges.6m",
  "12m": "invoicesPage.ranges.12m",
  all: "invoicesPage.ranges.all",
} as const satisfies Record<RangeKey, string>;

/** The window a saved range means, as the two ISO ends the API takes. */
function windowFor(range: RangeKey): InvoiceWindow {
  const months = RANGE_MONTHS[range];
  if (months === null) return {};
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  return { from: from.toISOString() };
}

function RouteComponent() {
  const { t } = useTranslation("settings");
  const { range, page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [openId, setOpenId] = useState<string | null>(null);
  /*
   * The window is memoized on `range` alone: `windowFor` reads the clock, and an unmemoized call
   * puts a fresh millisecond timestamp in the query key every render — a new key per render is a
   * new query per render, which is the refetch loop this page once had. The clock is read once per
   * range change; the page, not the render, is the unit of time here.
   */
  const window = useMemo(() => windowFor(range), [range]);
  /*
   * The scope the page holds (MT097 / Issue #140, AC4): the bill list files under the
   * scope's own prefix and carries the pair, so a switch drops the old scope's amounts
   * wholesale; unresolved scope (pending) falls back to the unscoped read.
   */
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const invoices = useQuery(
    scopedInvoicesQueryOptions(queryClient, scope, window, page),
  );

  const setRange = (next: RangeKey) => {
    // A new window invalidates the page number: page 4 of a three-month window is not page 4 of
    // the whole history, and keeping it would land the reader on an empty page they did not ask for.
    void navigate({ search: { range: next, page: 1 } });
  };

  return (
    <PageShell
      action={
        <Button
          onClick={() => invoices.refetch()}
          size="sm"
          variant="ghost"
          aria-label={t("invoicesPage.refresh")}
        >
          <IconRefresh />
          <span className="hidden sm:inline">{t("invoicesPage.refresh")}</span>
        </Button>
      }
      description={t("invoicesPage.description")}
      title={t("invoicesPage.title")}
      width="wide"
    >
      <PageSection>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={range}
            onValueChange={(value) => {
              if (typeof value === "string" && isRangeKey(value))
                setRange(value);
            }}
          >
            <SelectTrigger aria-label={t("invoicesPage.rangeLabel")}>
              <SelectValue>{t(RANGE_LABELS[range])}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((key) => (
                <SelectItem key={key} value={key}>
                  {t(RANGE_LABELS[key])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {invoices.isPending ? (
          <div className="mt-4 space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : invoices.error ? (
          <div className="mt-4">
            {invoices.error instanceof BillingUnavailableError ? (
              /*
               * A deployment with no billing provider has no bill surface at all, which is a fact
               * about the deployment and not a failure — said as one, with no retry button, because
               * retrying a route that is not mounted will never work.
               */
              <Empty className="border-border">
                <EmptyHeader>
                  <EmptyTitle>{t("invoicesPage.unavailable")}</EmptyTitle>
                  <EmptyDescription>
                    {t("invoicesPage.unavailableDescription")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <p className="text-destructive text-sm" role="alert">
                  {(invoices.error as Error).message}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void invoices.refetch()}
                >
                  {t("billing.retry")}
                </Button>
              </>
            )}
          </div>
        ) : invoices.data.invoices.length === 0 ? (
          <Empty className="mt-4 border-border">
            <EmptyHeader>
              <EmptyTitle>{t("invoicesPage.empty")}</EmptyTitle>
              <EmptyDescription>
                {range === "all"
                  ? t("invoicesPage.emptyDescription")
                  : t("invoicesPage.emptyFiltered")}
              </EmptyDescription>
            </EmptyHeader>
            {range === "all" ? null : (
              <EmptyContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRange("all")}
                >
                  {t("invoicesPage.showAll")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <>
            <section
              aria-label={t("invoicesPage.title")}
              className="mt-4 overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: An overflow region needs keyboard focus to scroll in Safari; the region has an accessible name.
              tabIndex={0}
            >
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr className="border-border border-b">
                    <th className="px-4 py-2 font-medium">
                      {t("invoicesPage.columnPeriod")}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t("invoicesPage.columnAmount")}
                    </th>
                    <th className="px-4 py-2 font-medium">
                      {t("invoicesPage.columnStatus")}
                    </th>
                    <th className="hidden px-4 py-2 font-medium md:table-cell">
                      {t("invoicesPage.columnMethod")}
                    </th>
                    <th className="hidden px-4 py-2 font-medium lg:table-cell">
                      {t("invoicesPage.columnNumber")}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t("invoicesPage.columnActions")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.data.invoices.map((invoice) => (
                    <InvoiceRow
                      key={invoice.invoiceId}
                      invoice={invoice}
                      onOpen={setOpenId}
                    />
                  ))}
                </tbody>
              </table>
            </section>
            <BillingPager
              page={page}
              totalPages={invoices.data.pagination.totalPages}
              totalCount={invoices.data.pagination.totalCount}
              hasNext={invoices.data.pagination.nextPage !== null}
              onPage={(next) =>
                void navigate({ search: { range, page: next } })
              }
              statusTemplate={t("invoicesPage.pagerStatus")}
            />
          </>
        )}
      </PageSection>

      <InvoiceDialog invoiceId={openId} onClose={() => setOpenId(null)} />
    </PageShell>
  );
}

/** One row. The period carries the plan under it, because that is what the money was for. */
function InvoiceRow({
  invoice,
  onOpen,
}: {
  invoice: BillingInvoice;
  onOpen: (invoiceId: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { formatDate } = useDateTime();
  return (
    <tr className="border-border border-t">
      <td className="px-4 py-2 whitespace-nowrap tabular-nums">
        {invoice.periodStart && invoice.periodEnd
          ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`
          : "–"}
        <span className="text-muted-foreground block text-xs">
          {invoice.planCode}
        </span>
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap tabular-nums">
        {money(invoice.amountCents, invoice.currency)}
      </td>
      <td className="px-4 py-2">
        <InvoiceStatusPill status={invoice.status} />
      </td>
      <td className="text-muted-foreground hidden px-4 py-2 whitespace-nowrap md:table-cell">
        <InvoiceMethodLabel method={invoice.method} />
      </td>
      <td className="text-muted-foreground hidden px-4 py-2 font-mono text-xs lg:table-cell">
        {invoice.invoiceId}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpen(invoice.invoiceId)}
          >
            {t("invoicesPage.viewDetail")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("invoicesPage.download")}
            onClick={() => downloadInvoice(invoice)}
          >
            <IconDownload />
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * One bill's detail, fetched when its dialog opens and never before.
 *
 * The row already carries everything the list shows, so this is only for what the list cannot
 * hold: the lines the bill is made of, the channel's own transaction id, and the moment the money
 * landed. A read per row would be a read per page load for bills nobody opens.
 */
function InvoiceDialog({
  invoiceId,
  onClose,
}: {
  invoiceId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const { formatDate, formatDateTime } = useDateTime();
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const detail = useQuery(
    scopedInvoiceDetailQueryOptions(queryClient, scope, invoiceId ?? ""),
  );
  const invoice = detail.data;

  return (
    <Dialog
      open={invoiceId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("invoicesPage.detailTitle")}</DialogTitle>
          <DialogDescription>
            {invoice ? invoice.invoiceId : t("invoicesPage.detailLoading")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {detail.isPending ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          ) : detail.error ? (
            <p
              className="text-destructive flex items-start gap-2 text-sm"
              role="alert"
            >
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              {(detail.error as Error).message}
            </p>
          ) : invoice ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground text-xs">
                  {t("invoicesPage.columnAmount")}
                </span>
                <span className="font-medium text-base tabular-nums">
                  {money(invoice.amountCents, invoice.currency)}
                </span>
              </div>
              <dl className="space-y-2 text-sm">
                <Row
                  label={t("invoicesPage.columnStatus")}
                  value={<InvoiceStatusPill status={invoice.status} />}
                />
                <Row
                  label={t("invoicesPage.columnPeriod")}
                  value={
                    invoice.periodStart && invoice.periodEnd
                      ? `${formatDate(invoice.periodStart)} – ${formatDate(invoice.periodEnd)}`
                      : "–"
                  }
                />
                <Row
                  label={t("invoicesPage.detailPlan")}
                  value={invoice.planCode}
                />
                <Row
                  label={t("invoicesPage.columnMethod")}
                  value={<InvoiceMethodLabel method={invoice.method} />}
                />
                <Row
                  label={t("invoicesPage.detailIssued")}
                  value={formatDateTime(invoice.issuedAt)}
                />
                {invoice.settledAt ? (
                  <Row
                    label={t("invoicesPage.detailSettled")}
                    value={formatDateTime(invoice.settledAt)}
                  />
                ) : null}
                {invoice.channelTransactionId ? (
                  <Row
                    label={t("invoicesPage.detailTransaction")}
                    value={
                      <span className="font-mono text-xs">
                        {invoice.channelTransactionId}
                      </span>
                    }
                  />
                ) : null}
              </dl>
              <div className="border-border border-t pt-2">
                <p className="text-muted-foreground mb-1 text-xs">
                  {t("invoicesPage.detailLines")}
                </p>
                {invoice.lines.map((line) => (
                  <div
                    key={`${line.label}-${line.amountCents}`}
                    className="flex items-baseline justify-between gap-3 text-sm"
                  >
                    <span className="truncate">
                      {line.label}
                      {line.quantity > 1 ? ` × ${line.quantity}` : ""}
                    </span>
                    <span className="tabular-nums">
                      {money(line.amountCents, invoice.currency)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {invoice ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadInvoice(invoice)}
            >
              <IconDownload />
              {t("invoicesPage.download")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 text-right text-sm">{value}</dd>
    </div>
  );
}

/**
 * Download one bill as a CSV the reader can open anywhere.
 *
 * Built in the browser rather than served, because a bill this deployment raised is a bill it
 * already holds every fact about — a round trip to format a file would be a round trip to re-read
 * what the page is looking at. CSV rather than PDF: it opens in the spreadsheet a finance person
 * will actually put it in, and it needs no rendering dependency.
 */
function downloadInvoice(invoice: BillingInvoice) {
  const cells = [
    ["bill_number", invoice.invoiceId],
    ["plan", invoice.planCode],
    ["period_start", invoice.periodStart ?? ""],
    ["period_end", invoice.periodEnd ?? ""],
    ["amount", (invoice.amountCents / 100).toFixed(2)],
    ["currency", invoice.currency],
    ["status", invoice.status],
    ["method", invoice.method],
    ["issued_at", invoice.issuedAt],
    ["settled_at", invoice.settledAt ?? ""],
    ["channel_transaction_id", invoice.channelTransactionId ?? ""],
  ];
  // A leading BOM so Excel reads the plan code's own characters rather than mangling them.
  const csv = `﻿${cells
    .map(([key, value]) => `${key},"${String(value).replace(/"/g, '""')}"`)
    .join("\r\n")}\r\n`;
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `openbot-bill-${invoice.invoiceId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
