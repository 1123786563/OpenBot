import {
  IconBrandGoogleDrive,
  IconBrandNotion,
  IconChevronRight,
  IconPlug,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import { RowMark } from "@/components/layout/row-mark";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  type CatalogueItem,
  scopedConnectionsQueryOptions,
  type PluginServer,
  personalConnections,
  scopedPluginsPageQueryOptions,
} from "@/lib/plugins/queries";

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
 */
export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: RouteComponent,
});

/**
 * A vendor's own mark where there is one, and a plug where there is not.
 *
 * The fallback covers a server an administrator added by URL, which has no catalogue entry and so no
 * mark of its own — and it would cover a catalogue vendor Tabler ships no brand for. Only Drive is in
 * the catalogue today, and Tabler has it.
 */
const MARKS: Record<string, React.ComponentType<{ className?: string }>> = {
  "google-drive": IconBrandGoogleDrive,
  notion: IconBrandNotion,
};

const markFor = (key: string) => MARKS[key] ?? IconPlug;

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
  youConnected: boolean,
  t: TFunction<"admin">,
): string {
  if (auth === "user-oauth" && !youConnected) return t("plugins.notConnected");
  if (server.tools.length === 0) return t("plugins.noToolsYet");

  const bots = new Set(server.tools.flatMap((tool) => tool.grantedTo)).size;
  const tools = t("plugins.toolCount", { count: server.tools.length });
  if (bots === 0) return `${tools} · ${t("plugins.noBots")}`;
  return `${tools} · ${t("plugins.botCount", { count: bots })}`;
}

function RouteComponent() {
  const { t } = useTranslation("admin");
  // The plugin admin face is the scope's own answer (MT094 / Issue #137, AC2 — 已安装列表与
  // 配置只反映当前范围): both reads carry the selection pair and file under the scope's prefix.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const plugins = useQuery(scopedPluginsPageQueryOptions(queryClient, scope));
  const connections = useQuery(
    scopedConnectionsQueryOptions(queryClient, scope),
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

  return (
    <PageShell
      description={t("plugins.description")}
      title={t("plugins.title")}
    >
      {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
      {plugins.isPending ? (
        <PageRowsSkeleton />
      ) : plugins.error ? (
        <p className="mt-12 text-destructive text-sm" role="alert">
          {t("plugins.loadError")}
        </p>
      ) : (
        <>
          <PageSection
            description={t("plugins.connected.description")}
            title={t("plugins.connected.title")}
          >
            {plugins.data?.servers.length === 0 ? (
              <PageEmpty>{t("plugins.connected.empty")}</PageEmpty>
            ) : (
              <PageRows>
                {plugins.data?.servers.map((server, index) => {
                  const Mark = markFor(server.id);
                  return (
                    <React.Fragment key={server.id}>
                      {/*
                       * A real link with no children. `useRender` merges props, and children passed
                       * here replace the row's own — the media, content and actions all vanish and
                       * the row draws empty. Its accessible name comes from the title inside it.
                       */}
                      <Item
                        data-testid={`plugin-${server.id}`}
                        render={
                          <Link
                            params={{ key: server.id }}
                            to="/admin/plugins/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark>
                          <Mark className="size-4" />
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
                              server.lastError ? "text-destructive" : undefined
                            }
                          >
                            {server.lastError ?? server.summary}
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {summaryFor(
                              server,
                              authByKey.get(server.id),
                              connected.has(server.id),
                              t,
                            )}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== (plugins.data?.servers.length ?? 0) - 1 && (
                        <Separator />
                      )}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description={t("plugins.explore.description")}
            title={t("plugins.explore.title")}
          >
            {explore.length === 0 ? (
              <PageEmpty>{t("plugins.explore.empty")}</PageEmpty>
            ) : (
              <PageRows>
                {explore.map((entry: CatalogueItem, index) => {
                  const Mark = markFor(entry.key);
                  return (
                    <React.Fragment key={entry.key}>
                      <Item
                        data-testid={`plugin-${entry.key}`}
                        render={
                          <Link
                            params={{ key: entry.key }}
                            to="/admin/plugins/$key"
                          />
                        }
                        size="sm"
                      >
                        <RowMark>
                          <Mark className="size-4" />
                        </RowMark>
                        <ItemContent>
                          <ItemTitle>{entry.title}</ItemTitle>
                          <ItemDescription>{entry.summary}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <span className="text-muted-foreground text-xs">
                            {t("plugins.notAdded")}
                          </span>
                          <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                        </ItemActions>
                      </Item>
                      {index !== explore.length - 1 && <Separator />}
                    </React.Fragment>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection
            description={t("plugins.moreApps.description")}
            title={t("plugins.moreApps.title")}
          >
            <PageRows>
              {/*
               * The row states the setting rather than hiding the feature. A deployment with no
               * Composio key still says that Composio is a thing this build can do and names the
               * variable that turns it on — a section that simply vanished would leave an
               * administrator with nothing to search for, and nothing to tell them the handful of
               * connectors above is not the whole story.
               */}
              {plugins.data?.composioConfigured ? (
                <Item
                  data-testid="plugin-composio"
                  render={<Link to="/admin/plugins/composio" />}
                  size="sm"
                >
                  <RowMark>
                    <IconPlug className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{t("plugins.moreApps.browse")}</ItemTitle>
                    <ItemDescription>
                      {t("plugins.moreApps.browseDescription")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ) : (
                /* No chevron and no link: the row goes nowhere, because there is nowhere to go
                   until the key is set. */
                <Item data-testid="plugin-composio" size="sm">
                  <RowMark>
                    <IconPlug className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{t("plugins.moreApps.composio")}</ItemTitle>
                    <ItemDescription>
                      {t("plugins.moreApps.composioDescription")}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              )}
              {/* The two brokers are two rows of one list, so they take the separator every other
                  list on this page puts between its rows. */}
              <Separator />
              {/*
               * The second broker's row, beneath the first and shaped exactly like it. Unset tokens
               * are a supported state with their own inert row naming the two variables that turn
                 it on, for the same reason the Composio row above names its one — a self-hosted
                 catalogue is no more discoverable by omission than a cloud one.
                 */}
              {plugins.data?.openConnectorConfigured ? (
                <Item
                  data-testid="plugin-open-connector"
                  render={<Link to="/admin/plugins/open-connector" />}
                  size="sm"
                >
                  <RowMark>
                    <IconPlug className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>
                      {t("plugins.moreApps.openConnectorBrowse")}
                    </ItemTitle>
                    <ItemDescription>
                      {t("plugins.moreApps.openConnectorBrowseDescription")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </ItemActions>
                </Item>
              ) : (
                /* The same inert twin: no chevron and no link, because the container this row
                   points at has not been given its tokens to talk to. */
                <Item data-testid="plugin-open-connector" size="sm">
                  <RowMark>
                    <IconPlug className="size-4" />
                  </RowMark>
                  <ItemContent>
                    <ItemTitle>{t("plugins.moreApps.openConnector")}</ItemTitle>
                    <ItemDescription>
                      {t("plugins.moreApps.openConnectorDescription")}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              )}
            </PageRows>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
