import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";
import type {
  PackageCatalogueDetail,
  PackagePage,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The read-only plugin-package catalogue, PKG01.
 *
 * THE SCOPE IS PART OF EVERY KEY, not something the client attaches behind the caller's back:
 * `tenantId` + `workspaceId` + `principalId` name the subtree a page lives under, and the same
 * pair rides the request as the enterprise selection headers through `client`. A team switch
 * therefore produces a different key — nothing under the old key can decorate the new team — and
 * a response that left under the old pair can only land in an entry the screen no longer reads.
 *
 * WHAT IS ABSENT ON PURPOSE. Package installs, plans and grants are other tickets; these reads
 * carry no mutation, no install id and no token. The DTOs are the shared wire contract, imported
 * as types so a drift is a compile error here too.
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
