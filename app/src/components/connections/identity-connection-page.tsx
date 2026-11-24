import { IconBrandGithub, IconChevronRight } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ConnectionPage } from "@/components/connections/connection-surface";
import { CorsairAccounts } from "@/components/connections/corsair-accounts";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { GithubSources } from "@/components/settings/github-sources";
import {
  type LinkableProvider,
  LinkedAccountSection,
  linkableProviderTitle,
} from "@/components/settings/linked-accounts";
import {
  linkedNotice,
  visibleLinkedNotice,
} from "@/components/settings/linked-notice";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { IDENTITY_SUMMARIES, isBrokeredGithub } from "@/lib/connections/rows";
import { linkedAccountsQueryOptions } from "@/lib/identity/queries";
import {
  connectionsQueryOptions,
  personalConnections,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * GitHub's or Slack's page under Connections: the person's own account there, and for GitHub what
 * hangs off it.
 *
 * These used to be a "Linked accounts" section and a "GitHub events" section on the Connections
 * page itself, beside the apps, so a person had to know a link was a different kind of thing from an
 * app before they could find it. Now each is a row like any app, and this is the row's page.
 *
 * `linked` is what the GitHub callback sends back, `?linked=github` and its failures. It is said
 * once and then dropped from the address, so a reload does not repeat the news.
 */
export function IdentityConnectionPage({
  linked,
  outcome,
  provider,
}: {
  linked: string | undefined;
  outcome?: string;
  provider: LinkableProvider;
}) {
  const title = linkableProviderTitle(provider);
  const [arrival] = useState(() => linkedNotice(linked));
  const links = useQuery(linkedAccountsQueryOptions());
  const notice = visibleLinkedNotice(arrival, links.data);
  const navigate = useNavigate();
  useEffect(() => {
    if (linked !== undefined) {
      navigate({
        to: ".",
        search: (previous: Record<string, unknown>) => {
          const { linked: _linked, ...rest } = previous;
          return rest;
        },
        replace: true,
      });
    }
  }, [linked, navigate]);

  return (
    <ConnectionPage
      backButton={{ label: "Connections", linkProps: { to: "/connections" } }}
      description={IDENTITY_SUMMARIES[provider]}
      title={title}
    >
      {notice ? (
        <p
          className={
            notice.tone === "error"
              ? "mt-4 text-destructive text-sm"
              : "mt-4 text-muted-foreground text-sm"
          }
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}
      <CorsairAccounts key={provider} provider={provider} outcome={outcome} />
      <LinkedAccountSection key={provider} provider={provider} />
      {provider === "github" ? (
        <>
          <GithubSources />
          <GithubTools />
        </>
      ) : null}
    </ConnectionPage>
  );
}

/**
 * A brokered GitHub app, where one is enabled. It is a separate connection — tools that read and
 * change repositories as you — and the Connections list leaves its row out so GitHub is listed once,
 * which makes this the way to it.
 */
function GithubTools() {
  const plugins = useQuery(pluginsPageQueryOptions());
  const heading = useRef<HTMLHeadingElement>(null);
  const app = plugins.data?.composioConfigured
    ? plugins.data.servers.find(
        (server) => isBrokeredGithub(server) && server.accountMode !== "shared",
      )
    : undefined;
  const connections = useQuery({
    ...connectionsQueryOptions(),
    enabled: plugins.isSuccess && Boolean(app),
  });
  if (plugins.isSuccess && !app) return null;
  const connected =
    app &&
    personalConnections(connections.data?.connections ?? []).some(
      (row) => row.serverId === app.id,
    );
  return (
    <PageSection
      description="Lets your Bots read and change your repositories as you. You connect this separately from your account above."
      headingRef={heading}
      title="Tools"
    >
      {plugins.isError ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't check whether GitHub tools are available."
          retry={plugins.refetch}
          retryBelow
          retryLabel="Retry GitHub tools"
          retrying={plugins.isFetching}
        />
      ) : !app ? (
        <ReadStatus kind="loading" message="Checking for GitHub tools…" />
      ) : connections.isError ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't check the GitHub tools connection."
          retry={connections.refetch}
          retryBelow
          retryLabel="Retry GitHub tools connection"
          retrying={connections.isFetching}
        />
      ) : (
        <PageRows>
          <Item
            render={<Link params={{ key: app.id }} to="/connections/$key" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconBrandGithub />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>GitHub tools</ItemTitle>
              <ItemDescription>
                {/* Nothing is claimed while the read is out: an unanswered query falls back to an
                  empty list, which read as "Not connected" to somebody with a connection. */}
                {connections.isPending
                  ? "Checking…"
                  : connected
                    ? "Connected"
                    : "Not connected"}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      )}
    </PageSection>
  );
}
