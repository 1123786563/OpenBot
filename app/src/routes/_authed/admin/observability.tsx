import { createFileRoute } from "@tanstack/react-router";
import { ObservationAdminSummaryPage } from "@/components/ai-observability/admin-summary";

/**
 * T02 route convention for the admin observability chain. The existing
 * /admin/ai-observability address stays mounted for links already in the wild; both render
 * the same scope summary, and both inherit the `_authed/admin` guard.
 */
export const Route = createFileRoute("/_authed/admin/observability")({
  component: ObservationAdminSummaryPage,
});
