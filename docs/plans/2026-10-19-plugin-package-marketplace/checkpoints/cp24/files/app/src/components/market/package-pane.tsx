import { IconAlertTriangle, IconSearch } from "@tabler/icons-react";
import {
  type QueryClient,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  PackageBlockerList,
  type PackageDetailSubject,
  PackageDetailWb,
  PackageInstallFacts,
} from "@/components/market/package-detail";
import {
  PackageInstallDialog,
  type PackageInstallSubject,
} from "@/components/market/package-install-dialog";
import {
  WbCard,
  WbCardSkeleton,
  WbCategoryChips,
  WbDesc,
  WbEmpty,
  WbName,
  WbSecondaryButton,
  WbTag,
} from "@/components/market/wb";
import { ClientResponseError } from "@/lib/client";
import {
  PACKAGE_PAGE_SIZE,
  type PluginPackageScope,
  pluginPackageKeys,
  pluginPackageListQueryOptions,
} from "@/lib/plugin-packages/queries";
import type { PackagePage } from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The 插件包 shelf: the deployment's verified packages, searchable and paginated, with a
 * read-only detail dialog.
 *
 * THE SCOPE IS A PROP, NOT A MODULE SINGLETON. The route derives it from the signed-in person and
 * their stored team selection; every query key and every request carries the same triple, so a
 * team switch is a different query tree rather than a refetch that might paint stale rows. With
 * no team chosen the shelf asks nothing and says which team to choose. The reads that decide that
 * get their own faces: a person or listing read still in flight is a skeleton, and a listing that
 * failed says so with a retry — neither masquerades as "no team chosen", because infrastructure
 * trouble is not an eligibility fact.
 *
 * NO INSTALL VERB LIVES ON A CARD. PKG02's preview starts from the detail dialog, and only when
 * the route says the person is a company administrator and the catalogue says the package is
 * installable. The server re-decides; a hidden button is not an authorization mechanism.
 */

export function PackagePane({
  scope,
  canInstall = false,
  currentUserPending = false,
  currentUserError = false,
  listingPending = false,
  listingError = false,
  listingRefetch,
}: {
  scope: PluginPackageScope | null;
  /** The route's reading of the company-administrator role; the server remains authoritative. */
  canInstall?: boolean;
  /** The signed-in person's own read has not answered yet; that is not "no team chosen". */
  currentUserPending?: boolean;
  /** The signed-in person's own read failed; that is not "no team chosen" either. */
  currentUserError?: boolean;
  /** The team listing behind the scope has not answered yet; that is not "no team chosen". */
  listingPending?: boolean;
  /** The team listing failed; that is not "no team chosen" either. */
  listingError?: boolean;
  /** Retry for the failed listing; rendered when the route can actually hit `listingError`. */
  listingRefetch?: () => void;
}) {
  const { t } = useTranslation("market");
  if (currentUserError) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {t("packages.accountError")}
      </p>
    );
  }
  if (currentUserPending || listingPending) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {["a", "b", "c", "d"].map((slot) => (
          <WbCardSkeleton key={slot} />
        ))}
      </div>
    );
  }
  if (listingError) {
    return (
      <div className="flex flex-col items-start gap-3 py-10" role="alert">
        <p className="text-destructive text-sm">{t("packages.scopeError")}</p>
        <p className="text-sm text-foreground/50">
          {t("packages.scopeErrorHint")}
        </p>
        {listingRefetch ? (
          <WbSecondaryButton onClick={() => listingRefetch()}>
            {t("packages.retry")}
          </WbSecondaryButton>
        ) : null}
      </div>
    );
  }
  if (scope === null) {
    return (
      <WbEmpty
        glyph="📦"
        hint={t("packages.scopeRequiredHint")}
        title={t("packages.scopeRequired")}
      />
    );
  }
  /*
   * A team switch is a new shelf, not the same shelf refetched: search, category, the detail
   * dialog and the held cursors all belong to the old (company, team, person) and must not
   * survive into the new one. Keying the browser is the reset.
   */
  return (
    <PackageBrowser
      canInstall={canInstall}
      key={`${scope.tenantId}\u0000${scope.workspaceId}\u0000${scope.principalId}`}
      scope={scope}
    />
  );
}

/**
 * The category chips' reading of the query cache, as ONE stable string.
 *
 * `useSyncExternalStore` compares snapshots by identity, so the value has to be cheap to compare:
 * categories are sorted and joined (none can contain the separator), and the consumer splits them
 * back. Reading every cached list page — not only the rows on screen — keeps the chips in place
 * while a category filter narrows the list.
 */
