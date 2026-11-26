import { IconBolt, IconPlugOff, IconTool } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, type Ref, useRef, useState } from "react";
import { ConnectionPage } from "@/components/connections/connection-surface";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { appPageTitle } from "@/components/manage/plugin-page";
import {
  SettingsListSearch,
  settingsSearchTerms,
} from "@/components/settings/settings-list-search";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { grantRoster } from "@/lib/agents/grant-roster";
import { type AgentProfile, agentListQueryOptions } from "@/lib/agents/queries";
import { failureMessage } from "@/lib/client";
import { ALWAYS_ON_APP } from "@/lib/connections/rows";
import { useManagePaths } from "@/lib/manage-paths";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  type PluginTool,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * One tool, and which Bots hold it.
 *
 * Its own screen because a grant is a per-Bot decision and there is no upper bound on Bots. The
 * connector page used to draw a chip for every Bot inside every tool row: at three Bots and eight
 * tools that is twenty-four controls stacked in a list, wrapping onto second and third lines, where
 * the thing being decided — does THIS Bot get THIS tool — was the least legible part of it. Here each
 * Bot is one row with one switch, which is the same decision with nothing competing for it.
 *
 * Its routes use `$key_`, which opts them out of nesting under the connector page, so that page stays
 * a page rather than becoming a layout with an outlet.
 */

