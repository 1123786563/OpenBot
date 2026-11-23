import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { IconChecklist, IconChevronRight, IconPlus } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";

import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadStatus } from "@/components/layout/read-status";
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
  responsibilitiesQueryOptions,
  triggersQueryOptions,
} from "@/lib/responsibilities";
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
export function BotResponsibilities({
  agentId,
  sectionTitle = "Goals",
}: {
  agentId?: string;
  sectionTitle?: string;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  function start(event: React.MouseEvent<HTMLButtonElement>) {
    trigger.current = event.currentTarget;
    setCreating(true);
  }
  const goals = useQuery(responsibilitiesQueryOptions());
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const shown = (goals.data ?? []).filter(
    (goal) => agentId === undefined || goal.agentId === agentId,
  );
  // Looked up from the query rather than held, so the dialog follows every refetch.
  const open = shown.find((goal) => goal.id === openId);
  return (
    <PageSection
      action={
        <AstryxButton
          icon={<IconPlus aria-hidden size={16} />}
          label="New goal"
          onClick={start}
          variant="primary"
        />
      }
      title={sectionTitle}
    >
      {goals.isPending ? (
        <ReadStatus kind="loading" message="Loading Goals…" />
      ) : goals.error ? (
        <ReadStatus
          kind="error"
          message="Couldn’t load Goals"
          retry={goals.refetch}
        />
      ) : shown.length === 0 ? (
        <PageEmpty icon={IconChecklist} title="No goals yet">
          {agentId
            ? "Work you give this Bot to keep doing shows up here."
            : "Work you give your Bots to keep doing shows up here."}
        </PageEmpty>
      ) : (
        <PageRows>
          {shown.map((goal, index) => (
            <Fragment key={goal.id}>
              {index > 0 ? <Separator /> : null}
              <ResponsibilityRow
                goal={goal}
                onOpen={(event) => {
                  trigger.current = event.currentTarget;
                  setOpenId(goal.id);
                }}
              />
            </Fragment>
          ))}
        </PageRows>
      )}
      {creating ? (
        <NewResponsibilityDialog
          agentId={agentId}
          returnFocus={trigger}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {open ? (
        <ResponsibilityDialog
          goal={open}
          key={open.id}
          returnFocus={trigger}
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
  onOpen: React.MouseEventHandler<HTMLButtonElement>;
}) {
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const Icon = STATUS[goal.status].icon;
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{goal.title}</ItemTitle>
        <ItemDescription>{summaryFor(goal, triggers.data)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
