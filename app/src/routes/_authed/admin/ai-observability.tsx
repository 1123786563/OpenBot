import { createFileRoute } from "@tanstack/react-router";
import { ObservationAdminSummaryPage } from "@/components/ai-observability/admin-summary";

/**
 * The admin observability page (#42): the scope summary, collection health and export
 * counts of the caller's management range. Access stays whatever `_authed/admin` already
 * enforces; the page's own data query walks the API's manage gate, so a restricted
 * administrator's smaller scope is the whole page, never a filtered view of more.
 */
export const Route = createFileRoute("/_authed/admin/ai-observability")({
  component: ObservationAdminSummaryPage,
});
