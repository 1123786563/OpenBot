import { IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  type ResponsibilityRecord,
  ResponsibilitiesUnavailableError,
  scopedResponsibilitiesQueryOptions,
  triggersQueryOptions,
} from "@/lib/responsibilities";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { NewResponsibilityDialog } from "./new-responsibility-dialog";
import {
  ResponsibilityDialog,
  STATUS,
  summaryFor,
} from "./responsibility-dialog";

/**
 * Lasting goals and their runs. Given a Bot, only that Bot's, and a new one is that Bot's without
 * asking. The list is the person's whole set, capped at 100 by the server across all their Bots, so
 * a Bot page filters it here rather than asking for a second list.
 *
 * One row per responsibility, saying where it stands; everything else about it — its wording, its
 * triggers, its runs, pausing and completing it — is in the dialog the row opens, because that is
 * many values and a settings screen that edits many values in place turns back into a form.
 */
export function BotResponsibilities({ agentId }: { agentId?: string }) {
  const { t } = useTranslation("routines");
  // The list rides the scope this screen holds (MT086): keyed under the scope's own prefix,
  // carrying the pair, and refused — as one explicit state — when the scope does.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const goals = useQuery(
    scopedResponsibilitiesQueryOptions(queryClient, scope),
  );
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = (goals.data ?? []).filter(
    (goal) => agentId === undefined || goal.agentId === agentId,
  );
  // Looked up from the query rather than held, so the dialog follows every refetch.
  const open = shown.find((goal) => goal.id === openId);
  if (goals.error instanceof ResponsibilitiesUnavailableError) {
    return (
      <p
        className="mt-6 text-muted-foreground text-sm"
        data-testid="responsibilities-unavailable"
      >
        {t("responsibilities.unavailable")}
      </p>
    );
  }
  return (
    <PageSection
      action={
        <Button onClick={() => setCreating(true)} size="sm" variant="ghost">
          <IconPlus />
          {t("responsibilities.new.heading")}
        </Button>
      }
      title={t("responsibilities.title")}
    >
      {/* Pending, error, empty, rows — pending first, so no sentence asserts anything mid-fetch. */}
      {goals.isPending ? null : goals.error ? (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {goals.error.message}
        </p>
      ) : shown.length === 0 ? (
        <PageEmpty>
          {agentId
            ? t("responsibilities.emptyForBot")
            : t("responsibilities.empty")}
        </PageEmpty>
      ) : (
        <PageRows>
          {shown.map((goal, index) => (
            <Fragment key={goal.id}>
              {index > 0 ? <Separator /> : null}
              <ResponsibilityRow
                goal={goal}
                onOpen={() => setOpenId(goal.id)}
              />
            </Fragment>
          ))}
        </PageRows>
      )}
      {creating ? (
        <NewResponsibilityDialog
          agentId={agentId}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {open ? (
        <ResponsibilityDialog
          goal={open}
          key={open.id}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </PageSection>
  );
}

/**
 * A responsibility's row: its title, and its state and what starts it as the summary. A chevron
 * rather than a Switch, although pausing is binary: the row opens a dialog, and a Switch inside a
 * row that is itself a button would be a control nested in a control.
 */
function ResponsibilityRow({
  goal,
  onOpen,
}: {
  goal: ResponsibilityRecord;
  onOpen: () => void;
}) {
  const { t } = useTranslation("routines");
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const Icon = STATUS[goal.status].icon;
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{goal.title}</ItemTitle>
        <ItemDescription>{summaryFor(t, goal, triggers.data)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
