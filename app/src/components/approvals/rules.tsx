import { ruleTitle } from "@openbot/shared/tool-name";
import {
  IconChevronRight,
  IconListSearch,
  IconLock,
  IconPlus,
  IconShieldCheck,
} from "@tabler/icons-react";
import { type UseMutationResult, useQuery } from "@tanstack/react-query";
import { type RefObject, useId, useRef, useState } from "react";
import { governanceOverlay } from "@/components/astryx-pilot/governance";
import { PageEmpty } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GONE_BOT, useBotNames } from "@/lib/agents/bot-names";
import {
  type ApprovalRuleInput,
  type ApprovalRuleRow,
  BEHAVIOUR_LABELS,
  type HostCommandPolicy,
  type RuleBehaviour,
} from "@/lib/approvals";
import { isComposing } from "@/lib/composing";
import {
  type HostFolderGrant,
  hostAccessQueryOptions,
} from "@/lib/computers/host-access";

/**
 * The tool pattern the rule form shows as its example. It has to match real tool names, which start
 * with the app as OpenBot lists it (`composio-gmail/GMAIL_SEND_EMAIL`): the earlier example,
 * `mcp/gmail/*`, matched no tool at all, so a rule typed from it never applied.
 */
export const TOOL_PATTERN_EXAMPLE = "composio-gmail/*";

export const HOST_LABELS: Record<HostCommandPolicy, string> = {
  ask: "Ask every time",
  allow: "Always allow",
  never: "Never",
};

/**
 * One value from a fixed set of labelled choices: a rule's behaviour, or how commands on a computer
 * are handled. The keys of `labels` are the values, in the order they are offered.
 */
