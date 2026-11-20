import { createFileRoute } from "@tanstack/react-router";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { GovernancePage } from "@/components/astryx-pilot/governance";

export const Route = createFileRoute("/_authed/admin/permissions")({
  component: PermissionsPage,
});

/** Admin, Permissions: what people may do with Bots, for everybody and per role or group. */
export function PermissionsPage() {
  return (
    <GovernancePage
      description="Each switch applies to everybody. A role can override it, and a directory group can get a permission the organization has off. All changes appear in Audit."
      title="Permissions"
    >
      <CapabilitiesSection />
    </GovernancePage>
  );
}
