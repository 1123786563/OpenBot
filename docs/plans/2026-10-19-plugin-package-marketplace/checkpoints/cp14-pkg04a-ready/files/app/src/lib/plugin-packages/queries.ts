import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  PackageCatalogueDetail,
  PackageInstallDetailDTO,
  PackagePage,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The read-only plugin-package catalogue, PKG01, plus the scope-scoped install detail read.
 *
 * THE SCOPE IS PART OF EVERY KEY, not something the client attaches behind the caller's back:
 * `tenantId` + `workspaceId` + `principalId` name the subtree a page lives under, and the same
 * pair rides the request as the enterprise selection headers through `client`. A team switch
 * therefore produces a different key — nothing under the old key can decorate the new team — and
 * a response that left under the old pair can only land in an entry the screen no longer reads.
 *
 * WHAT IS ABSENT ON PURPOSE. The catalogue reads carry no mutation and no token; installs and
 * plans are write paths owned by `mutations.ts` (PKG02). The install-detail read (PKG03) is
 * read-only too: the scope triple names the key and travels as headers only — never in a body.
 * The DTOs are the shared wire contract, imported as types so a drift is a compile error here too.
 */

/** The selection a package page answers under; the principal is the signed-in user's id. */
export type PluginPackageScope = {
  tenantId: string;
  workspaceId: string;
  principalId: string;
};

/** One list page's request: the server's own query fields, cursor included. */
export type PluginPackageListQuery = {
  search?: string;
  category?: string;
  cursor: string | null;
  limit?: number;
};

const PACKAGE_ROOT = "/api/enterprise/plugin-packages";

/** The list page size the marketplace asks for; the server's default is also 20. */
export const PACKAGE_PAGE_SIZE = 20;

function scopeKey(scope: PluginPackageScope) {
  return [
    "plugin-packages",
    scope.tenantId,
    scope.workspaceId,
    scope.principalId,
  ] as const;
}

export const pluginPackageKeys = {
  /** Everything one (company, team, person) answers for. */
  scope: scopeKey,
  list: (scope: PluginPackageScope, query: PluginPackageListQuery) =>
    [
      ...scopeKey(scope),
      "list",
      {
        search: query.search ?? "",
        category: query.category ?? "",
        cursor: query.cursor,
        limit: query.limit ?? PACKAGE_PAGE_SIZE,
      },
    ] as const,
  /** The detail key names the package identity; the scope prefix keeps teams apart. */
  detail: (scope: PluginPackageScope, publisher: string, name: string) =>
    [...scopeKey(scope), "detail", publisher, name] as const,
  /**
   * The install-detail key names the installed instance; the scope prefix keeps teams apart, so a
   * grant mutation can invalidate exactly the one install it answered for and nothing beside it.
   */
  installDetail: (scope: PluginPackageScope, installId: string) =>
    [...scopeKey(scope), "install", installId] as const,
};

function listPath(query: PluginPackageListQuery): string {
  const params = new URLSearchParams();
  if (query.search !== undefined && query.search !== "") {
    params.set("search", query.search);
  }
  if (query.category !== undefined && query.category !== "") {
    params.set("category", query.category);
  }
  if (query.cursor !== null) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? PACKAGE_PAGE_SIZE));
  return `${PACKAGE_ROOT}?${params.toString()}`;
}

/** One page of the deployment-wide catalogue, as this scope may see it. */
export function pluginPackageListQueryOptions(
  scope: PluginPackageScope,
  query: PluginPackageListQuery,
) {
  return queryOptions({
    queryKey: pluginPackageKeys.list(scope, query),
    queryFn: async ({ signal }): Promise<PackagePage> => {
      const response = await client(listPath(query), {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        signal,
        fallbackKey: "marketplace.load",
      });
      return (await response.json()) as PackagePage;
    },
  });
}

/** One package's catalogue detail: resources, blockers and the verified digest. */
export function pluginPackageDetailQueryOptions(
  scope: PluginPackageScope,
  publisher: string,
  name: string,
) {
  return queryOptions({
    queryKey: pluginPackageKeys.detail(scope, publisher, name),
    queryFn: async ({ signal }): Promise<PackageCatalogueDetail> => {
      const response = await client(
        `${PACKAGE_ROOT}/catalogue/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}`,
        {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          signal,
          fallbackKey: "marketplace.load",
        },
      );
      return (await response.json()) as PackageCatalogueDetail;
    },
  });
}

/**
 * One install's facts in this scope: the resources of the current revision and the active Bot
 * grants — the authorization state the grant screen manages. Scope headers only; the scope in
 * the key keeps a late answer from ever landing in another team's tree.
 */
export function pluginPackageInstallDetailQueryOptions(
  scope: PluginPackageScope,
  installId: string,
) {
  return queryOptions({
    queryKey: pluginPackageKeys.installDetail(scope, installId),
    queryFn: async ({ signal }): Promise<PackageInstallDetailDTO> => {
      const response = await client(
        `${PACKAGE_ROOT}/installs/${encodeURIComponent(installId)}`,
        {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          signal,
          fallbackKey: "marketplace.load",
        },
      );
      return (await response.json()) as PackageInstallDetailDTO;
    },
  });
}
