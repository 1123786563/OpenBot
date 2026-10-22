import { createFileRoute } from "@tanstack/react-router";
import { OrdersGrantsView } from "@/components/billing/orders-view";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/settings/orders")({
  component: RouteComponent,
  /*
   * `?page=` is the orders page the reader is on, in the URL rather than component state — the
   * same reason the bill list keeps it there: a reader quoting "order po_123, page 1" sends a
   * link, and a page number that reset itself on reload would make that link useless.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    page: number;
  } => {
    const parsed = Number.parseInt(String(search.page ?? "1"), 10);
    return {
      page: Number.isInteger(parsed) && parsed >= 1 ? parsed : 1,
    };
  },
});

/**
 * The 订单与积分 page is a URL contract over the view: the search params become props, the view
 * owns every query and state (see `OrdersGrantsView` for the page's own account of itself).
 */
function RouteComponent() {
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope = useScopedCache();
  return (
    <OrdersGrantsView
      page={page}
      onPage={(next) => void navigate({ search: { page: next } })}
      scope={scope}
    />
  );
}
