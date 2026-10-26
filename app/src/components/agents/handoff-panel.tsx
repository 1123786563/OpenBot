import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import { handoffRoster } from "@/lib/agents/handoff-roster";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  scopedAgentHandoffQueryOptions,
  scopedAgentListQueryOptions,
} from "@/lib/agents/queries";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { queryClient } from "@/query-client";

/**
 * Which Bots this one may hand work to.
 *
 * On the Bot's own screen rather than in the connector catalogue: a catalogue entry has a fixed list
 * of tools somebody else maintains, and the Bots a deployment has are whatever was made here. It is
 * also the question a person asks while looking at a Bot, not while looking at a vendor.
 *
 * DIRECTIONAL, and said so on the screen, because the pair is the one thing about this that is easy
 * to get backwards: this is who this Bot may ask, not who may ask it.
 *
 * One row per candidate, with a Switch: the grant is one boolean that takes effect when switched,
 * which is exactly the row kind a Switch means everywhere else in this app. A whole page section of
 * its own, and nothing at all when there is nothing to say to somebody who cannot change it.
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const { t } = useTranslation("agents");
  // Every read and write here rides the scope the screen holds (MOD19 / Issue #639, T1b): keyed
  // under the scope's own prefix, carrying the selection pair, refused when the selection moved.
  const scope = useScopedCache();
  const handoff = useQuery(scopedAgentHandoffQueryOptions(queryClient, scope, agentId));
  const agents = useQuery(scopedAgentListQueryOptions(queryClient, scope));
  /*
   * The roster this person has hidden, read so a grant pointing into it can still be taken away.
   *
   * Hiding is a per-person display preference and the grants are not filtered by it at all, so
   * joining the grants against the visible roster alone dropped live grants off the only screen that
   * manages them. See `handoffRoster`, which is where that join now happens.
   */
  const hiddenAgents = useQuery(scopedAgentListQueryOptions(queryClient, scope, true));
  const setGrant = useMutation(
    setHandoffGrantMutationOptions(queryClient, scope),
  );

  if (handoff.isPending || !handoff.data) return null;
  const { enabled, canGrant, reachable, grantable } = handoff.data;

  // A Bot may not be granted itself, and the server refuses it, so it is not offered here either.
  const { candidates, granted, total } = handoffRoster({
    agentId,
    roster: agents.data ?? [],
    hidden: hiddenAgents.data ?? [],
    reachable,
    grantable,
  });

  // Nothing to say to somebody who cannot change it and has nothing to read.
  if (!canGrant && reachable.length === 0) return null;

  return (
    <PageSection
      action={
        /* The current answer at a glance, so the list below is detail rather than homework. */
        grantable && total > 0 ? (
          <span className="text-muted-foreground text-sm tabular-nums">
            {t("handoff.grantedOf", { granted, total })}
          </span>
        ) : null
      }
      description={t("handoff.intro")}
      title={t("handoff.title")}
    >
      {/* Facts about the deployment rather than rows to act on, so said as sentences. */}
      {enabled ? null : (
        <PageEmpty>
          {t("handoff.switchedOff")} {t("handoff.switchedOffDescription")}
        </PageEmpty>
      )}

      {grantable ? null : (
        <PageEmpty>
          {t("handoff.cannotGrant")} {t("handoff.cannotGrantDescription")}
        </PageEmpty>
      )}

      {setGrant.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}

      {grantable && total === 0 ? (
        <PageEmpty>
          {t("handoff.noOthers")} {t("handoff.noOthersDescription")}
        </PageEmpty>
      ) : null}
      {candidates.length > 0 ? (
        <PageRows>
          {candidates.map((candidate, index) => (
            <Fragment key={candidate.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia>
                  <AbstractAvatar
                    name={candidate.name}
                    seed={candidate.avatarSeed}
                    size={28}
                  />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{candidate.name}</ItemTitle>
                  {/*
                   * Said on the row, because otherwise it is a coworker that is not on your roster
                   * appearing in a list with no explanation. It is here only because this Bot may
                   * already ask it, and that is the sentence a person needs to decide what to do.
                   */}
                  <ItemDescription>
                    {candidate.hidden
                      ? t("handoff.hiddenFromRoster", {
                          title: candidate.title,
                        })
                      : candidate.title}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label={t("handoff.letAsk", {
                      name: candidate.name,
                    })}
                    checked={reachable.includes(candidate.id)}
                    disabled={!canGrant || setGrant.isPending}
                    onCheckedChange={(next: boolean) =>
                      setGrant.mutate({
                        agentId,
                        ref: candidate.id,
                        granted: next,
                      })
                    }
                  />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : null}

      {canGrant ? null : <PageEmpty>{t("handoff.adminDecides")}</PageEmpty>}
    </PageSection>
  );
}
