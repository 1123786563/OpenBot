import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import { handoffRoster } from "@/lib/agents/handoff-roster";
import { setHandoffGrantMutationOptions } from "@/lib/agents/mutations";
import {
  agentHandoffQueryOptions,
  agentListQueryOptions,
} from "@/lib/agents/queries";

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
 * One Item per candidate, with a Switch: the grant is one boolean that takes effect when switched,
 * which is exactly the row kind a Switch means everywhere else in this app.
 */
export function HandoffPanel({ agentId }: { agentId: string }) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const handoff = useQuery(agentHandoffQueryOptions(agentId));
  const agents = useQuery(agentListQueryOptions());
  /*
   * The roster this person has hidden, read so a grant pointing into it can still be taken away.
   *
   * Hiding is a per-person display preference and the grants are not filtered by it at all, so
   * joining the grants against the visible roster alone dropped live grants off the only screen that
   * manages them. See `handoffRoster`, which is where that join now happens.
   */
  const hiddenAgents = useQuery(agentListQueryOptions(true));
  const setGrant = useMutation(setHandoffGrantMutationOptions(queryClient));

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
    <section className="grid gap-2">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {t("handoff.title")}
        </h2>
        {/* The current answer at a glance, so the list below is detail rather than homework. */}
        {grantable && total > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("handoff.grantedOf", { granted, total })}
          </span>
        ) : null}
      </header>

      <p className="text-muted-foreground text-sm">{t("handoff.intro")}</p>

      {enabled ? null : (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{t("handoff.switchedOff")}</ItemTitle>
            {/*
             * Unclamped: `ItemDescription` clips to two lines, which is right for a roster row
             * whose description is a subtitle and wrong for an item that exists to explain. The
             * sentence that gets cut is the one saying what to do about it.
             */}
            <ItemDescription className="line-clamp-none">
              {t("handoff.switchedOffDescription")}
            </ItemDescription>
          </ItemContent>
        </Item>
      )}

      {grantable ? null : (
        <Item variant="muted">
          <ItemContent>
            <ItemTitle>{t("handoff.cannotGrant")}</ItemTitle>
            {/* Unclamped for the same reason as above: three lines, and the third is the useful one. */}
            <ItemDescription className="line-clamp-none">
              {t("handoff.cannotGrantDescription")}
            </ItemDescription>
          </ItemContent>
        </Item>
      )}

      {setGrant.error ? (
        <p className="text-destructive text-sm" role="alert">
          {setGrant.error.message}
        </p>
      ) : null}

      {grantable && total === 0 ? (
        <Empty className="h-[180px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              {t("handoff.noOthers")}
            </EmptyTitle>
            <EmptyDescription>
              {t("handoff.noOthersDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {candidates.length > 0 ? (
        <div className="flex flex-col gap-2">
          {candidates.map((candidate) => (
            <Item key={candidate.id} size="sm" variant="muted">
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
                  aria-label={t("handoff.letAsk", { name: candidate.name })}
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
          ))}
        </div>
      ) : null}

      {canGrant ? null : (
        <p className="text-muted-foreground text-xs">
          {t("handoff.adminDecides")}
        </p>
      )}
    </section>
  );
}
