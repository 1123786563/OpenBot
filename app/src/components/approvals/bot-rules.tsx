import { ruleTitle } from "@openbot/shared/tool-name";
import { IconChecklist } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useRef } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  approvalInboxOptions,
  type ApprovalRuleRow,
  BEHAVIOUR_LABELS,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { canKeepCachedRead } from "@/lib/client";
import { queryClient } from "@/query-client";
import { RuleForm, RuleRow, ruleRowId } from "./rules";

/**
 * The person's approval rules for one Bot, and the team rules that reach it, locked, as one card of
 * rows ending in the row that adds one. Rules for every Bot are in Settings → Approvals. A rule's
 * `botId` is the Bot's id, or a pattern covering it.
 */
export function BotApprovalRules({ agentId }: { agentId: string }) {
  const inbox = useQuery(approvalInboxOptions());
  const addRule = useMutation(createApprovalRuleMutationOptions(queryClient));
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient),
  );
  const revoke = useMutation(revokeApprovalRuleMutationOptions(queryClient));
  const error = changeRule.error;
  const { confirmation, requestConfirmation } = useActionConfirmation();
  const heading = useRef<HTMLHeadingElement>(null);
  const data = canKeepCachedRead(inbox.error) ? inbox.data : undefined;
  const rulesOff = data?.team?.customRulesEnabled === false;
  // Rules naming this Bot, including a pattern that covers it; rules for every Bot are in Settings.
  const mine = (data?.rules ?? []).filter(
    (rule) => rule.botId !== "*" && ruleCoversBot(rule.botId, agentId),
  );
  const team = (data?.teamRules ?? []).filter(
    (rule) => rule.botId === "*" || rule.botId === agentId,
  );
  const canAdd = Boolean(data?.preferences) && !rulesOff;
  const saved = team.length + mine.length;

  function confirmRemoval(rule: ApprovalRuleRow, trigger: HTMLButtonElement) {
    const { title } = ruleTitle(rule);
    const index = mine.findIndex((candidate) => candidate.id === rule.id);
    const neighbour = mine[index + 1] ?? mine[index - 1];
    const scope = [
      rule.botId.includes("*") ? `Bots matching ${rule.botId}` : "this Bot",
      rule.scope !== "*" && `scope ${rule.scope}`,
      rule.account && `account ${rule.account}`,
      rule.effect !== "*" && rule.effect,
    ]
      .filter(Boolean)
      .join(", ");
    requestConfirmation({
      title: `Remove the rule for ${title}?`,
      description: `The current rule is “${BEHAVIOUR_LABELS[rule.behaviour]}” for ${scope}. After removal, other matching rules and defaults determine what happens.`,
      confirmLabel: "Remove rule",
      pendingLabel: "Removing…",
      failureMessage: "Couldn't remove this rule. Try again.",
      successMessage: "Rule removed.",
      trigger,
      fallbackFocus: () =>
        (neighbour && document.getElementById(ruleRowId(neighbour.id))) ||
        heading.current,
      run: async () => {
        const latest = await inbox.refetch({ throwOnError: true });
        const current = latest.data?.rules.find(
          (candidate) => candidate.id === rule.id,
        );
        if (
          latest.data?.team?.customRulesEnabled === false ||
          !current ||
          current.behaviour !== rule.behaviour ||
          current.toolRef !== rule.toolRef ||
          current.scope !== rule.scope ||
          current.botId !== rule.botId ||
          current.account !== rule.account ||
          current.effect !== rule.effect
        ) {
          throw new ActionUnavailable(
            "This rule changed or is no longer available. Review the current rules before removing it.",
          );
        }
        await revoke.mutateAsync(rule.id);
      },
    });
  }

  return (
    <PageSection
      description={
        <>
          The strictest matching rule wins. An "ask" rule beats an "allow" rule.
          Rules for every Bot are in{" "}
          <Link
            className="underline underline-offset-4"
            to="/settings/approvals"
          >
            Settings → Approvals
          </Link>
          .
          {rulesOff
            ? " An admin has turned off personal rules. Yours are kept but don't apply."
            : ""}
        </>
      }
      headingRef={heading}
      title="Rules"
    >
      {confirmation}
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {inbox.isPending ? (
        <ReadStatus kind="loading" message="Loading approval rules…" />
      ) : inbox.error ? (
        <ReadError
          description={
            data
              ? "Showing the last loaded rules. Refresh to make changes."
              : undefined
          }
          focusAfterRetry={() => heading.current}
          message={
            data
              ? "Couldn’t refresh approval rules"
              : "Couldn’t load approval rules"
          }
          retry={inbox.refetch}
          retryBelow
          retryLabel="Retry approval rules"
          retrying={inbox.isFetching}
        />
      ) : saved === 0 ? (
        <PageEmpty icon={IconChecklist} title="No rules for this Bot" />
      ) : null}
      {saved > 0 || canAdd ? (
        <PageRows>
          {team.map((rule, index) => (
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
          {mine.map((rule, index) => (
            <Fragment key={rule.id}>
              {team.length + index > 0 ? <Separator /> : null}
              <RuleRow
                disabled={
                  !inbox.isSuccess || revoke.isPending || changeRule.isPending
                }
                locked={rulesOff}
                onChange={(behaviour) =>
                  changeRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={(trigger) => confirmRemoval(rule, trigger)}
                rule={rule}
                touchTargets
              />
            </Fragment>
          ))}
          {canAdd ? (
            <>
              {saved > 0 ? <Separator /> : null}
              <RuleForm
                botField={false}
                canSave={inbox.isSuccess}
                forBot={agentId}
                label="Add a rule"
                refreshSettings={inbox.refetch}
                save={addRule}
              />
            </>
          ) : null}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