/** Placeholder rows while the page loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d", "e", "f"];
export function PluginToolPage({
  pluginKey: key,
  listQuery,
  filter = "",
  onFilterChange,
  toolName,
}: {
  pluginKey: string;
  listQuery?: string;
  filter?: string;
  onFilterChange?: (value: string) => void;
  toolName: string;
}) {
  // Routines is every Bot's, in every edition: there is no switch to take it from one.
  const alwaysOn = key === ALWAYS_ON_APP;
  const paths = useManagePaths();
  const plugins = useQuery(pluginsPageQueryOptions());
  const visibleRoster = useQuery(agentListQueryOptions());
  /* The ones this person has hidden, so a grant one of them holds still has its switch here. */
  const hiddenRoster = useQuery(agentListQueryOptions(true));
  const agents = visibleRoster.data;
  const hiddenAgents = hiddenRoster.data;
  const rosterHeading = useRef<HTMLHeadingElement>(null);
  const firstMatch = useRef<HTMLDivElement>(null);
  /*
   * Whether a call from this Bot could be authenticated at all.
   *
   * Its own issued credential, or the deployment's shared one. Separate from the grant: the switch
   * decides whether the tool is offered to the model, this decides whether the call it makes gets
   * past the front door. A Bot with the grant and neither credential produced "May call this tool"
   * beside a tool that refused every call, with no audit row, because the call never arrived.
   */
  const sharedCallback = plugins.data?.botsMayCallBack === true;
  const canCallBack = (bot: { id: string }) =>
    sharedCallback ||
    [...(agents ?? []), ...(hiddenAgents ?? [])].find(
      (one) => one.id === bot.id,
    )?.hasCallbackToken === true;
  /*
   * Granting an action the vendor marks destructive lets a Bot do things that do not come back,
   * so that one direction of the switch asks first. Everything else stays immediate.
   */
  const { requestConfirmation, confirmation: grantConfirmation } =
    useActionConfirmation();
  /**
   * Narrows the Bot list by name. Shown only when the roster is long, which is when finding one in
   * it stops being a scan. shortcut: fixed threshold of 8, raise it when a real roster complains.
   */
  const [localFilter, setLocalFilter] = useState("");
  const botSearch = onFilterChange ? filter : localFilter;
  const setBotSearch = onFilterChange ?? setLocalFilter;

  const server = plugins.isSuccess
    ? plugins.data.servers.find((row) => row.id === key)
    : undefined;
  const tool = server?.tools.find((row) => row.name === toolName);

  const back = {
    // The app's name in every state: a "Plugin" back-trail appears exactly when the read failed.
    label: server?.title ?? appPageTitle(key),
    linkProps: paths.plugin(key, listQuery),
  };

  /* Placeholder rows while the fetch is open, so no sentence asserts anything mid-read. */
  if (plugins.isPending) {
    return (
      <ConnectionPage title={appPageTitle(key)}>
        <div aria-busy="true" aria-label="Loading" role="status">
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <div key={key}>
                <Item size="sm">
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </ItemContent>
                </Item>
                {index !== LOADING_ROWS.length - 1 && <Separator />}
              </div>
            ))}
          </PageRows>
        </div>
      </ConnectionPage>
    );
  }

  /*
   * A plugin list that could not be read is said as that, not as a connector that is not enabled:
   * `isPending` goes false on a failed fetch too, and the sentence below is a claim about this
   * deployment that a request that never came back is no evidence for. The per-Bot grant screen
   * keeps the same guard.
   */
  if (plugins.isError) {
    return (
      <ConnectionPage backButton={back} title={toolName}>
        <ReadError
          message="Couldn't load plugins."
          retry={plugins.refetch}
          retrying={plugins.isFetching}
          retryBelow
        />
      </ConnectionPage>
    );
  }

  if (!tool) {
    return (
      <ConnectionPage
        backButton={back}
        description="This connector has no tool with that name."
        title={toolName}
      >
        {/*
         * Says which of the two it is. A tool disappears from this list when the vendor stops
         * offering it, and that reads very differently from a mistyped address.
         */}
        <PageEmpty
          icon={server ? IconTool : IconPlugOff}
          title={server ? "Tool not found" : "This connector is off"}
        >
          {server
            ? "It may have been removed since the tool list was last refreshed."
            : "Turn it on to see its tools."}
        </PageEmpty>
      </ConnectionPage>
    );
  }

  /*
   * Everybody on the roster, and anybody hidden from it who holds this tool: see `grantRoster`.
   * Named from the roster rows themselves, because the id-to-name lookup other admin screens use is
   * built from the visible roster alone.
   */
  const bots = grantRoster({
    roster: agents ?? [],
    hidden: hiddenAgents ?? [],
    holders: tool.grantedTo,
  }).map((agent) => ({
    id: agent.id,
    name: agent.name,
    hidden: agent.hidden,
  }));
  const terms = settingsSearchTerms(botSearch);
  const shownBots = bots.filter((bot) => {
    const name = bot.name.toLowerCase();
    return terms.every((term) => name.includes(term));
  });

  return (
    <ConnectionPage
      backButton={back}
      description={tool.description || "This tool has no description."}
      title={toolName}
    >
      <PageSection
        description={
          tool.effect === "write"
            ? "This tool changes something at the vendor. Boundaries about writes apply to it."
            : "This tool only reads. Boundaries about writes don't apply to it."
        }
        title="What it does"
      >
        <PageRows>
          {/*
           * Read-only, and the layout skill's third row kind is right here: there is one of it, it is
           * the fact the section exists to state, and nothing about it is switchable. The effect
           * comes from the vendor's own classification, not from the tool's name.
           */}
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Effect</ItemTitle>
              <ItemDescription className="line-clamp-none">
                The connector classifies this action. Unknown effects count as
                writes.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span
                className={
                  tool.effect === "write"
                    ? "text-amber-700 text-xs dark:text-amber-400"
                    : "text-muted-foreground text-xs"
                }
              >
                {tool.effect === "write" ? "Changes things" : "Reads"}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description="A Bot can call this tool only while its switch is on. Turning it off applies from the next call."
        headingRef={rosterHeading}
        title="Bots"
      >
        {visibleRoster.isError || hiddenRoster.isError ? (
          <ReadError
            focusAfterRetry={() => rosterHeading.current}
            message="Couldn’t load the Bot list"
            retry={() =>
              Promise.all([visibleRoster.refetch(), hiddenRoster.refetch()])
            }
            retryBelow
            retryLabel="Retry Bot list"
            retrying={visibleRoster.isFetching || hiddenRoster.isFetching}
          />
        ) : visibleRoster.isPending || hiddenRoster.isPending ? (
          <ReadStatus kind="loading" message="Loading Bots…" />
        ) : bots.length === 0 ? (
          <PageEmpty icon={IconBolt} title="No Bots yet">
            Create one to give it this tool.
          </PageEmpty>
        ) : (
          <>
            {bots.length > 8 || botSearch.trim() ? (
              <SettingsListSearch
                noun="Bots"
                placeholder="Bot name"
                value={botSearch}
                onChange={setBotSearch}
                onEnter={() => firstMatch.current?.focus()}
                matches={shownBots.length}
                total={bots.length}
              />
            ) : null}
            {shownBots.length ? (
              <PageRows>
                {shownBots.map((bot, index) => (
                  <Fragment key={bot.id}>
                    {index > 0 ? <Separator /> : null}
                    <ToolGrantRow
                      alwaysOn={alwaysOn}
                      auditLabel={paths.auditLabel}
                      bot={bot}
                      canCallBack={canCallBack(bot)}
                      titleRef={index === 0 ? firstMatch : undefined}
                      requestConfirmation={requestConfirmation}
                      tool={tool}
                    />
                  </Fragment>
                ))}
              </PageRows>
            ) : null}
          </>
        )}
      </PageSection>
      {grantConfirmation}
    </ConnectionPage>
  );
}

