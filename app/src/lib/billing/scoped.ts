import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { tryClient } from "@/lib/client";
import { guarded } from "@/lib/enterprise/tenant/queries";
import type { ScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  type BillingEntitlements,
  billingKeys,
} from "@/lib/billing/queries";
import {
  type ConsumptionWindow,
  type CreditConsumptionPage,
  type CreditGrantEntry,
  type PersonalCreditBalance,
  creditsKeys,
} from "@/lib/billing/credits";
import {
  type BillingInvoiceDetail,
  type BillingInvoicePage,
  BillingUnavailableError,
  invoiceKeys,
} from "@/lib/billing/invoices";

/*
 * The billing pages' scoped half (MT097 / Issue #140, AC4): the orders, invoices, credits and
 * usage reads a person's billing surfaces make, bound to the selection the screen holds.
 *
 * WHAT THE SCOPE CHANGES, AND WHAT IT STILL DOES NOT. The key lives under the scope's own prefix
 * (MT083's `scopedCachePrefix`) and the request carries the pair on the reviewed `/api/billing`
 * family, so a switch drops the old scope's amounts wholesale and the new scope's first read
 * answers — no stale balances, no order rows from the scope the reader just left. What the scope
 * does not change is the account: these server reads resolve the payer from the session (10.1's
 * read scope — the page sends no account identifier), and the legacy billing assembly consumes
 * the selection pair when it reads the scope seam itself (MT125); until then the pair rides the
 * request and the per-scope cache is the whole of the switch contract. The company-dimension
 * amounts live behind their own gate: `lib/enterprise/tenant/company-admin.ts`'s company books,
 * served from the enterprise API whose scope gate consumes the pair today.
 *
 * A pending scope reads nothing — the same refusal every scoped surface makes while the scope
 * source (the signed-in user) has not answered.
 */

/** The options half every factory here shares: pending scope disables, open scope prefixes. */
function scopedKey(
  scope: ScopedCache,
  key: readonly unknown[],
): { enabled: boolean; queryKey: readonly unknown[] } {
  if (scope.status === "open") {
    return { enabled: true, queryKey: [...scope.prefix, ...key] };
  }
  return { enabled: false, queryKey: [...key, ":scope-pending"] };
}

/** The guarded read half: pair on the request, generation guard around the fetch. */
async function scopedRead<T>(
  queryClient: QueryClient,
  scope: ScopedCache,
  path: string,
  fallback: string,
): Promise<T> {
  const open = scope.status === "open" ? scope : null;
  if (open === null) throw new Error("Billing data is not readable yet.");
  return guarded(queryClient, open.userId, async () => {
    const response = await tryClient(path, {
      fallbackKey: "billing.scopedRead",
      ...(open.selection ?? {}),
    });
    if (response.status === 404) throw new BillingUnavailableError();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(body.error ?? fallback);
    }
    return (await response.json()) as T;
  });
}

/** One page of bills in a window, newest first — filed under the scope, refetched on a switch. */
export function scopedInvoicesQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  window: { from?: string; to?: string },
  page: number,
) {
  return queryOptions({
    ...scopedKey(scope, invoiceKeys.list(window, page)),
    staleTime: 0,
    queryFn: () => {
      const params = new URLSearchParams();
      if (window.from) params.set("from", window.from);
      if (window.to) params.set("to", window.to);
      params.set("page", String(page));
      return scopedRead<BillingInvoicePage>(
        queryClient,
        scope,
        `/api/billing/invoices?${params}`,
        "Your bills could not be loaded.",
      );
    },
  });
}

/** One bill's detail (the dialog the bill list opens), under the same scope discipline. */
export function scopedInvoiceDetailQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  invoiceId: string,
) {
  return queryOptions({
    ...scopedKey(scope, invoiceKeys.detail(invoiceId)),
    enabled: invoiceId !== "",
    queryFn: () =>
      scopedRead<BillingInvoiceDetail>(
        queryClient,
        scope,
        `/api/billing/invoices/${encodeURIComponent(invoiceId)}`,
        "That bill could not be loaded.",
      ),
  });
}

/** The credit balance of the scope in force — the amount a switch must never leave behind. */
export function scopedCreditsSummaryQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, creditsKeys.summary),
    staleTime: 0,
    queryFn: () =>
      scopedRead<PersonalCreditBalance>(
        queryClient,
        scope,
        "/api/billing/credits/summary",
        "Your credits could not be loaded.",
      ),
  });
}

/** The reward grants of the scope in force. */
export function scopedCreditsGrantsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, creditsKeys.grants),
    staleTime: 0,
    queryFn: () =>
      scopedRead<{ grants: CreditGrantEntry[] }>(
        queryClient,
        scope,
        "/api/billing/credits/grants",
        "Your credit grants could not be loaded.",
      ),
  });
}

/** One page of the consumption ledger in a window — the usage the usage page shows per scope. */
export function scopedCreditsConsumptionQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
  window: ConsumptionWindow,
  page: number,
) {
  return queryOptions({
    ...scopedKey(scope, creditsKeys.consumption(window, page)),
    staleTime: 0,
    queryFn: () => {
      const params = new URLSearchParams();
      if (window.from) params.set("from", window.from);
      if (window.to) params.set("to", window.to);
      params.set("page", String(page));
      return scopedRead<CreditConsumptionPage>(
        queryClient,
        scope,
        `/api/billing/credits/consumption?${params}`,
        "Your credit usage could not be loaded.",
      );
    },
  });
}

/** The entitlements of the scope in force (the plan the selected scope's account holds). */
export function scopedEntitlementsQueryOptions(
  queryClient: QueryClient,
  scope: ScopedCache,
) {
  return queryOptions({
    ...scopedKey(scope, billingKeys.entitlements),
    staleTime: 30_000,
    queryFn: () =>
      scopedRead<BillingEntitlements>(
        queryClient,
        scope,
        "/api/billing/entitlements",
        "Your plan could not be loaded.",
      ),
  });
}
