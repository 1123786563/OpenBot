import {
  IconApps,
  IconBox,
  IconChevronRight,
  IconPlug,
  IconPlus,
} from "@tabler/icons-react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useId, useRef } from "react";
import { HandoffPanel } from "@/components/agents/handoff-panel";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  AppAccessAction,
  appAccessSentence,
} from "@/components/plugins/app-access-action";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  giveBotAppMutationOptions,
  takeBackBotAppMutationOptions,
} from "@/lib/app-access/mutations";
import {
  type AppAccess,
  botAppsQueryOptions,
  type GiveableApp,
  giveableAppsQueryOptions,
} from "@/lib/app-access/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { canKeepCachedRead } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  type GrantedPlugins,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { toolName } from "@/lib/plugins/tool-words";
import { queryClient } from "@/query-client";

/**
 * "google-drive" as "Google Drive": the connector key, said the way a person would.
 *
 * ONLY FOR A CONNECTOR THE APP-ACCESS READ DID NOT NAME. Every app it names is drawn by its own
 * display name — "Gmail", where this would have said "Composio Gmail".
 */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Connector key → the labels of the tools this Bot holds on it.
 *
 * Named as the app's own page lists them (`toolName`), each as a command: "Create goal", where
 * Activity says what was done, "Created a goal". A list that said some of each read as a list of
 * two kinds of thing.
 *
 * Vendors prefix every tool with their own name — "Notion create pages" — which next to a row
 * already titled Notion reads as a stutter. Stripped only as a leading word, and re-cased, so
 * "Notion search" becomes "Search" while "Search notion pages" is left alone.
 */
function connectorTools(plugins: GrantedPlugins): Map<string, string[]> {
  const connectors = new Map<string, string[]>();
  for (const tool of plugins.tools) {
    const key = tool.ref.split("/")[0] ?? tool.ref;
    let label = toolName(key, tool.ref.slice(key.length + 1) || tool.ref);
    const prefix = `${key.toLowerCase()} `;
    if (label.toLowerCase().startsWith(prefix)) {
      const rest = label.slice(prefix.length);
      label = rest ? rest[0]?.toUpperCase() + rest.slice(1) : label;
    }
    connectors.set(key, [...(connectors.get(key) ?? []), label]);
  }
  return connectors;
}

/** How many apps this Bot holds tools on. For the summary on the Bot's page. */
export function connectorCount(plugins: GrantedPlugins): number {
  return connectorTools(plugins).size;
}

/** What this Bot may reach: your skills on it, everything granted to it, and who it may ask. */
export function AccessSections({ agent }: { agent: AgentProfile }) {
  // Every Bot has every connected app in the personal edition, so there is no switch per app here.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const apps = useQuery(botAppsQueryOptions(agent.id));
  return (
    <>
      {apps.error ? (
        <ReadError
          message="Couldn’t check whether each app is ready for you"
          retry={() => apps.refetch()}
          retryBelow
          retrying={apps.isFetching}
        />
      ) : null}
      {agent.mine &&
      !personal &&
      (!apps.error ||
        (canKeepCachedRead(apps.error) && Boolean(apps.data?.length))) ? (
        <YourApps agent={agent} held={apps} key={agent.id} />
      ) : null}
      {agent.mine ? <YourSkills agentId={agent.id} /> : null}
      <Granted agentId={agent.id} apps={apps} mine={agent.mine} />
      {/* Every Bot can ask every other in the personal edition, so there is no switch per Bot. */}
      {personal ? null : <HandoffPanel agentId={agent.id} />}
    </>
  );
}

/**
 * Your own apps, one switch each: the ones you connected that an admin lets owners give, and any you
 * already gave this Bot. Only on your own Bot, for the reason the server gives — see
 * `server/src/plugins/owner-grants.ts`.
 *
 * AN APP AN ADMIN GAVE THIS BOT is drawn switched on and locked. Taking it away is the admin's, and
 * the server would refuse it.
 */