function categoriesSnapshot(
  queryClient: QueryClient,
  scope: PluginPackageScope,
): string {
  const found = new Set<string>();
  const pages = queryClient.getQueriesData<PackagePage>({
    queryKey: [...pluginPackageKeys.scope(scope), "list"],
  });
  for (const [, page] of pages) {
    for (const item of page?.items ?? []) found.add(item.category);
  }
  return [...found].sort().join("\u0000");
}

function PackageBrowser({
  scope,
  canInstall,
}: {
  scope: PluginPackageScope;
  canInstall: boolean;
}) {
  const { t } = useTranslation("market");
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [term, setTerm] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [subject, setSubject] = React.useState<PackageDetailSubject | null>(
    null,
  );
  const [installSubject, setInstallSubject] =
    React.useState<PackageInstallSubject | null>(null);

  // One round trip per settled term, as the market's broker search already does.
  React.useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * The cursors held belong to one (team, term, category) key. A different key derives the first
   * page without waiting for an effect, so no render can pair a new filter with an old cursor.
   */
  const pageKey = `${scope.tenantId}\u0000${scope.workspaceId}\u0000${scope.principalId}\u0000${term}\u0000${category}`;
  const [pageState, setPageState] = React.useState<{
    key: string;
    cursors: Array<string | null>;
  }>({ key: pageKey, cursors: [null] });
  const cursors = pageState.key === pageKey ? pageState.cursors : [null];
  const loadMore = (next: string) => {
    setPageState((held) => {
      const cursors = held.key === pageKey ? held.cursors : [null];
      // Appending the same cursor twice would put two observers on one cache
      // entry and render that page's items twice; a repeat click while the
      // page is still pending is a no-op.
      if (cursors[cursors.length - 1] === next) return held;
      return { key: pageKey, cursors: [...cursors, next] };
    });
  };

  const results = useQueries({
    queries: cursors.map((cursor) =>
      pluginPackageListQueryOptions(scope, {
        search: term === "" ? undefined : term,
        category: category === "all" ? undefined : category,
        cursor,
        limit: PACKAGE_PAGE_SIZE,
      }),
    ),
  });

  const items = results.flatMap((result) => result.data?.items ?? []);
  const first = results[0];
  const firstFailed = first?.isError === true;
  const loadingFirst = first?.isPending ?? true;

  // Chips subscribe to the cache instead of being read imperatively at render time: a page that
  // lands after the click still adds its categories to the row.
  const cache = queryClient.getQueryCache();
  const subscribe = React.useCallback(
    (onChange: () => void) => cache.subscribe(onChange),
    [cache],
  );
  const readCategories = React.useCallback(
    () => categoriesSnapshot(queryClient, scope),
    [queryClient, scope],
  );
  const categorySnapshot = React.useSyncExternalStore(
    subscribe,
    readCategories,
  );
  const categories = React.useMemo(
    () => (categorySnapshot === "" ? [] : categorySnapshot.split("\u0000")),
    [categorySnapshot],
  );

  /*
   * NEXT CURSOR COMES FROM THE LAST PAGE THAT ACTUALLY ANSWERED. Reading it off the last observer
   * would hand the failed page's own cursor back to "Load more" — pressing it would re-append the
   * page that just failed instead of offering a retry of that page.
   */
  let nextCursor: string | null = null;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const page = results[index]?.data;
    if (page !== undefined) {
      nextCursor = page.nextCursor;
      break;
    }
  }
  const failedPageIndex = results.findIndex(
    (result, index) => index > 0 && result.isError,
  );
  const failedPage = failedPageIndex > 0 ? results[failedPageIndex] : undefined;
  const loadingMore =
    failedPage === undefined &&
    results.slice(1).some((result) => result.isPending);

  // A 401/403 is the server saying no, not the transport failing: the copy names the permission
  // problem (and quotes the server's own sentence when it sent one). Anything else is a load
  // failure and keeps the transport wording.
  const firstError = first?.error ?? null;
  const refusal =
    firstError instanceof ClientResponseError &&
    (firstError.status === 401 || firstError.status === 403)
      ? firstError
      : null;

  const open = (item: (typeof items)[number]) => {
    const [publisher, name] = item.packageKey.split("/");
    if (publisher === undefined || name === undefined) return;
    setSubject({
      publisher,
      name,
      displayName: item.displayName,
      summary: item.summary,
    });
  };

  /*
   * The install the dialog draws is read from the live list, not copied into the dialog's
   * subject: after a confirm invalidates the scope, the freshly fetched row is what the open
   * dialog sees, and a cached row from the old team can never be picked up — the whole browser
   * was remounted under the new scope key.
   */
  const subjectInstall =
    subject === null
      ? null
      : (items.find(
          (item) => item.packageKey === `${subject.publisher}/${subject.name}`,
        )?.install ?? null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-foreground/40" />
          <input
            aria-label={t("packages.searchAria")}
            className="h-9 w-64 rounded-lg border border-transparent bg-foreground/[0.04] pr-3 pl-8 text-sm text-foreground outline-none transition-colors placeholder:text-foreground/40 focus-visible:border-foreground/20 focus-visible:bg-card"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("packages.searchPlaceholder")}
            value={search}
          />
        </div>
        <WbCategoryChips
          allLabel={t("category.all")}
          categories={categories}
          onChange={setCategory}
          value={category}
        />
      </div>

      {loadingFirst ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {["a", "b", "c", "d"].map((slot) => (
            <WbCardSkeleton key={slot} />
          ))}
        </div>
      ) : firstFailed ? (
        <div className="flex flex-col items-start gap-3 py-10" role="alert">
          <p className="text-destructive text-sm">
            {refusal ? t("packages.permissionError") : t("packages.loadError")}
          </p>
          <p className="text-sm text-foreground/50">
            {refusal
              ? (refusal.serverMessage ?? t("packages.permissionErrorHint"))
              : t("packages.loadErrorHint")}
          </p>
          <WbSecondaryButton onClick={() => void first?.refetch()}>
            {t("packages.retry")}
          </WbSecondaryButton>
        </div>
      ) : items.length === 0 ? (
        <WbEmpty
          glyph="📦"
          title={
            term !== ""
              ? t("packages.emptySearch", { query: term })
              : category !== "all"
                ? t("packages.emptyCategory", { category })
                : t("packages.empty")
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {items.map((item) => (
              <WbCard
                aria-label={item.displayName}
                className="w-full"
                interactive
                key={`${item.packageKey}:${item.version}`}
                onClick={() => open(item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    open(item);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <WbName>{item.displayName}</WbName>
                    <WbDesc>{item.summary}</WbDesc>
                  </div>
                  {item.installable ? null : (
                    <WbTag className="text-destructive">
                      {t("packages.unavailable")}
                    </WbTag>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <WbTag>
                    <code className="font-mono text-foreground/60">
                      {item.packageKey}
                    </code>
                  </WbTag>
                  <WbTag>{`v${item.install?.version ?? item.version}`}</WbTag>
                  <WbTag>{item.category}</WbTag>
                </div>
                {item.install ? (
                  <PackageInstallFacts
                    install={item.install}
                    showVersion={false}
                  />
                ) : (
                  <PackageBlockerList blockers={item.blockers} />
                )}
              </WbCard>
            ))}
          </div>
          {failedPage !== undefined ? (
            <div
              className="flex flex-wrap items-center justify-center gap-3 text-destructive text-sm"
              role="alert"
            >
              <IconAlertTriangle className="size-4" />
              {t("packages.loadMoreError")}
              <WbSecondaryButton
                disabled={failedPage.isFetching}
                onClick={() => void failedPage.refetch()}
              >
                {t("packages.retry")}
              </WbSecondaryButton>
            </div>
          ) : nextCursor !== null ? (
            <div className="flex justify-center pt-2">
              <WbSecondaryButton
                disabled={loadingMore}
                onClick={() => {
                  if (nextCursor !== null) loadMore(nextCursor);
                }}
              >
                {loadingMore
                  ? t("packages.loadingMore")
                  : t("packages.loadMore")}
              </WbSecondaryButton>
            </div>
          ) : null}
        </>
      )}

      {subject ? (
        <PackageDetailWb
          canInstall={canInstall}
          install={subjectInstall}
          onClose={() => setSubject(null)}
          onPreview={(next) => {
            // The detail step hands over to the preview step; the plan belongs to the preview.
            setSubject(null);
            setInstallSubject(next);
          }}
          scope={scope}
          subject={subject}
        />
      ) : null}

      {installSubject ? (
        <PackageInstallDialog
          onClose={() => setInstallSubject(null)}
          scope={scope}
          subject={installSubject}
        />
      ) : null}
    </div>
  );
}
