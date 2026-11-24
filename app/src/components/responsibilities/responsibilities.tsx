import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import {
  IconChecklist,
  IconChevronRight,
  IconListSearch,
  IconPlus,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
  Fragment,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { canKeepCachedRead } from "@/lib/client";
import {
  goalsAccessDenied,
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
  botName,
  pageHeading,
  sectionTitle = "Goals",
  searchable = false,
}: {
  agentId?: string;
  botName?: (id: string) => string;
  pageHeading?: RefObject<HTMLHeadingElement | null>;
  sectionTitle?: string;
  searchable?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  function start(event: React.MouseEvent<HTMLButtonElement>) {
    trigger.current = event.currentTarget;
    setCreating(true);
  }
  const goals = useQuery(responsibilitiesQueryOptions());
  const denied = goalsAccessDenied(goals.error);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchId = useId();
  const searchField = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (denied) {
      setOpenId(null);
      setCreating(false);
    }
  }, [denied]);
  const data = canKeepCachedRead(goals.error) ? goals.data : undefined;
  const shown = (data ?? []).filter(
    (goal) => agentId === undefined || goal.agentId === agentId,
  );
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = shown.filter((goal) => {
    if (!words.length) return true;
    const text = [
      goal.title,
      goal.instruction,
      goal.successCriteria,
      botName?.(goal.agentId),
      STATUS[goal.status].label,
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
  // Looked up from the query rather than held, so the dialog follows every refetch.
  const open = shown.find((goal) => goal.id === openId);
  const focusHeading = () => (pageHeading ?? heading).current;
  const newGoal = goals.isSuccess ? (
    <AstryxButton
      className="min-h-11"
      icon={<IconPlus aria-hidden size={16} />}
      label="New goal"
      onClick={start}
      variant="primary"
    />
  ) : null;
  return (
    <PageSection
      action={pageHeading ? undefined : newGoal}
      className={pageHeading ? "mt-6" : undefined}
      description={
        searchable && !pageHeading
          ? "Open a goal to edit its instructions, change when it runs, or review past runs."
          : undefined
      }
      headingRef={heading}
      title={pageHeading ? undefined : sectionTitle}
    >
      {pageHeading && newGoal ? <HStack>{newGoal}</HStack> : null}
      {goals.isPending ? (
        <ReadStatus kind="loading" message="Loading Goals…" />
      ) : null}
      {goals.error ? (
        <ReadError
          description={
            shown.length
              ? "Showing the last loaded goals. Refresh to make changes."
              : undefined
          }
          focusAfterRetry={focusHeading}
          message={
            denied
              ? "You don’t have access to these goals."
              : shown.length
                ? "Couldn’t refresh Goals"
                : "Couldn’t load Goals"
          }
          retry={goals.refetch}
          retryBelow
          retryLabel="Retry loading goals"
          retrying={goals.isFetching}
        />
      ) : null}
      {searchable && shown.length ? (
        <Field className="mt-4">
          <FieldLabel htmlFor={searchId}>Search goals</FieldLabel>
          <HStack gap={2}>
            <Input
              className="min-h-11 min-w-0 flex-1"
              id={searchId}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) {
                  event.preventDefault();
                  setSearch("");
                }
              }}
              placeholder={
                agentId
                  ? "Title, instruction, or status"
                  : "Title, Bot, or status"
              }
              ref={searchField}
              type="search"
              value={search}
            />
            {search ? (
              <Button
                className="min-h-11"
                onClick={() => {
                  setSearch("");
                  searchField.current?.focus();
                }}
                type="button"
                variant="ghost"
              >
                Clear search
              </Button>
            ) : null}
          </HStack>
          {words.length ? (
            <p className="text-muted-foreground text-sm" role="status">
              {matching.length} of {shown.length} goals match
            </p>
          ) : null}
        </Field>
      ) : null}
      {!shown.length && goals.isSuccess ? (
        <PageEmpty icon={IconChecklist} title="No goals yet">
          {agentId
            ? "Work you give this Bot to keep doing shows up here."
            : "Work you give your Bots to keep doing shows up here."}
        </PageEmpty>
      ) : shown.length && !matching.length ? (
        <PageEmpty icon={IconListSearch} title="No matching goals">
          Try a shorter title or search for Active, Paused, or Completed.
        </PageEmpty>
      ) : matching.length ? (
        <PageRows>
          {matching.map((goal, index) => (
            <Fragment key={goal.id}>
              {index > 0 ? <Separator /> : null}
              <ResponsibilityRow
                goal={goal}
                owner={botName?.(goal.agentId)}
                onOpen={(event) => {
                  trigger.current = event.currentTarget;
                  setOpenId(goal.id);
                }}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : null}
      {creating && !denied ? (
        <NewResponsibilityDialog
          agentId={agentId}
          returnFocus={trigger}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {open ? (
        <ResponsibilityDialog
          canManage={goals.isSuccess}
          goal={open}
          key={open.id}
          returnFocus={() =>
            trigger.current?.isConnected
              ? trigger.current
              : (searchField.current ?? focusHeading())
          }
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
  owner,
}: {
  goal: ResponsibilityRecord;
  onOpen: React.MouseEventHandler<HTMLButtonElement>;
  owner?: string;
}) {
  const triggers = useQuery(triggersQueryOptions(goal.id));
  const Icon = STATUS[goal.status].icon;
  return (
    <Item render={<button onClick={onOpen} type="button" />} size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="line-clamp-none [overflow-wrap:anywhere]">
          {goal.title}
        </ItemTitle>
        <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
          {[
            owner,
            summaryFor(
              goal,
              canKeepCachedRead(triggers.error) ? triggers.data : undefined,
            ),
          ]
            .filter(Boolean)
            .join(" · ")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}
