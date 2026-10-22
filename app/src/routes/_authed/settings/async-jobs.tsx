import { createFileRoute } from "@tanstack/react-router";
import { AsyncJobsView } from "@/components/billing/async-jobs-view";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/settings/async-jobs")({
  component: RouteComponent,
});

/**
 * The person's own async jobs (Bifrost 17.8, #332): the 套餐与积分 family's jobs read —
 * status, reason, amounts, frozen attribution. The view owns every query (see
 * `AsyncJobsView` for the page's own account of itself); the route is the lift the UI
 * tests render, the same seam the usage page keeps.
 */
function RouteComponent() {
  const scope = useScopedCache();
  return <AsyncJobsView scope={scope} />;
}
