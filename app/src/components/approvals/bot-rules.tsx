import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  ApprovalsUnavailableError,
  scopedApprovalInboxOptions,
  createApprovalRuleMutationOptions,
  revokeApprovalRuleMutationOptions,
  ruleCoversBot,
  updateApprovalRuleMutationOptions,
} from "@/lib/approvals";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { RuleForm, RuleRow } from "./rules";

/**
 * The person's approval rules for one Bot, and the team rules that reach it, locked, as one card of
 * rows ending in the row that adds one. Rules for every Bot are in Settings → Approvals. A rule's
 * `botId` is the Bot's id, or a pattern covering it.
 */
export function BotApprovalRules({ agentId }: { agentId: string }) {
  const { t } = useTranslation("approvals");
  // The rules read and every rule write ride the scope this screen holds (MT086); a scope that
  // refuses says so in one line instead of drawing an unlocked-looking list over a refusal.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const inbox = useQuery(scopedApprovalInboxOptions(queryClient, scope));
  const addRule = useMutation(
    createApprovalRuleMutationOptions(queryClient, scope),
  );
  const changeRule = useMutation(
    updateApprovalRuleMutationOptions(queryClient, scope),
  );
  const revoke = useMutation(
    revokeApprovalRuleMutationOptions(queryClient, scope),
  );
  const error = inbox.error ?? changeRule.error ?? revoke.error;
  if (inbox.isPending && !error) return null;
  const rulesOff = inbox.data?.team?.customRulesEnabled === false;
  // Rules naming this Bot, including a pattern that covers it; rules for every Bot are in Settings.
  const mine = (inbox.data?.rules ?? []).filter(
    (rule) => rule.botId !== "*" && ruleCoversBot(rule.botId, agentId),
  );
  const team = (inbox.data?.teamRules ?? []).filter(
    (rule) => rule.botId === "*" || rule.botId === agentId,
  );
  const canAdd = Boolean(inbox.data?.preferences) && !rulesOff;
  const saved = team.length + mine.length;

  if (inbox.error instanceof ApprovalsUnavailableError) {
    return (
      <p
        className="mt-6 text-muted-foreground text-sm"
        data-testid="approvals-unavailable"
      >
        {t("unavailable")}
      </p>
    );
  }
  return (
    <PageSection
      description={
        <>
          <Trans
            components={{
              link: (
                <Link
                  className="underline underline-offset-4"
                  to="/settings/approvals"
                />
              ),
            }}
            i18nKey="rules.botDescription"
            t={t}
          />
          {rulesOff ? t("rules.offNote") : ""}
        </>
      }
      title={t("rules.title")}
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {saved === 0 ? <PageEmpty>{t("rules.noneForBot")}</PageEmpty> : null}
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
                disabled={revoke.isPending || changeRule.isPending}
                locked={rulesOff}
                onChange={(behaviour) =>
                  changeRule.mutate({ id: rule.id, behaviour })
                }
                onRevoke={() => revoke.mutate(rule.id)}
                rule={rule}
              />
            </Fragment>
          ))}
          {canAdd ? (
            <>
              {saved > 0 ? <Separator /> : null}
              <RuleForm
                botField={false}
                forBot={agentId}
                label={t("rules.add")}
                save={addRule}
              />
            </>
          ) : null}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
