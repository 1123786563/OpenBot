import { Stack } from "@astryxdesign/core/Stack";
import {
  IconApps,
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconChevronRight,
  IconCircleCheck,
  IconPlug,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { ConnectionPage } from "@/components/connections/connection-surface";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { RowMark } from "@/components/layout/row-mark";
import {
  AccessRequestsSection,
  usePendingRequestCounts,
} from "@/components/plugins/access-requests";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useManagePaths } from "@/lib/manage-paths";
import {
  moreAppsRow,
  moreAppsSectionDescription,
} from "@/lib/plugins/provider-vocabulary";
import {
  type CatalogueItem,
  connectionsQueryOptions,
  type PluginServer,
  personalConnections,
  pluginsPageQueryOptions,
  pluginsProvider,
} from "@/lib/plugins/queries";
import { toolsListError } from "@/lib/plugins/tools-error";

/**
 * What this deployment can reach, as one list per state.
 *
 * This screen used to be three tabs: a catalogue of what could be added, a second tab for what had
 * been, and skills. Answering one question about one vendor — is Drive available, and what can it
 * do — meant visiting two of them, and the third was a different kind of thing altogether. Two
 * lists say the same thing in one read: what is connected, and what else there is.
 *
 * Every row goes to that vendor's own page, because what a connector needs configured is not the
 * same from one vendor to the next. A token, an OAuth client, an instance hostname, and a grant per
 * tool per Bot do not fit on a row, and the previous screen's attempt to fit them made a page that
 * scrolled sideways.
 *
 * Drawn under Admin in the team edition and under Settings in the personal one: see `manage-paths`.
 */

/**
 * A vendor's own mark where Tabler ships one. Everything else draws the server's logo, or its
 * initial: a server an administrator added by URL has no catalogue entry and so no mark of its own,
 * and a column of identical plugs would tell one vendor from another no better than no icon at all.
 */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

function VendorMark({
  id,
  logo,
  name,
}: {
  id: string;
  logo?: string | null;
  name: string;
}) {
  const Brand = MARKS[id];
  if (Brand) return <Brand className="size-4" />;
  return <PluginLogo logo={logo} name={name} />;
}

/**
 * What a connected row says on the right.
 *
 * The current answer rather than the field's name, which is what the layout skill asks of a summary:
 * "4 tools · 2 Bots" tells an administrator where this vendor stands, and "Tools" would not.
 *
 * A vendor reached as the person asking is a special case worth its own words. It can be fully
 * configured — client registered, tools listed — and still answer nothing, because the thing that
 * reads anything is a grant belonging to whoever is asking. "Not connected" is about you, not about
 * the deployment.
 */
