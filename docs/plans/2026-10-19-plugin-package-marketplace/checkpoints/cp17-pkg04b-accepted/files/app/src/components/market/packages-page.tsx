import { useTranslation } from "react-i18next";
import { PackagePane } from "@/components/market/package-pane";
import { usePackageScope } from "@/lib/plugin-packages/use-package-scope";

/**
 * The member-reachable plugin-package shelf. `/admin/market` stays the deployment
 * console's entry; this route is the same pane for team members, who must be able
 * to browse the trusted catalogue without a deployment-admin role. Installing
 * itself stays a company `tenant_admin` act decided by the server.
 */
export function PackagesMarketPage() {
  const { t } = useTranslation("market");
  const { scope, canInstall, currentUserPending, currentUserError } =
    usePackageScope();
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <h1 className="text-lg font-semibold tracking-tight">
        {t("packages.pageTitle")}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("packages.pageDescription")}
      </p>
      <div className="mt-6">
        <PackagePane
          scope={scope}
          canInstall={canInstall}
          currentUserPending={currentUserPending}
          currentUserError={currentUserError}
        />
      </div>
    </div>
  );
}
