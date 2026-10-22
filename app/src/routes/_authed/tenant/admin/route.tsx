import { createFileRoute } from "@tanstack/react-router";
import { CompanyAdminArea } from "@/components/company-admin/company-admin-area";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";

export const Route = createFileRoute("/_authed/tenant/admin")({
  /*
   * The company admin area's own gate (MT095/MT096/MT097, AC1): the route itself only requires a
   * session (the `_authed` boundary) — whether this member may see anything is the SERVER's
   * capability answer, rendered by `CompanyAdminArea` as an explicit refusal state. This is the
   * deliberate opposite of the platform `/admin` gate (a deployment role redirecting home): a
   * refusal here is a rendered answer about the company, not a route that vanishes.
   */
  component: RouteComponent,
});

function RouteComponent() {
  const scope = useScopedCache();
  return <CompanyAdminArea scope={scope} />;
}