export function LabelSelect<T extends string>({
  className,
  id,
  label,
  labels,
  value,
  disabled,
  onChange,
}: {
  className?: string;
  id?: string;
  /** The trigger's accessible name, where no visible label names it. */
  label?: string;
  labels: Record<T, string>;
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
      value={value}
    >
      <SelectTrigger aria-label={label} className={className} id={id}>
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent {...governanceOverlay}>
        {(Object.keys(labels) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The behaviours a team rule is offered under, each saying it is the team's. */
const TEAM_BEHAVIOUR_LABELS = Object.fromEntries(
  Object.entries(BEHAVIOUR_LABELS).map(([key, label]) => [
    key,
    `${label} (team rule)`,
  ]),
) as Record<RuleBehaviour, string>;

/** What kind of action a rule covers, in words. Any other kind is left unsaid. */
const EFFECT_WORDS: Record<string, string> = {
  read: "reading",
  write: "changes",
  destructive: "deleting",
  delegate: "handing off work",
};

/** "for Expenses"; nothing until the names arrive, so a Bot is never named by its id. */
function forBot(name: string): string | null {
  if (!name) return null;
  return name === GONE_BOT ? "for a Bot no longer here" : `for ${name}`;
}

/** A rule saved from a folder's card is on the id OpenBot gave that folder (`host-access/broker.ts`). */
const FOLDER_GRANT = "host-grant-";

/**
 * A folder rule's place by the folder's name, as Settings → Computer shows it: "in share". A grant
 * ends when OpenBot stops, so a rule on one that is gone says so rather than naming its id.
 */
function folderWords(
  grantId: string,
  grants: readonly HostFolderGrant[] | undefined,
): string {
  if (!grants) return "in a folder";
  const grant = grants.find((candidate) => candidate.id === grantId);
  return grant && !grant.revoked
    ? `in ${grant.displayName}`
    : "in a folder that's no longer shared";
}

export function filterApprovalRules(
  rules: ApprovalRuleRow[],
  query: string,
  botName: (id: string) => string,
  team = false,
) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return rules;
  return rules.filter((rule) => {
    const text = [
      ruleTitle(rule).title,
      rule.toolRef,
      rule.scope,
      rule.effect,
      EFFECT_WORDS[rule.effect],
      rule.botId === "*" ? "all bots every bot" : botName(rule.botId),
      rule.botId,
      rule.account,
      BEHAVIOUR_LABELS[rule.behaviour],
      team ? TEAM_BEHAVIOUR_LABELS[rule.behaviour] : undefined,
    ]
      .join(" ")
      .toLowerCase();
    return terms.every((word) => text.includes(word));
  });
}

export const ruleRowId = (id: string, team?: boolean) =>
  `${team ? "team-" : ""}approval-rule-${id}`;

export function RuleSearch({
  label,
  emptyTitle,
  value,
  onChange,
  inputRef,
  total,
  matches,
  first,
  team,
}: {
  label: string;
  emptyTitle: string;
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  total: number;
  matches: number;
  first: ApprovalRuleRow | undefined;
  team?: boolean;
}) {
  if (!total && !value) return null;
  const filtering = Boolean(value.trim());
  return (
    <>
      <Input
        aria-label={label}
        className="mt-4 min-h-12"
        maxLength={200}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          if (event.key === "Escape" && value) {
            event.preventDefault();
            onChange("");
          }
          if (event.key === "Enter" && filtering && first) {
            event.preventDefault();
            document.getElementById(ruleRowId(first.id, team))?.focus();
          }
        }}
        placeholder="Search by action, app, Bot, or policy"
        ref={inputRef}
        type="search"
        value={value}
      />
      <p className="mt-2 text-muted-foreground text-sm" role="status">
        {filtering ? `${matches} of ${total} rules match` : null}
      </p>
      {filtering && !matches ? (
        <PageEmpty
          action={
            <Button
              className="min-h-12"
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
              type="button"
              variant="outline"
            >
              Clear search
            </Button>
          }
          icon={IconListSearch}
          title={emptyTitle}
        />
      ) : null}
    </>
  );
}

/**
 * One saved rule, as a row: what it matches, and what a Bot does about it. A locked rule — a team
 * rule seen by a member, or a personal rule the team has switched off — states its behaviour and
 * offers nothing to change.
 */
export function RuleRow({
  rule,
  team,
  locked,
  disabled,
  onRevoke,
  onChange,
  touchTargets,
}: {
  rule: ApprovalRuleRow;
  team?: boolean;
  locked?: boolean;
  disabled: boolean;
  onRevoke: (trigger: HTMLButtonElement) => void;
  onChange: (behaviour: RuleBehaviour) => void;
  touchTargets?: boolean;
}) {
  const labels = team ? TEAM_BEHAVIOUR_LABELS : BEHAVIOUR_LABELS;
  // The action in its approval card's words is the title ("Click", "Any action on Gmail"); the rest
  // of what the rule matches is the line beneath, never clamped, since two rules for one action
  // differ only there. The title already names an app's rule's place.
  const { title, place } = ruleTitle(rule);
  const botName = useBotNames();
  const folderRule = rule.scope.startsWith(FOLDER_GRANT);
  const folders = useQuery({
    ...hostAccessQueryOptions(),
    refetchInterval: false,
    enabled: folderRule,
  });
  const match = [
    EFFECT_WORDS[rule.effect] ?? null,
    rule.scope === "*" || place
      ? null
      : folderRule
        ? folderWords(rule.scope, folders.data?.grants)
        : `on ${rule.scope}`,
    // A rule saved for one of several accounts at the app covers that account only.
    rule.account ? `from ${rule.account}` : null,
    rule.botId === "*"
      ? null
      : rule.botId.includes("*")
        ? `for Bots matching ${rule.botId}`
        : forBot(botName(rule.botId)),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Item
      className="focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
      id={ruleRowId(rule.id, team)}
      size="sm"
      tabIndex={-1}
    >
      <ItemMedia variant="icon">
        {locked ? <IconLock /> : <IconShieldCheck />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {match ? (
          <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
            {match}
          </ItemDescription>
        ) : null}
        {locked ? <ItemDescription>Locked</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        {locked ? (
          <span className="text-muted-foreground text-sm">
            {labels[rule.behaviour]}
          </span>
        ) : (
          <>
            <LabelSelect
              className={touchTargets ? "confirmation-action" : undefined}
              id={team ? `team-rule-behaviour-${rule.id}` : undefined}
              disabled={disabled}
              label={`Behaviour for ${title}`}
              labels={labels}
              onChange={onChange}
              value={rule.behaviour}
            />
            <Button
              aria-label={
                team || touchTargets
                  ? `Remove ${title}${match ? `, ${match}` : ""}`
                  : undefined
              }
              className={
                team || touchTargets ? "confirmation-action" : undefined
              }
              id={team ? `team-rule-remove-${rule.id}` : undefined}
              disabled={disabled}
              onClick={(event) => onRevoke(event.currentTarget)}
              size="sm"
              variant="outline"
            >
              Remove
            </Button>
          </>
        )}
      </ItemActions>
    </Item>
  );
}

const EMPTY_RULE: ApprovalRuleInput = {
  botId: "*",
  toolRef: "",
  effect: "*",
  scope: "*",
  behaviour: "ask",
};

/**
 * An action class and a behaviour, added from a row that opens a dialog. `*` matches anything, so
 * `composio-gmail/*` is every Gmail tool and a target of `*.example.com` is every page on that site.
 */
export function RuleForm({
  label,
  save,
  botField = true,
  canSave = true,
  refreshSettings,
  forBot,
}: {
  label: string;
  /** The write that adds the rule. The dialog closes when it succeeds and shows why when it fails. */
  save: UseMutationResult<unknown, Error, ApprovalRuleInput>;
  /** Off where the rule applies to every Bot, so there is no Bot to name. */
  botField?: boolean;
  canSave?: boolean;
  refreshSettings?: () => Promise<unknown>;
  /** The Bot every rule from this form is for, already known from the page it is on. */
  forBot?: string;
}) {
  const blank = forBot ? { ...EMPTY_RULE, botId: forBot } : EMPTY_RULE;
  const [rule, setRule] = useState<ApprovalRuleInput>(blank);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const id = useId();
  const dirty =
    rule.toolRef !== blank.toolRef ||
    rule.effect !== blank.effect ||
    rule.scope !== blank.scope ||
    rule.botId !== blank.botId ||
    rule.behaviour !== blank.behaviour;
  const close = () => {
    setOpen(false);
    setRule(blank);
  };
  // Opening starts clean: the last attempt's failure belongs to the draft it was about.
  const show = () => {
    if (!canSave || save.isPending) return;
    save.reset();
    setOpen(true);
  };
  const field = (key: keyof ApprovalRuleInput, title: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={`${id}-${key}`}>{title}</FieldLabel>
      <Input
        disabled={save.isPending}
        id={`${id}-${key}`}
        onChange={(event) => {
          // Read before the updater runs: React restores a controlled input's DOM value first.
          const value = event.target.value;
          setRule((prior) => ({ ...prior, [key]: value }));
        }}
        placeholder={hint}
        value={rule[key]}
      />
    </Field>
  );
  return (
    <>
      <Item
        render={
          <button
            disabled={!canSave || save.isPending}
            onClick={show}
            ref={opener}
            type="button"
          />
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconPlus />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
          <ItemDescription>
            A tool or app, and what a Bot does before using it.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <SettingsDraftDialog
        action={
          <Button
            className="min-h-11"
            disabled={!canSave || save.isPending || !rule.toolRef.trim()}
            form={id}
            size="sm"
            type="submit"
          >
            {save.isPending ? "Saving…" : "Save rule"}
          </Button>
        }
        description={`Use * to match anything. An app's tools start with its name, so ${TOOL_PATTERN_EXAMPLE} means every Gmail tool. A target of *.example.com means every page on that site.`}
        dirty={dirty}
        onClose={close}
        open={open}
        opener={opener}
        overlay={governanceOverlay}
        saving={save.isPending}
        title={label}
      >
        {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
        <form
          id={id}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave || save.isPending || !rule.toolRef.trim()) return;
            // A failed save keeps the dialog and the draft, so the person can correct it.
            save.mutate(rule, { onSuccess: close });
          }}
        >
          <FieldGroup>
            {field(
              "toolRef",
              "Tool or app",
              `${TOOL_PATTERN_EXAMPLE}, computer_click, host/*`,
            )}
            {field("effect", "Kind of action", "* , write, read, delegate")}
            {field("scope", "Target", "*, a site, a folder, a Bot name")}
            {botField ? field("botId", "Bot", "* for every Bot") : null}
            <Field>
              <FieldLabel htmlFor={`${id}-behaviour`}>Behaviour</FieldLabel>
              <LabelSelect
                disabled={save.isPending}
                id={`${id}-behaviour`}
                labels={BEHAVIOUR_LABELS}
                onChange={(behaviour) =>
                  setRule((prior) => ({ ...prior, behaviour }))
                }
                value={rule.behaviour}
              />
            </Field>
          </FieldGroup>
        </form>
        {save.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {save.error.message}
          </p>
        ) : null}
        {!canSave && !save.isPending && refreshSettings ? (
          <ReadError
            message="Reload your approval settings before saving this rule."
            description="Your draft will stay here."
            retry={refreshSettings}
            retryBelow
            retryLabel="Refresh approval settings"
          />
        ) : null}
      </SettingsDraftDialog>
    </>
  );
}
