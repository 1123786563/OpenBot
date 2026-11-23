import { ruleTitle } from "@openbot/shared/tool-name";
import {
  IconChecklist,
  IconChevronRight,
  IconCreditCard,
  IconEyeCheck,
  IconKey,
  IconLock,
  IconNotes,
  IconSend,
  IconShare,
  IconSparkles,
  IconSpeakerphone,
  IconTerminal2,
  IconTrash,
  IconUserCog,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
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
import {
  type ActionKind,
  type ActionKindPolicy,
  type ApprovalInboxData,
  type ApprovalRuleRow,
  approvalInboxOptions,
  BEHAVIOUR_LABELS,
  createTeamApprovalRuleMutationOptions,
  revokeTeamApprovalRuleMutationOptions,
  type setTeamApprovalSettings,
  teamApprovalSettingsMutationOptions,
  updateTeamApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { ClientError } from "@/lib/client";
import { reviewerGuidanceQueryOptions } from "@/lib/reviewer-guidance/queries";
import { HOST_LABELS, LabelSelect, RuleForm, RuleRow } from "./rules";
import { SharedUseRequests } from "./shared-use-requests";

/** The kinds of action Bots ask about by name, in the order members meet them. */
const ACTION_KIND_ROWS: {
  kind: ActionKind;
  title: string;
  icon: typeof IconSend;
}[] = [
  { kind: "sending", title: "Sending to other people", icon: IconSend },
  { kind: "deleting", title: "Deleting", icon: IconTrash },
  { kind: "sharing", title: "Sharing", icon: IconShare },
  {
    kind: "publishing",
    title: "Posting and publishing",
    icon: IconSpeakerphone,
  },
  { kind: "payments", title: "Paying and buying", icon: IconCreditCard },
  {
    kind: "security_settings",
    title: "Security and access settings",
    icon: IconLock,
  },
  {
    kind: "credentials",
    title: "Passwords and sign-in details",
    icon: IconKey,
  },
];

/** What members can do about one kind of action. Open unless the admin closes it. */
const ACTION_KIND_LABELS: Record<ActionKindPolicy, string> = {
  open: "Members choose",
  ask: "Ask every time",
  hand_off: "Members do it themselves",
};

type TeamSettings = NonNullable<ApprovalInboxData["team"]>;
type TeamSettingsChange = Parameters<typeof setTeamApprovalSettings>[0];

/**
 * What every member's Bots must do, set by an administrator: the team-wide controls, the rules that
 * apply to everyone, and requests to use a shared account. Members read the team rules, locked, in
 * Settings → Approvals.
 */
export function TeamApprovalSettings() {
  const queryClient = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const guidance = useQuery(reviewerGuidanceQueryOptions());
  const team = useMutation(teamApprovalSettingsMutationOptions(queryClient));
  const addTeamRule = useMutation(
    createTeamApprovalRuleMutationOptions(queryClient),
  );
  const changeTeamRule = useMutation(
    updateTeamApprovalRuleMutationOptions(queryClient),
  );
  const revokeTeam = useMutation(
    revokeTeamApprovalRuleMutationOptions(queryClient),
  );
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const error = inbox.error;
  const denied =
    error instanceof ClientError &&
    (error.status === 401 || error.status === 403);
  const inboxData = denied ? undefined : inbox.data;
  const settings = inboxData?.team;
  const teamRules = inboxData?.teamRules ?? [];

  function confirmSetting({
    id,
    title,
    description,
    changed,
    input,
  }: {
    id: string;
    title: string;
    description: string;
    changed: (latest: TeamSettings) => boolean;
    input: TeamSettingsChange;
  }) {
    requestConfirmation({
      title,
      description,
      confirmLabel: "Change team setting",
      pendingLabel: "Saving…",
      failureMessage: "Couldn't change this team setting. Try again.",
      trigger: document.getElementById(id) ?? undefined,
      variant: "default",
      refresh: () => inbox.refetch(),
      run: async () => {
        const { data } = await inbox.refetch({ throwOnError: true });
        if (!data?.team || changed(data.team)) {
          throw new ActionUnavailable(
            "This team setting changed. Close this dialog to review the current setting.",
          );
        }
        await team.mutateAsync(input);
      },
    });
  }

  function confirmRule(
    rule: ApprovalRuleRow,
    behaviour?: ApprovalRuleRow["behaviour"],
  ) {
    const { title } = ruleTitle(rule);
    const target = [
      rule.botId === "*" ? "all Bots" : `Bots matching ${rule.botId}`,
      rule.scope !== "*" && `scope ${rule.scope}`,
      rule.account && `account ${rule.account}`,
    ]
      .filter(Boolean)
      .join(", ");
    requestConfirmation({
      title: behaviour
        ? `Change the team rule for ${title}?`
        : `Remove the team rule for ${title}?`,
      description: behaviour
        ? `For matching actions (${target}), the behaviour changes from “${BEHAVIOUR_LABELS[rule.behaviour]}” to “${BEHAVIOUR_LABELS[behaviour]}”. You can change it again here.`
        : `For matching actions (${target}), other applicable rules and defaults will determine what happens. To restore this rule, add it again.`,
      confirmLabel: behaviour ? "Change rule" : "Remove rule",
      pendingLabel: behaviour ? "Saving…" : "Removing…",
      failureMessage: "Couldn't update this team rule. Try again.",
      trigger:
        document.getElementById(
          `team-rule-${behaviour ? "behaviour" : "remove"}-${rule.id}`,
        ) ?? undefined,
      fallbackFocus: () => document.getElementById("describe-team-rule"),
      variant: behaviour ? "default" : "destructive",
      refresh: () => inbox.refetch(),
      run: async () => {
        const { data } = await inbox.refetch({ throwOnError: true });
        const current = data?.teamRules.find(
          (candidate) => candidate.id === rule.id,
        );
        if (
          !current ||
          current.behaviour !== rule.behaviour ||
          current.toolRef !== rule.toolRef ||
          current.scope !== rule.scope ||
          current.botId !== rule.botId ||
          current.account !== rule.account ||
          current.effect !== rule.effect
        ) {
          throw new ActionUnavailable(
            "This team rule changed or is no longer available. Return to the list to review the current rules.",
          );
        }
        if (behaviour)
          await changeTeamRule.mutateAsync({ id: rule.id, behaviour });
        else await revokeTeam.mutateAsync(rule.id);
      },
    });
  }

  return (
    <>
      {confirmation}
      {inbox.isPending || error ? (
        <section className="mt-6">
          {error ? (
            <ReadError
              description={
                inboxData
                  ? "The settings and rules already loaded are still shown."
                  : undefined
              }
              message="Couldn't load team approval settings."
              retry={inbox.refetch}
              retryBelow
              retrying={inbox.isFetching}
            />
          ) : (
            <ReadStatus
              kind="loading"
              message="Loading team approval settings…"
            />
          )}
        </section>
      ) : null}
      {settings ? (
        <PageSection title="Team settings">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconEyeCheck />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="enforce-auto-review-title">
                  Require auto-review for everyone
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="enforce-auto-review-title"
                  id="enforce-auto-review"
                  checked={settings.enforceAutoReview}
                  disabled={team.isPending}
                  onCheckedChange={(enforceAutoReview) =>
                    confirmSetting({
                      id: "enforce-auto-review",
                      title: enforceAutoReview
                        ? "Require auto-review for everyone?"
                        : "Let members choose auto-review?",
                      description: enforceAutoReview
                        ? "All team members’ approval requests will use auto-review. You can let members choose again here."
                        : "Team members’ own auto-review preferences will apply. You can require it again here.",
                      changed: (latest) =>
                        latest.enforceAutoReview !== settings.enforceAutoReview,
                      input: { enforceAutoReview },
                    })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item render={<Link to="/admin/approvals/guidance" />} size="sm">
              <ItemMedia variant="icon">
                <IconNotes />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Guidance for auto-review</ItemTitle>
                <ItemDescription>
                  {guidance.isPending
                    ? null
                    : guidance.error
                      ? "Couldn't load the guidance."
                      : (guidance.data ??
                        "None. Tell the reviewer what your organization needs a person for.")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconUserCog />
              </ItemMedia>
              <ItemContent>
                <ItemTitle id="custom-rules-title">
                  Let members set personal rules
                </ItemTitle>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-labelledby="custom-rules-title"
                  id="custom-rules"
                  checked={settings.customRulesEnabled}
                  disabled={team.isPending}
                  onCheckedChange={(customRulesEnabled) =>
                    confirmSetting({
                      id: "custom-rules",
                      title: customRulesEnabled
                        ? "Let members use personal rules?"
                        : "Turn off personal rules for members?",
                      description: customRulesEnabled
                        ? "Team members’ saved personal rules can apply again wherever team rules leave that choice to members. You can turn them off here."
                        : "Team members’ personal rules will stop applying. Their rules remain saved and will be available if you turn them back on.",
                      changed: (latest) =>
                        latest.customRulesEnabled !==
                        settings.customRulesEnabled,
                      input: { customRulesEnabled },
                    })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconTerminal2 />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Commands on members' computers, at most</ItemTitle>
                <ItemDescription>
                  A member's own stricter setting still applies.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <LabelSelect
                  id="host-commands-cap"
                  disabled={team.isPending}
                  label="Commands on members' computers, at most"
                  labels={HOST_LABELS}
                  onChange={(hostCommandsCap) =>
                    confirmSetting({
                      id: "host-commands-cap",
                      title: "Change the command limit on members’ computers?",
                      description: `The team limit changes from “${HOST_LABELS[settings.hostCommandsCap]}” to “${HOST_LABELS[hostCommandsCap]}”. A member’s own stricter setting still applies. You can change this limit again here.`,
                      changed: (latest) =>
                        latest.hostCommandsCap !== settings.hostCommandsCap,
                      input: { hostCommandsCap },
                    })
                  }
                  value={settings.hostCommandsCap}
                />
              </ItemActions>
            </Item>
          </PageRows>
        </PageSection>
      ) : null}
      {settings ? (
        <PageSection
          description="Bots ask before these. With Members choose, a member can allow one once, for a conversation, or always. Ask every time leaves only Allow once and Deny."
          title="Actions that ask first"
        >
          <PageRows>
            {ACTION_KIND_ROWS.map(({ kind, title, icon: Icon }, index) => (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Icon />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{title}</ItemTitle>
                  </ItemContent>
                  <ItemActions>
                    <LabelSelect
                      id={`approval-action-${kind}`}
                      disabled={team.isPending}
                      label={title}
                      labels={ACTION_KIND_LABELS}
                      onChange={(policy) =>
                        confirmSetting({
                          id: `approval-action-${kind}`,
                          title: `Change the team policy for ${title.toLowerCase()}?`,
                          description: `For all team members, this policy changes from “${ACTION_KIND_LABELS[settings.actionKinds?.[kind] ?? "open"]}” to “${ACTION_KIND_LABELS[policy]}”. You can change it again here.`,
                          changed: (latest) =>
                            (latest.actionKinds?.[kind] ?? "open") !==
                            (settings.actionKinds?.[kind] ?? "open"),
                          input: { actionKinds: { [kind]: policy } },
                        })
                      }
                      value={settings.actionKinds?.[kind] ?? "open"}
                    />
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      {inboxData ? (
        <PageSection
          description="These apply to every member's Bots. Members can't change them."
          title="Team rules"
        >
          {teamRules.length === 0 ? (
            <PageEmpty icon={IconChecklist} title="No team rules" />
          ) : null}
          <PageRows>
            {teamRules.map((rule) => (
              <Fragment key={rule.id}>
                <RuleRow
                  disabled={revokeTeam.isPending || changeTeamRule.isPending}
                  onChange={(behaviour) => confirmRule(rule, behaviour)}
                  onRevoke={() => confirmRule(rule)}
                  rule={rule}
                  team
                />
                <Separator />
              </Fragment>
            ))}
            <Item
              render={
                <Link id="describe-team-rule" to="/admin/approvals/describe" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconSparkles />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Describe it in words</ItemTitle>
                <ItemDescription>
                  Say what Bots should do, and your model writes the rules.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <IconChevronRight className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
            <Separator />
            <RuleForm label="Add a team rule" save={addTeamRule} />
          </PageRows>
        </PageSection>
      ) : null}
      <SharedUseRequests />
    </>
  );
}
