import { Text } from "@astryxdesign/core/Text";
import {
  IconChecklist,
  IconChevronDown,
  IconEyeCheck,
  IconHandStop,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  approvalAccessDenied,
  approvalInboxOptions,
  approvalPreferencesMutationOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { canKeepCachedRead } from "@/lib/client";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { ALWAYS_ASKS, ASK_FIRST_TITLE, HANDED_TO_YOU } from "./ask-first-copy";
import {
  filterApprovalRules,
  HOST_LABELS,
  LabelSelect,
  RuleForm,
  RuleRow,
  RuleSearch,
} from "./rules";

/**
 * The person's own approval settings: whether their Bots ask before changing things, and the rules
 * that apply to every one of their Bots. Team rules are listed so the person can see them, locked;
 * administrators change them in Admin → Approvals. Rules for a single Bot are on that Bot's page.
 */
export function ApprovalSettings() {
  const queryClient = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const me = useQuery(currentUserQueryOptions()).data;
  // The personal edition has no Admin to point at, and no team for team settings to govern.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const agents = useQuery(agentListQueryOptions());
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const preferences = useMutation(
    approvalPreferencesMutationOptions(queryClient),
  );
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const preferencesHeading = useRef<HTMLHeadingElement>(null);
  const [ruleSearch, setRuleSearch] = useState("");
  const ruleSearchInput = useRef<HTMLInputElement>(null);
  const recoveredFocus = () => preferencesHeading.current;
  const data = canKeepCachedRead(inbox.error) ? inbox.data : undefined;
  if (!data) {
    return inbox.isError ? (
      <ReadError
        description={
          approvalAccessDenied(inbox.error)
            ? "Check that you still have access, then try again."
            : undefined
        }
        focusAfterRetry={recoveredFocus}
        message="Couldn't load your approval settings."
        retry={inbox.refetch}
        retryBelow
        retryLabel="Retry approval settings"
        retrying={inbox.isFetching}
      />
    ) : (
      <ReadStatus kind="loading" message="Loading your approval settings…" />
    );
  }
  const enforced = data.team?.enforceAutoReview ?? false;
  const rulesOff = data.team?.customRulesEnabled === false;
  const everyBot = data.rules.filter((rule) => rule.botId === "*");
  /*
   * Rules that name no Bot this person can open — a Bot since deleted, or a name typed where an id
   * belonged. They are still enforced, so they are listed here where they can be removed.
   */
  const reachable = [...(agents.data ?? []), ...(hiddenAgents.data ?? [])];
  const botRules = data.rules.filter((rule) => rule.botId !== "*");
  const botListsReady = agents.isSuccess && hiddenAgents.isSuccess;
  const otherBots = botListsReady
    ? botRules.filter(
        (rule) =>
          !reachable.some((agent) => ruleCoversBot(rule.botId, agent.id)),
      )
    : [];
  const teamRules = data.teamRules ?? [];
  const canAdd = Boolean(data.preferences) && !rulesOff;
  const preferencesDisabled = !inbox.isSuccess || preferences.isPending;
  const rulesDisabled =
    !inbox.isSuccess || revoke.isPending || changeRule.isPending;
  const ruleError = changeRule.error ?? revoke.error;
  const saved = teamRules.length + everyBot.length;
  const botName = (id: string) =>
    reachable.find((bot) => bot.id === id)?.name ?? id;
  const matchingTeamRules = filterApprovalRules(
    teamRules,
    ruleSearch,
    botName,
    true,
  );
  const matchingPersonalRules = filterApprovalRules(
    everyBot,
    ruleSearch,
    botName,
  );

  return (
    <>
      {inbox.isError ? (
        <ReadError
          focusAfterRetry={recoveredFocus}
          message="Couldn't refresh your approval settings."
          description="These are your last loaded settings. Retry the check before changing them."
          retry={inbox.refetch}
          retryBelow
          retryLabel="Retry approval settings"
          retrying={inbox.isFetching}
        />
      ) : null}
      {me?.role === "admin" && !personal ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Team settings and shared account requests are in{" "}
          <Link className="underline underline-offset-4" to="/admin/approvals">
            Admin → Approvals
          </Link>
          .
        </p>
      ) : null}
      <PageSection headingRef={preferencesHeading} title="Before a Bot acts">
        <details className="group text-muted-foreground text-sm">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 hover:text-foreground">
            When Bots ask by default
            <IconChevronDown
              aria-hidden="true"
              className="size-4 shrink-0 group-open:rotate-180"
            />
          </summary>
          <p>
            {ALWAYS_ASKS} They also ask before every edit or command in a folder
            on your own computer. {HANDED_TO_YOU} Bots can create, edit, and
            delete files in their own workspace without asking, unless your
            settings or rules say so.
          </p>
        </details>
        {preferences.error ? (
          <ReadError
            message="Couldn't save your approval preference."
            description={preferences.error.message}
            retryLabel={
              inbox.isSuccess ? "Try saving again" : "Reload settings"
            }
            retry={() => {
              if (!inbox.isSuccess) return inbox.refetch();
              if (preferences.variables)
                preferences.mutate(preferences.variables);
            }}
          />
        ) : null}
        <PageRows>
          <Item size="sm">
            <ItemMedia className="self-start" variant="icon">
              <IconHandStop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{ASK_FIRST_TITLE}</ItemTitle>
              <Text
                as="p"
                color="secondary"
                id="extra-vigilant-description"
                size="sm"
              >
                Ask before changes that your rules haven’t already decided,
                including routine edits.
              </Text>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-describedby="extra-vigilant-description"
                aria-label={ASK_FIRST_TITLE}
                checked={data.enabled}
                className="after:top-1/2 after:bottom-auto after:h-11 after:-translate-y-1/2"
                disabled={preferencesDisabled}
                onCheckedChange={(enabled) => preferences.mutate({ enabled })}
              />
            </ItemActions>
          </Item>
          {data.preferences ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia className="self-start" variant="icon">
                  <IconEyeCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle id="auto-review-title">Auto-review</ItemTitle>
                  <Text
                    as="p"
                    color="secondary"
                    id="auto-review-description"
                    size="sm"
                  >
                    {enforced ? "An admin requires this. " : ""}
                    Checks actions that could affect your accounts or share
                    information against your request and rules. It can ask for
                    approval or hand the action to you, even if Extra vigilant
                    is off.
                  </Text>
                </ItemContent>
                <ItemActions>
                  <Switch
                    // Named by its title alone and described by the sentence beside it, so the name
                    // stays short however long the description grows.
                    aria-describedby="auto-review-description"
                    aria-labelledby="auto-review-title"
                    checked={enforced || data.preferences.autoReview}
                    className="after:top-1/2 after:bottom-auto after:h-11 after:-translate-y-1/2"
                    disabled={enforced || preferencesDisabled}
                    onCheckedChange={(autoReview) =>
                      preferences.mutate({ autoReview })
                    }
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item className="flex-wrap items-start" size="sm">
                <ItemContent className="min-w-0 basis-56">
                  <ItemTitle className="line-clamp-none">
                    <IconTerminal2 aria-hidden className="size-4 shrink-0" />
                    Commands on your computer
                  </ItemTitle>
                  <Text as="p" color="secondary" size="sm">
                    {data.hostCommands &&
                    data.hostCommands !== data.preferences.hostCommands
                      ? `An admin limits this to "${HOST_LABELS[data.hostCommands]}". `
                      : ""}
                    The OpenBot desktop app still shows you each command before
                    it runs.
                  </Text>
                </ItemContent>
                <ItemActions>
                  <LabelSelect
                    className="min-h-11"
                    disabled={preferencesDisabled}
                    label="Commands on your computer"
                    labels={HOST_LABELS}
                    onChange={(hostCommands) =>
                      preferences.mutate({ hostCommands })
                    }
                    value={data.preferences.hostCommands}
                  />
                </ItemActions>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      <PageSection
        description={
          <>
            The strictest matching rule wins. An "ask" rule beats an "allow"
            rule.{personal ? " " : " Team rules are locked. "}Rules for one Bot
            are on{" "}
            <Link className="underline underline-offset-4" to="/bots">
              that Bot's page
            </Link>
            .
            {rulesOff
              ? " An admin has turned off personal rules. Yours are kept but don't apply."
              : ""}
          </>
        }
        title="Rules for every Bot"
      >
        {ruleError ? (
          <p className="text-destructive text-sm" role="alert">
            {ruleError.message} Review the rule and try the change again.
          </p>
        ) : null}
        {saved === 0 ? (
          <PageEmpty icon={IconChecklist} title="No rules yet" />
        ) : null}
        {canAdd ? (
          <PageRows>
            <RuleForm
              botField={false}
              canSave={inbox.isSuccess}
              label="Add a rule"
              refreshSettings={inbox.refetch}
              save={addRule}
            />
          </PageRows>
        ) : null}
        <RuleSearch
          emptyTitle="No matching rules"
          first={matchingTeamRules[0] ?? matchingPersonalRules[0]}
          inputRef={ruleSearchInput}
          label="Search rules for every Bot"
          matches={matchingTeamRules.length + matchingPersonalRules.length}
          onChange={setRuleSearch}
          team={matchingTeamRules.length > 0}
          total={saved}
          value={ruleSearch}
        />
        {matchingTeamRules.length + matchingPersonalRules.length > 0 ? (
          <PageRows>
            {matchingTeamRules.map((rule, index) => (
              <Fragment key={rule.id}>
                {index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled
                  locked
                  onChange={() => {}}
                  onRevoke={() => {}}
                  rule={rule}
                  team
                />
              </Fragment>
            ))}
            {matchingPersonalRules.map((rule, index) => (
              <Fragment key={rule.id}>
                {matchingTeamRules.length + index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled={rulesDisabled}
                  locked={rulesOff}
                  onChange={(behaviour) =>
                    changeRule.mutate({ id: rule.id, behaviour })
                  }
                  onRevoke={() => revoke.mutate(rule.id)}
                  rule={rule}
                  touchTargets
                />
              </Fragment>
            ))}
          </PageRows>
        ) : null}
      </PageSection>
      {otherBots.length > 0 ? (
        <PageSection
          description="These don't match a Bot you can open. They still apply to any Bot they match. Remove the ones you don't want."
          title="Rules for other Bots"
        >
          <PageRows>
            {otherBots.map((rule, index) => (
              <Fragment key={rule.id}>
                {index > 0 ? <Separator /> : null}
                <RuleRow
                  disabled={rulesDisabled}
                  locked={rulesOff}
                  onChange={(behaviour) =>
                    changeRule.mutate({ id: rule.id, behaviour })
                  }
                  onRevoke={() => revoke.mutate(rule.id)}
                  rule={rule}
                />
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      {botRules.length > 0 && !botListsReady ? (
        <PageSection title="Rules for other Bots">
          {agents.isError || hiddenAgents.isError ? (
            <ReadError
              message="Couldn't check which Bots these rules apply to."
              retry={() =>
                Promise.all([agents.refetch(), hiddenAgents.refetch()])
              }
              retrying={agents.isFetching || hiddenAgents.isFetching}
            />
          ) : (
            <ReadStatus
              kind="loading"
              message="Checking which Bots have rules…"
            />
          )}
        </PageSection>
      ) : null}
    </>
  );
}