function ToolGrantRow({
  alwaysOn,
  auditLabel,
  bot,
  canCallBack,
  titleRef,
  requestConfirmation,
  tool,
}: {
  alwaysOn: boolean;
  auditLabel: string;
  bot: Pick<AgentProfile, "id" | "name" | "hidden">;
  canCallBack: boolean;
  titleRef?: Ref<HTMLDivElement>;
  requestConfirmation: ReturnType<
    typeof useActionConfirmation
  >["requestConfirmation"];
  tool: PluginTool;
}) {
  const queryClient = useQueryClient();
  const setGrant = useMutation(setPluginGrantMutationOptions(queryClient));
  const toggle = useRef<HTMLSpanElement>(null);
  const held = tool.grantedTo.includes(bot.id);
  return (
    <Item size="sm">
      <ItemContent style={{ minInlineSize: 0 }}>
        <ItemTitle
          className="line-clamp-none wrap-anywhere"
          ref={titleRef}
          tabIndex={-1}
        >
          {bot.name}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          {bot.hidden ? "Hidden from your roster. " : ""}
          {held
            ? canCallBack
              ? `Can call this tool. Every call is still checked against boundaries and logged in ${auditLabel}.`
              : "Allowed, but this Bot has no callback token. Every call is refused. Issue one on its page, or set AGENT_TOOL_TOKEN."
            : "Can't call this tool. The Bot never sees it."}
        </ItemDescription>
        {setGrant.error ? (
          <ItemDescription
            className="line-clamp-none text-destructive"
            role="alert"
          >
            {failureMessage(setGrant.error)}
          </ItemDescription>
        ) : setGrant.isPending || setGrant.isSuccess ? (
          <ItemDescription className="line-clamp-none" role="status">
            {setGrant.isPending
              ? "Saving access…"
              : held
                ? "Access is on."
                : "Access is off."}
          </ItemDescription>
        ) : null}
      </ItemContent>
      <ItemActions>
        {alwaysOn ? (
          <ItemDescription>Always on</ItemDescription>
        ) : (
          <Switch
            aria-label={`Let ${bot.name} call ${tool.name}`}
            checked={held}
            aria-disabled={setGrant.isPending}
            className="after:-inset-y-3.5"
            readOnly={setGrant.isPending}
            ref={toggle}
            onCheckedChange={(next) => {
              if (setGrant.isPending) return;
              const change = {
                agentId: bot.id,
                granted: next,
                kind: "mcp" as const,
                ref: tool.ref,
              };
              if (next && tool.destructive) {
                requestConfirmation({
                  title: `Let ${bot.name} call ${tool.name}?`,
                  description: `The vendor warns this action destroys things: what it changes does not come back. ${bot.name} could call it without asking each time.`,
                  confirmLabel: "Allow",
                  pendingLabel: "Allowing…",
                  failureMessage: `Couldn't let ${bot.name} call ${tool.name}. Try again.`,
                  variant: "destructive",
                  trigger: toggle.current ?? undefined,
                  run: async () => {
                    await setGrant.mutateAsync(change);
                  },
                });
              } else {
                setGrant.mutate(change);
              }
            }}
          />
        )}
      </ItemActions>
    </Item>
  );
}