function summaryFor(
  server: PluginServer,
  /**
   * The vendor's auth kind, from the catalogue rather than the server record.
   *
   * A server row says what this deployment has stored; whose credential reaches it is a fact about
   * the vendor. Undefined for a server added by URL, which has no catalogue entry and is therefore
   * never reached as a person.
   */
  auth: CatalogueItem["auth"] | undefined,
  youConnected: "checking" | "unavailable" | "connected" | "disconnected",
): string {
  if (auth === "user-oauth") {
    if (server.accountMode === "shared") {
      if (!server.sharedVendorConnected) return "Shared account not connected";
    } else {
      if (youConnected === "checking") return "Checking account…";
      if (youConnected === "unavailable") return "Account status unavailable";
      if (youConnected === "disconnected")
        return "Personal account not connected";
    }
  }
  if (server.tools.length === 0) return "No tools yet";

  const bots = new Set(server.tools.flatMap((tool) => tool.grantedTo)).size;
  const tools = `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
  if (bots === 0) return `${tools} · no Bots`;
  return `${tools} · ${bots} ${bots === 1 ? "Bot" : "Bots"}`;
}

/**
 * `children` are sections only the team edition's Admin adds below the page's own (the admin's
 * controls for these). The personal edition's Settings renders this page with none.
 */
/** Placeholder rows while the list loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];

let lastOpenedPlugin: { entry: string; id: string } | undefined;

function searchText(value: string) {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function PluginsListPage({
  children,
  search = "",
  onSearchChange,
}: {
  children?: React.ReactNode;
  search?: string;
  onSearchChange?: (query: string) => void;
} = {}) {
  const paths = useManagePaths();
  const plugins = useQuery(pluginsPageQueryOptions());
  const connections = useQuery(connectionsQueryOptions());
  const heading = React.useRef<HTMLHeadingElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const inputId = React.useId();
  const rows = React.useRef(new Map<string, HTMLAnchorElement>());
  const entry = useLocation({ select: (location) => location.state.__TSR_key });
  const returnPlugin = useLocation({
    select: (location) => location.state.returnPlugin,
  });
  const restoredEntry = React.useRef<string>(undefined);
  /*
   * Requests waiting per app, so an administrator sees which app somebody is asking about from the
   * list, without opening each one. Every request is also listed in full above the lists.
   */
  const requestCounts = usePendingRequestCounts();
  // A NAME for the "More apps" row, which cannot be read off a row that may not exist yet.
  const provider = pluginsProvider(plugins.data);
  const moreApps = moreAppsRow(
    provider,
    plugins.data?.composioConfigured ?? false,
  );

  /*
   * PERSONAL ONLY: a Shared app's connection is the deployment's standing account, not something
   * the signed-in admin connected themselves. Reading it into this set would mark that row "you
   * connected" on a deployment-wide list where nobody connected anything personally.
   */
  const connected = new Set(
    personalConnections(connections.data?.connections ?? []).map(
      (row) => row.serverId,
    ),
  );
  const added = new Set((plugins.data?.servers ?? []).map((s) => s.id));
  const explore = (plugins.data?.catalogue ?? []).filter(
    (entry) => !added.has(entry.key),
  );
  /** Keyed by catalogue key, which is also the server id, so a row can ask how it is reached. */
  const authByKey = new Map(
    (plugins.data?.catalogue ?? []).map((entry) => [entry.key, entry.auth]),
  );
  const words = searchText(search).trim().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const matches = (value: string) => {
    const text = searchText(value);
    return words.every((word) => text.includes(word));
  };
  const servers = plugins.data?.servers ?? [];
  const shownServers = servers.flatMap((server) => {
    const metadata = searchText(
      `${server.title} ${server.id} ${server.vendor} ${server.summary ?? ""}`,
    );
    const toolTerms = words.filter((word) => !metadata.includes(word));
    if (!toolTerms.length) return [{ server, matchedTools: [] }];
    const tools = server.tools.map(({ name, description }) => ({
      name,
      text: searchText(`${name} ${description}`),
    }));
    if (
      !toolTerms.every((word) => tools.some(({ text }) => text.includes(word)))
    )
      return [];
    const matchedTools = tools
      .filter(({ text }) => toolTerms.some((word) => text.includes(word)))
      .map(({ name }) => name);
    return [{ server, matchedTools }];
  });
  const shownExplore = searching
    ? explore.filter((app) =>
        matches(`${app.title} ${app.vendor} ${app.key} ${app.summary}`),
      )
    : explore;
  const count = shownServers.length + shownExplore.length;
  const showAccountError =
    connections.isError &&
    shownServers.some(
      ({ server }) =>
        authByKey.get(server.id) === "user-oauth" &&
        server.accountMode !== "shared",
    );

  React.useLayoutEffect(() => {
    if (
      !entry ||
      !plugins.isSuccess ||
      plugins.isFetching ||
      restoredEntry.current === entry
    )
      return;
    const id =
      returnPlugin ??
      (lastOpenedPlugin?.entry === entry ? lastOpenedPlugin.id : undefined);
    if (!id) return;
    const target = rows.current.get(id);
    restoredEntry.current = entry;
    lastOpenedPlugin = undefined;
    if (document.activeElement === document.body)
      (target ?? input.current ?? heading.current)?.focus();
  }, [entry, plugins.isFetching, plugins.isSuccess, returnPlugin]);

  function linkProps(id: string) {
    return {
      ...paths.plugin(id, search || undefined),
      onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (
          entry &&
          event.button === 0 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey
        )
          lastOpenedPlugin = { entry, id };
      },
      ref: (node: HTMLAnchorElement | null) => {
        if (node) rows.current.set(id, node);
        else rows.current.delete(id);
      },
    };
  }

  return (
    <ConnectionPage
      description="Connect services for your company, then choose which Bots can use each service’s tools."
      headingRef={heading}
      title="Plugins"
    >
      {/* Pending, error, empty, rows — pending draws placeholder rows, so no sentence asserts
          anything mid-fetch and the page is not blank behind its heading. */}
      {plugins.isPending ? (
        <div aria-busy="true" aria-label="Loading apps" role="status">
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <React.Fragment key={key}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <RowMark>
                    <Skeleton className="size-4" />
                  </RowMark>
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </ItemContent>
                </Item>
              </React.Fragment>
            ))}
          </PageRows>
        </div>
      ) : plugins.error ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't load plugins."
          retry={plugins.refetch}
          retrying={plugins.isFetching}
          retryBelow
        />
      ) : (
        <>
          {/*
           * First, because each one is somebody waiting. All of them, not only those about an app
           * that is connected: an app nobody has switched on has no page of its own to list them on.
           */}
          {!searching ? <AccessRequestsSection /> : null}

          {onSearchChange && (servers.length + explore.length > 0 || search) ? (
            <section aria-label="Find a plugin">
              <Stack gap={2}>
                <FieldLabel htmlFor={inputId}>Search plugins</FieldLabel>
                <Stack direction="horizontal" gap={2} align="center">
                  <Input
                    aria-label="Search plugins"
                    className="min-h-11"
                    id={inputId}
                    maxLength={200}
                    onChange={(event) => onSearchChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && search) {
                        event.preventDefault();
                        onSearchChange("");
                      }
                      if (
                        event.key === "Enter" &&
                        !event.nativeEvent.isComposing
                      ) {
                        const first =
                          shownServers[0]?.server.id ?? shownExplore[0]?.key;
                        if (first) rows.current.get(first)?.focus();
                      }
                    }}
                    placeholder="Search by plugin, vendor or tool"
                    ref={input}
                    type="search"
                    value={search}
                  />
                  {search ? (
                    <Button
                      className="min-h-11 shrink-0"
                      variant="outline"
                      onClick={() => {
                        onSearchChange("");
                        input.current?.focus();
                      }}
                    >
                      Clear search
                    </Button>
                  ) : null}
                </Stack>
                <p className="text-muted-foreground text-sm" role="status">
                  {searching
                    ? count
                      ? `${count} ${count === 1 ? "plugin matches" : "plugins match"}`
                      : "No matching plugins"
                    : "Search connected and listed plugins. Use More apps for the full app catalogue."}
                </p>
              </Stack>
            </section>
          ) : null}
          {showAccountError ? (
            <ReadError
              focusAfterRetry={() => input.current ?? heading.current}
              message="Couldn’t check personal account status."
              retry={connections.refetch}
              retryBelow
              retrying={connections.isFetching}
              retryLabel="Retry account status"
            />
          ) : null}

          {!searching || shownServers.length > 0 ? (
            <PageSection
              description="Open an added plugin to manage its accounts and choose which Bots get its tools."
              title="Added plugins"
            >
              {plugins.data?.servers.length === 0 ? (
                <PageEmpty icon={IconPlug} title="No plugins added yet">
                  Pick a plugin from the catalogue below.
                </PageEmpty>
              ) : (
                <PageRows>
                  {shownServers.map(({ server, matchedTools }, index) => {
                    return (
                      <React.Fragment key={server.id}>
                        {/*
                         * A real link with no children. `useRender` merges props, and children passed
                         * here replace the row's own — the media, content and actions all vanish and
                         * the row draws empty. Its accessible name comes from the title inside it.
                         */}
                        <Item
                          data-testid={`plugin-${server.id}`}
                          render={<Link {...linkProps(server.id)} />}
                          size="sm"
                        >
                          <RowMark>
                            <VendorMark
                              id={server.id}
                              logo={server.logo}
                              name={server.title}
                            />
                          </RowMark>
                          <ItemContent>
                            <ItemTitle>{server.title}</ItemTitle>
                            {/*
                             * The vendor's last failure takes the description's place when there is
                             * one. A server with no tools and no explanation reads as a server that
                             * offers nothing, which sends somebody looking in the wrong place.
                             */}
                            <ItemDescription
                              className={
                                server.lastError
                                  ? "text-destructive"
                                  : undefined
                              }
                            >
                              {toolsListError(server.lastError, {
                                title: server.title,
                                personal: false,
                              }) ?? server.summary}
                            </ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <PendingRequests
                              count={requestCounts?.byApp[server.id] ?? 0}
                            />
                            <span className="text-muted-foreground text-xs">
                              {summaryFor(
                                server,
                                authByKey.get(server.id),
                                connections.isPending
                                  ? "checking"
                                  : connections.isError
                                    ? "unavailable"
                                    : connected.has(server.id)
                                      ? "connected"
                                      : "disconnected",
                              )}
                            </span>
                            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </ItemActions>
                          {matchedTools.length ? (
                            <ItemFooter>
                              <ItemDescription className="line-clamp-none wrap-anywhere">
                                Matching tools:{" "}
                                {matchedTools.slice(0, 3).join(", ")}
                                {matchedTools.length > 3
                                  ? ` · ${matchedTools.length - 3} more`
                                  : null}
                              </ItemDescription>
                            </ItemFooter>
                          ) : null}
                        </Item>
                        {index !== shownServers.length - 1 && <Separator />}
                      </React.Fragment>
                    );
                  })}
                </PageRows>
              )}
            </PageSection>
          ) : null}

          {!searching || shownExplore.length > 0 ? (
            <PageSection
              description="Reviewed, first-party servers. Open one to add it."
              title="Explore plugins"
            >
              {explore.length === 0 ? (
                <PageEmpty
                  icon={IconCircleCheck}
                  title={
                    authByKey.size
                      ? "All catalogue plugins added"
                      : "No plugins in this catalogue"
                  }
                >
                  {authByKey.size
                    ? "Open an added plugin to check its connection and tools."
                    : "Open More apps to browse the provider catalogue."}
                </PageEmpty>
              ) : (
                <PageRows>
                  {shownExplore.map((entry: CatalogueItem, index) => {
                    return (
                      <React.Fragment key={entry.key}>
                        <Item
                          data-testid={`plugin-${entry.key}`}
                          render={<Link {...linkProps(entry.key)} />}
                          size="sm"
                        >
                          <RowMark>
                            <VendorMark id={entry.key} name={entry.title} />
                          </RowMark>
                          <ItemContent>
                            <ItemTitle>{entry.title}</ItemTitle>
                            <ItemDescription>{entry.summary}</ItemDescription>
                          </ItemContent>
                          <ItemActions>
                            <PendingRequests
                              count={requestCounts?.byApp[entry.key] ?? 0}
                            />
                            <span className="text-muted-foreground text-xs">
                              Not added
                            </span>
                            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </ItemActions>
                        </Item>
                        {index !== shownExplore.length - 1 && <Separator />}
                      </React.Fragment>
                    );
                  })}
                </PageRows>
              )}
            </PageSection>
          ) : null}

          <PageSection
            description={moreAppsSectionDescription(provider)}
            title="More apps"
          >
            <PageRows>
              {/*
               * The row states the setting rather than hiding the feature. A deployment with no
               * Composio key still says that Composio is a thing this build can do and names the
               * variable that turns it on — a section that simply vanished would leave an
               * administrator with nothing to search for, and nothing to tell them the handful of
               * connectors above is not the whole story.
               */}
              {moreApps.linked ? (
                <Item
                  data-testid="plugin-directory"
                  /* The ACTIVE provider's own directory, by the provider rather than a path
                     written here: a hard-coded path is the lowercase spelling of a vendor name,
                     which is how this row pointed every Arcade deployment at a screen that
                     redirected it straight back. `brokerDirectory` names only routes the
                     generated route tree has, so a path no route answers does not compile. */
                  render={
                    <Link
                      {...paths.brokerDirectory(provider, search || undefined)}
                    />
                  }
                  size="sm"
                >
                  <RowMark>
                    <IconApps className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{moreApps.title}</ItemTitle>
                    <ItemDescription>{moreApps.description}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ) : (
                /* No chevron and no link: the row goes nowhere, because there is nowhere to go
                   until the key is set. */
                <Item data-testid="plugin-directory" size="sm">
                  <RowMark>
                    <IconApps className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{moreApps.title}</ItemTitle>
                    <ItemDescription>{moreApps.description}</ItemDescription>
                  </ItemContent>
                </Item>
              )}
            </PageRows>
          </PageSection>
        </>
      )}
      {!searching ? children : null}
    </ConnectionPage>
  );
}

/**
 * "2 requests", beside a row's summary, in the foreground colour so it is the first thing on the
 * row that reads as something to do. Nothing at zero: a count of nothing on every row is noise.
 */
function PendingRequests({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="font-medium text-foreground text-xs tabular-nums">
      {count} {count === 1 ? "request" : "requests"}
    </span>
  );
}
