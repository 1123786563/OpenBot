import { createFileRoute } from "@tanstack/react-router";
import {
  isRangeKey,
  UsageCreditsView,
} from "@/components/billing/usage-credits-view";
import type { ConsumptionRange } from "@/components/billing/consumption-table";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/settings/usage")({
  component: RouteComponent,
  /*
   * `?range=` and `?page=` are the consumption window and the page the reader is on, in the URL
   * rather than component state — the same reason the bill list keeps them there: a reader who
   * wants to quote "the last 30 days of spending" sends a link, and a filter that reset itself on
   * reload would make that link useless.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    range: ConsumptionRange;
    page: number;
  } => {
    const range = String(search.range ?? "7d");
    const parsed = Number.parseInt(String(search.page ?? "1"), 10);
    return {
      range: isRangeKey(range) ? range : "7d",
      page: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1,
    };
  },
});

/**
 * The 套餐与积分 page is a URL contract over the view: the search params become props, the view
 * owns every query and state (see `UsageCreditsView` for the page's own account of itself). The
 * lift (ticket 02.7) is the seam the UI tests render — the whole page, no router under it.
 */
function RouteComponent() {
  const { range, page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope = useScopedCache();
  return (
    <UsageCreditsView
      range={range}
      page={page}
      onRangeChange={(next) =>
        void navigate({ search: { range: next, page: 1 } })
      }
      onPage={(next) => void navigate({ search: { range, page: next } })}
      scope={scope}
    />
  );
}
