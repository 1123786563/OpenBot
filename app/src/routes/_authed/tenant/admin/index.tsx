import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/tenant/admin/")({
  /*
   * The area index is the nav itself: the layout gate has already answered (refusal, empty or
   * sections), so the index stays empty and every section has its own page.
   */
  component: () => null,
});