function YourApps({
  agent,
  held,
}: {
  agent: AgentProfile;
  held: UseQueryResult<AppAccess[]>;
}) {
  const giveable = useQuery(giveableAppsQueryOptions());
  const give = useMutation(giveBotAppMutationOptions(queryClient));
  const takeBack = useMutation(takeBackBotAppMutationOptions(queryClient));
  const { confirmation, requestConfirmation } = useActionConfirmation();
  const heading = useRef<HTMLHeadingElement>(null);
  const scopeId = useId();
  const busy = give.isPending || takeBack.isPending || held.isError;
  const states = new Map((held.data ?? []).map((app) => [app.key, app]));
  /*
   * What you could give, and then anything you already gave that no longer is — an account you
   * disconnected since, an app an admin closed to owners — so it can still be switched off here.
   */
  const rows: (GiveableApp & { access?: AppAccess })[] = [
    ...(giveable.data ?? []).map((app) => ({
      ...app,
      access: states.get(app.key),
    })),
    ...(held.data ?? [])
      .filter(
        (app) =>
          app.givenByOwner &&
          !(giveable.data ?? []).some((given) => given.key === app.key),
      )
      .map((app) => ({ ...app, access: app })),
  ];
  return (
    <PageSection
      description="Turning on an external app gives this Bot its read-only actions. Each app shows which account it uses."
      headingRef={heading}
      title="Your apps"
    >
      {confirmation}
      {giveable.isPending || held.isPending ? (
        <ReadStatus kind="loading" message="Loading your apps…" />
      ) : giveable.error ? (
        <ReadError
          message="Couldn’t load your apps"
          retry={() => giveable.refetch()}
          retryBelow
          retrying={giveable.isFetching}
        />
      ) : rows.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/connections" />}
              size="sm"
              variant="outline"
            >
              <IconPlug />
              Connections
            </Button>
          }
          icon={IconApps}
          title="No apps to give yet"
        >
          Connect an app to let your Bots use it.
        </PageEmpty>
      ) : (
        <PageRows>
          {rows.map((app, index) => {
            const granted = app.access?.granted ?? false;
            const locked = granted && !app.access?.givenByOwner;
            const request = give.variables?.app === app.key ? give : undefined;
            const account = appAccountScope[app.account];
            const descriptionId = `${scopeId}-${app.key}`;
            const toggleId = `${descriptionId}-toggle`;
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle className="line-clamp-none break-words">
                      {app.displayName}
                    </ItemTitle>
                    <ItemDescription
                      className="line-clamp-none"
                      id={descriptionId}
                    >
                      {locked ? "An admin gave it to this Bot." : account}
                    </ItemDescription>
                    {request?.error ? (
                      <ItemDescription
                        className="line-clamp-none text-destructive"
                        role="alert"
                      >
                        Couldn’t update access to {app.displayName}.{" "}
                        {request.error.message}
                      </ItemDescription>
                    ) : null}
                    {request?.isPending || request?.isSuccess ? (
                      <ItemDescription
                        className="line-clamp-none"
                        role="status"
                      >
                        {request.isPending
                          ? `Updating access to ${app.displayName}…`
                          : `${app.displayName} access is ${granted ? "on" : "still off"}.`}
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-describedby={descriptionId}
                      aria-disabled={busy || locked}
                      aria-label={`Let ${agent.name} use ${app.displayName}`}
                      checked={granted}
                      className="after:-inset-y-3.5"
                      disabled={locked}
                      id={toggleId}
                      readOnly={busy}
                      onCheckedChange={(next) => {
                        if (busy) return;
                        give.reset();
                        takeBack.reset();
                        const variables = { agentId: agent.id, app: app.key };
                        if (next) {
                          give.mutate(variables);
                          return;
                        }
                        const canGrantAgain = giveable.data?.some(
                          (candidate) => candidate.key === app.key,
                        );
                        requestConfirmation({
                          title: `Remove ${app.displayName} access?`,
                          description: `This removes access you gave ${agent.name}. Access granted by an admin stays in effect.${canGrantAgain ? "" : ` ${app.displayName} is no longer available for you to grant. Ask an administrator if the Bot needs access again.`}`,
                          confirmLabel: "Remove access",
                          pendingLabel: "Removing…",
                          failureMessage: `Couldn't remove ${app.displayName} access. Try again.`,
                          successMessage: `Your ${app.displayName} access grant was removed.`,
                          trigger:
                            document.getElementById(toggleId) ?? undefined,
                          fallbackFocus: () => heading.current,
                          run: async () => {
                            await takeBack.mutateAsync(variables);
                          },
                        });
                      }}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

const appAccountScope: Record<GiveableApp["account"], string> = {
  personal: "Uses the asking person’s connected account.",
  shared: "Uses the team account.",
  deployment: "Uses the workspace connection.",
};

/**
 * Your own skills, one switch each. Only on your own Bot: the server lets a person put their own
 * skill on a Bot they own, and neither half alone is enough.
 *
 * WHICH SKILLS ARE YOURS COMES FROM THE SKILLS PAGE; WHETHER THIS BOT CARRIES ONE, FROM THE BOT'S OWN
 * GRANTS (`GET /api/plugins/for/:agentId`, the read "What it can use" draws from too). That read is
 * where the personal edition gives a Bot every skill the first time it is listed, so it is what
 * gives a Bot made a moment ago its skills. The skills page, read alongside it or earlier, still said
 * the Bot had none, and every switch was drawn off until the page was opened again.
 */
function YourSkills({ agentId }: { agentId: string }) {
  const user = useQuery(currentUserQueryOptions());
  const page = useQuery(pluginsPageQueryOptions());
  const held = useQuery(agentPluginsQueryOptions(agentId));
  const grant = useMutation(setPluginGrantMutationOptions(queryClient));
  const skills = (page.data?.skills ?? []).filter(
    (skill) => user.data && skill.ownerUserId === user.data.id,
  );
  const carried = new Set((held.data?.skills ?? []).map((skill) => skill.slug));
  return (
    <PageSection
      description="Turn on a skill to use it with this Bot. Type / in a conversation to run it."
      title="Your skills"
    >
      {user.isPending || page.isPending || held.isPending ? (
        <ReadStatus kind="loading" message="Loading your skills…" />
      ) : user.error || page.error || held.error ? (
        <ReadError
          message="Couldn’t load your skills"
          retry={() =>
            Promise.all([user.refetch(), page.refetch(), held.refetch()])
          }
          retryBelow
          retrying={user.isFetching || page.isFetching || held.isFetching}
        />
      ) : skills.length === 0 ? (
        <PageEmpty
          action={
            <Button
              render={(props) => <Link {...props} to="/capabilities/skills" />}
              size="sm"
              variant="outline"
            >
              <IconPlus />
              Write a skill
            </Button>
          }
          icon={IconBox}
          title="No skills yet"
        >
          Skills you write show up here.
        </PageEmpty>
      ) : (
        <PageRows>
          {skills.map((skill, index) => {
            const enabled = carried.has(skill.slug);
            const request =
              grant.variables?.ref === skill.slug ? grant : undefined;
            return (
              <Fragment key={skill.slug}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBox />
                  </ItemMedia>
                  {/* By its title, as What it can use names it below; the section says how to run it. */}
                  <ItemContent>
                    <ItemTitle className="line-clamp-none break-words">
                      {skill.title}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {skill.summary}
                    </ItemDescription>
                    {request?.error ? (
                      <ItemDescription
                        className="line-clamp-none text-destructive"
                        role="alert"
                      >
                        Couldn’t update {skill.title}. {request.error.message}
                      </ItemDescription>
                    ) : null}
                    {request?.isPending || request?.isSuccess ? (
                      <ItemDescription
                        className="line-clamp-none"
                        role="status"
                      >
                        {request.isPending
                          ? `Updating ${skill.title}…`
                          : `${skill.title} is ${enabled ? "on" : "off"}.`}
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-disabled={grant.isPending}
                      aria-label={skill.title}
                      checked={enabled}
                      className="after:-inset-y-3.5"
                      readOnly={grant.isPending}
                      onCheckedChange={(granted) =>
                        grant.mutate({
                          agentId,
                          granted,
                          kind: "skill",
                          ref: skill.slug,
                        })
                      }
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

/**
 * Everything this Bot holds, read from the same snapshot a run is offered, and what each app is for
 * the person looking.
 *
 * READ-ONLY FOR GRANTS, NOT FOR THE PERSON'S OWN PART. Apps are granted by an administrator, who gets
 * a link to where that is decided — or, on a Bot you own, by you, under Your apps above. But a Bot that holds Gmail is no use to somebody who has not
 * connected their Gmail, and this list used to say "Gmail · 4 tools" to everybody alike — so each
 * app now says what it is for the person reading (`GET /api/plugins/for/:agentId/apps`) with the one
 * thing they can do about it: Connect, Reconnect, Request access, or Requested. The state is the
 * server's and is drawn as it comes; see `AppAccessAction`.
 *
 * ADMINISTRATORS SEE THEIR OWN STATE HERE TOO, AND NOBODY ELSE'S. The app-access read answers for
 * whoever is asking, exactly as the connections read does, so this cannot become a list of who has
 * connected what.
 */
function Granted({
  agentId,
  apps,
  mine,
}: {
  agentId: string;
  apps: UseQueryResult<AppAccess[]>;
  mine: boolean;
}) {
  const me = useQuery(currentUserQueryOptions()).data;
  const edition =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition ?? "team";
  const plugins = useQuery(agentPluginsQueryOptions(agentId));
  // Both, so no row is drawn without its state and then redrawn with one a moment later.
  if (plugins.isPending || apps.isPending) {
    return (
      <ReadStatus kind="loading" message="Loading what this Bot can use…" />
    );
  }
  if (!plugins.data) {
    return (
      <ReadError
        message="Couldn’t load what this Bot can use"
        retry={() => plugins.refetch()}
        retryBelow
        retrying={plugins.isFetching}
      />
    );
  }
  const admin = me?.role === "admin";
  const tools = connectorTools(plugins.data);
  const states = apps.data ?? [];
  /*
   * Every app the Bot holds a grant for, by the app's own name, and then any connector the grant
   * snapshot names that the app-access read did not — which is none on a healthy deployment, and
   * keeps a row from vanishing on one where the second read failed.
   */
  const described = new Set(states.map((app) => app.key));
  const rest = [...tools.entries()].filter(([key]) => !described.has(key));
  const skills = plugins.data.skills;
  const count = states.length + rest.length + skills.length;
  return (
    <PageSection
      description="Review this Bot’s available apps and skills, and check which apps are ready to use. The Bot cannot use apps or skills outside this list."
      title="What it can use"
    >
      {count === 0 && !apps.error ? (
        <PageEmpty icon={IconApps} title="No apps yet">
          {mine
            ? "Turn one on under Your apps, or ask an admin. Until then this Bot can only talk with you."
            : "An admin has to add them. Until then this Bot can only talk with you."}
        </PageEmpty>
      ) : count > 0 ? (
        <PageRows>
          {states.map((app, index) => {
            const labels = tools.get(app.key) ?? [];
            return (
              <Fragment key={app.key}>
                {index > 0 ? <Separator /> : null}
                <Item data-app={app.key} data-state={app.state} size="sm">
                  <ItemMedia variant="icon">
                    <PluginLogo logo={app.logo} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{app.displayName}</ItemTitle>
                    {/*
                     * Unclamped: the sentence ends on who can fix it, and two lines at a phone's
                     * width cut exactly that off.
                     */}
                    <ItemDescription className="line-clamp-none">
                      {app.state === "ready"
                        ? [appAccessSentence(app, undefined, edition)]
                            .concat(labels.length > 0 ? [toolList(labels)] : [])
                            .join(" ")
                        : appAccessSentence(app, undefined, edition)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {app.state === "ready" ? (
                      <ToolCount count={labels.length} />
                    ) : (
                      <AppAccessAction access={app} agentId={agentId} />
                    )}
                    {admin ? (
                      <ManageLink
                        agentId={agentId}
                        appKey={app.key}
                        title={app.displayName}
                      />
                    ) : null}
                  </ItemActions>
                </Item>
              </Fragment>
            );
          })}
          {rest.map(([key, labels], index) => (
            <Fragment key={key}>
              {states.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconApps />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{connectorName(key)}</ItemTitle>
                  <ItemDescription>{toolList(labels)}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ToolCount count={labels.length} />
                  {admin ? (
                    <ManageLink
                      agentId={agentId}
                      appKey={key}
                      title={connectorName(key)}
                    />
                  ) : null}
                </ItemActions>
              </Item>
            </Fragment>
          ))}
          {skills.map((skill, index) => (
            <Fragment key={skill.slug}>
              {states.length + rest.length + index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBox />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{skill.title}</ItemTitle>
                  <ItemDescription>{skill.summary}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">Skill</span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </PageSection>
  );
}

/** The first few tool labels, and how many more. */
function toolList(labels: string[]): string {
  return `${labels.slice(0, 4).join(", ")}${labels.length > 4 ? ` and ${labels.length - 4} more` : ""}`;
}

function ToolCount({ count }: { count: number }) {
  return (
    <span className="text-muted-foreground text-sm tabular-nums">
      {count} {count === 1 ? "tool" : "tools"}
    </span>
  );
}

/**
 * Where an administrator decides which of the app's tools this Bot holds.
 *
 * A CHEVRON OF ITS OWN RATHER THAN THE WHOLE ROW. The row used to be the link, which was right while
 * it held nothing else; now it can hold Connect or Request access, and a button inside a link is two
 * controls answering one click. The destination is unchanged.
 */
function ManageLink({
  agentId,
  appKey,
  title,
}: {
  agentId: string;
  appKey: string;
  title: string;
}) {
  const paths = useManagePaths();
  return (
    <Button
      aria-label={`Manage ${title} on this Bot`}
      render={<Link {...paths.pluginBot(appKey, agentId)} />}
      size="icon-sm"
      variant="ghost"
    >
      <IconChevronRight className="size-4 text-muted-foreground" />
    </Button>
  );
}
