import { IconPlug } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  enableOpenConnectorAppMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import {
  type ComposioApp,
  openConnectorAppsQueryOptions,
} from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";

/**
 * OpenConnector's directory, searched rather than listed — the twin of the Composio picker.
 *
 * The catalogue on the previous screen is a reviewed handful, and every entry there is a decision
 * somebody made about a vendor. This is the self-hosted container's own list of the services it can
 * proxy, which nobody here has reviewed either — so it is a search field and not a list, for the
 * same reason the Composio picker is: the only sensible entry point into a directory of that size
 * is the name of the app you already came looking for.
 *
 * Apps that connect through a consent screen are not in this list at all: the container reports
 * them and the server filters them before the wire, because the OAuth client they would want is one
 * this deployment has nowhere to hold — the Composio picker's consent-only apps are withheld at the
 * same place, one broker over. What is left connects with a key the person already holds, which is
 * why the page below differs from its Composio twin in nothing but the words.
 *
 * Adding one is account-wide, and it still reads nothing. Every app here is reached as whoever is
 * asking, so a person's own connection is what makes their own repo or feed readable — which is
 * made on their settings page, not here.
 */
export const Route = createFileRoute("/_authed/admin/plugins/open-connector")({
  component: RouteComponent,
});

/**
 * The apps to draw, in the order to draw them.
 *
 * A function rather than a `.sort()` inside the map, so the two things a row is decided from — the
 * order, and the marker saying an app is already here — can be asserted without a DOM, a router and
 * a query client. See `tests/open-connector-picker.test.tsx`.
 *
 * A copy, because the array belongs to TanStack Query's cache and is the same object on every
 * render; sorting it in place would rewrite what the cache holds. By name rather than by the
 * container's own order, for the same reason the Composio picker sorts: useful for a landing page,
 * useless for finding the one app somebody typed half the name of.
 */
export function matchingApps(apps: ComposioApp[]): ComposioApp[] {
  return [...apps].sort((left, right) => left.name.localeCompare(right.name));
}

