import { createFileRoute, Link } from "@tanstack/react-router";
import { CapabilitiesSection } from "@/components/admin/controls/capabilities-section";
import { MemberAccess } from "@/components/admin/controls/member-access";
import { GovernancePage } from "@/components/astryx-pilot/governance";
import { buttonVariants } from "@/components/ui/button";

export const Route = createFileRoute("/_authed/admin/permissions")({
  component: PermissionsPage,
});

/** Admin, Permissions: what people may do with Bots, for everybody and per role or group. */
export function PermissionsPage() {
  return (
    <GovernancePage
      action={
        <Link
          className={buttonVariants({
            className: "min-h-12",
            variant: "outline",
          })}
          search={{ permissions: true }}
          to="/admin/audit"
        >
          Permission history
        </Link>
      }
      description="Manage the workspace's Bot permissions and check what individual members can use."
      title="Permissions"
    >
      <MemberAccess />
      <CapabilitiesSection />
    </GovernancePage>
  );
}