function RouteComponent() {
  const { t } = useTranslation("admin");
  const [search, setSearch] = React.useState("");
  /*
   * Debounced, as on People, and for a stronger reason: every distinct term is a cache key of its
   * own and a request to the container through our own endpoint, so typing a name un-debounced is a
   * round trip per keystroke against a container this deployment runs.
   */
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const apps = useQuery(openConnectorAppsQueryOptions(query));
  /*
   * WHAT A FAILED ADD SAID, KEPT WHERE A SECOND ADD CANNOT ERASE IT.
   *
   * ONE OBSERVER SERVES EVERY BUTTON, which is what `enable.variables` below is already written
   * around — and the same fact makes `enable.error` unusable as the place a refusal lives.
   * `MutationObserver.mutate` does `this.#currentMutation?.removeObserver(this)` and rebuilds, so
   * `error`, `isPending` and `variables` describe ONLY the most recent press. An admin pressing Add
   * on one app and then, a beat later, on another watched the first row revert from "Adding…" to
   * "Add" with its request still in flight — and when the first came back 409, or 503, or carrying
   * the server's own sentence about the container's tokens, the banner never showed it, because
   * `enable.error` was the second app's and that one was null. What was left was a row saying "Add"
   * and no record that anything failed.
   *
   * THE MUTATION-LEVEL `onError` STILL FIRES AFTER `removeObserver`, which is why this works and
   * reading the observer does not. It is the shape the Composio picker already uses, arriving at
   * this page as its twin.
   */
  const [enableError, setEnableError] = React.useState<string | null>(null);
  /*
   * AND WHICH ROWS ARE IN FLIGHT, FOR THE SAME REASON AND OUT OF THE SAME HOOKS.
   *
   * `enable.isPending && enable.variables?.slug === entry.slug` is the observer again: it names the
   * most recent press and no other, so pressing Add on a second app put the FIRST row back to "Add"
   * with its request still open — an invitation to press it again, which asks the server to enable
   * an app it is already enabling. A set of slugs is what survives the rebuild, added in `onMutate`
   * and removed in `onSettled` so it drains on a refusal exactly as it does on a success.
   */
  const [adding, setAdding] = React.useState<ReadonlySet<string>>(new Set());
  const enable = useMutation({
    ...enableOpenConnectorAppMutationOptions(queryClient),
    onMutate: (input: { slug: string }) => {
      setEnableError(null);
      setAdding((held) => new Set(held).add(input.slug));
    },
    onError: (thrown: Error) => setEnableError(thrown.message),
    /*
     * SPELLED OUT RATHER THAN INHERITED, because the spread above carries an `onSettled` of its own
     * — `invalidatePlugins` — and a second one here replaces it rather than running beside it. The
     * refetch is what turns the added row into "Added", so dropping it would leave the list claiming
     * the app is still addable until something else invalidated.
     */
    onSettled: (_data, _error, input) => {
      setAdding((held) => {
        const left = new Set(held);
        left.delete(input.slug);
        return left;
      });
      return invalidatePlugins(queryClient);
    },
  });
  const listed = matchingApps(apps.data?.apps ?? []);

  return (
    <PageShell
      backButton={{
        label: t("plugins.title"),
        linkProps: { to: "/admin/plugins" },
      }}
      description={t("openConnector.description")}
      title={t("openConnector.title")}
    >
      <PageSection
        description={t("openConnector.apps.description")}
        title={t("openConnector.apps.title")}
      >
        {enableError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {enableError}
          </p>
        ) : null}

        <Input
          aria-label={t("openConnector.searchAria")}
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("openConnector.searchPlaceholder")}
          value={search}
        />

        {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
        {apps.isPending ? null : apps.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {/*
             * The server's own sentence, as the enable failure above already does. A tokenless
             * deployment is refused with one naming OPENCONNECTOR_ADMIN_TOKEN and
             * OPENCONNECTOR_RUNTIME_TOKEN, and those names are the single thing an operator who
             * reached this URL needs to read; the hardcoded line stays as the fallback for a
             * failure that arrived carrying no message of its own.
             */}
            {apps.error.message || t("openConnector.directoryUnavailable")}
          </p>
        ) : listed.length === 0 ? (
          <PageEmpty>
            {query ? (
              t("openConnector.noMatches", { query })
            ) : (
              t("openConnector.noApps")
            )}
          </PageEmpty>
        ) : (
          <PageRows>
            {listed.map((entry, index) => {
              // One mutation serves every row, so which rows are mid-request is tracked beside it
              // rather than read off it. See `adding` above.
              const isAdding = adding.has(entry.slug);

              return (
                <React.Fragment key={entry.slug}>
                  <Item data-testid={`open-connector-${entry.slug}`} size="sm">
                    {/* The service's own mark where the directory supplies one, and a plug where it
                        does not, so a list of third parties still has a fixed left edge. */}
                    <ItemMedia variant={entry.logo ? "image" : "icon"}>
                      {entry.logo ? (
                        <img alt="" src={entry.logo} />
                      ) : (
                        <IconPlug />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{entry.name}</ItemTitle>
                      <ItemDescription>{entry.description}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/* The size of the decision, stated before it is made: an app is not one
                          tool, and "96 actions" is what says so. */}
                      <span className="text-muted-foreground text-xs">
                        {t("openConnector.actionCount", {
                          number: entry.actionCount,
                        })}
                      </span>
                      {/*
                       * An app this deployment already has says so rather than offering Add again.
                       * A second Add would ask the server to record a connector it already holds,
                       * and there is nothing on the row to suggest that would be harmless.
                       */}
                      {entry.enabled ? (
                        <span className="text-muted-foreground text-xs">
                          {t("openConnector.added")}
                        </span>
                      ) : (
                        <Button
                          disabled={isAdding}
                          onClick={() => enable.mutate({ slug: entry.slug })}
                          size="sm"
                          variant="outline"
                        >
                          {isAdding
                            ? t("openConnector.adding")
                            : t("openConnector.add")}
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                  {index !== listed.length - 1 && <Separator />}
                </React.Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
