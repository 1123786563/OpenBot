import {
  IconChevronRight,
  IconLock,
  IconPlus,
  IconShieldCheck,
} from "@tabler/icons-react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import type {
  ApprovalRuleInput,
  ApprovalRuleRow,
  HostCommandPolicy,
  RuleBehaviour,
} from "@/lib/approvals";

const HOST_KEYS = {
  ask: "hostPolicy.ask",
  allow: "hostPolicy.alwaysAllow",
  never: "hostPolicy.never",
} as const satisfies Record<HostCommandPolicy, string>;

const BEHAVIOUR_KEYS = {
  allow: "behaviour.allow",
  pre_approved: "behaviour.preApproved",
  ask: "behaviour.ask",
  hand_off: "behaviour.handOff",
} as const satisfies Record<RuleBehaviour, string>;

/** How commands on a computer are handled, translated for the person reading them. */
export function hostLabels(
  t: TFunction<"approvals">,
): Record<HostCommandPolicy, string> {
  return {
    ask: t(HOST_KEYS.ask),
    allow: t(HOST_KEYS.allow),
    never: t(HOST_KEYS.never),
  };
}

/** The behaviours a rule is offered under, each saying it is the team's where it is. */
function behaviourLabels(
  t: TFunction<"approvals">,
  team: boolean,
): Record<RuleBehaviour, string> {
  const suffix = team ? t("teamRuleSuffix") : "";
  return {
    allow: t(BEHAVIOUR_KEYS.allow) + suffix,
    pre_approved: t(BEHAVIOUR_KEYS.pre_approved) + suffix,
    ask: t(BEHAVIOUR_KEYS.ask) + suffix,
    hand_off: t(BEHAVIOUR_KEYS.hand_off) + suffix,
  };
}

/**
 * One value from a fixed set of labelled choices: a rule's behaviour, or how commands on a computer
 * are handled. The keys of `labels` are the values, in the order they are offered.
 */
export function LabelSelect<T extends string>({
  id,
  label,
  labels,
  value,
  disabled,
  onChange,
}: {
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
        if (next !== null) onChange(next);
      }}
      value={value}
    >
      <SelectTrigger aria-label={label} id={id}>
        <SelectValue>{labels[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(labels) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
}: {
  rule: ApprovalRuleRow;
  team?: boolean;
  locked?: boolean;
  disabled: boolean;
  onRevoke: () => void;
  onChange: (behaviour: RuleBehaviour) => void;
}) {
  const { t } = useTranslation("approvals");
  const labels = behaviourLabels(t, Boolean(team));
  // The tool is the title; the rest of what the rule matches is the line beneath, never clamped,
  // since two rules for one tool differ only there.
  const match = [
    rule.effect !== "*" ? t("ruleEffectSuffix", { effect: rule.effect }) : null,
    rule.scope !== "*" ? t("ruleScopeSuffix", { scope: rule.scope }) : null,
    rule.botId !== "*" ? t("ruleBotSuffix", { bot: rule.botId }) : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        {locked ? <IconLock /> : <IconShieldCheck />}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{rule.toolRef}</ItemTitle>
        {match ? (
          <ItemDescription className="line-clamp-none break-all">
            {match}
          </ItemDescription>
        ) : null}
        {locked ? <ItemDescription>{t("locked")}</ItemDescription> : null}
      </ItemContent>
      <ItemActions>
        {locked ? (
          <span className="text-muted-foreground text-sm">
            {labels[rule.behaviour]}
          </span>
        ) : (
          <>
            <LabelSelect
              disabled={disabled}
              label={t("behaviourFor", { tool: rule.toolRef })}
              labels={labels}
              onChange={onChange}
              value={rule.behaviour}
            />
            <Button
              disabled={disabled}
              onClick={onRevoke}
              size="sm"
              variant="outline"
            >
              {t("remove")}
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
 * `mcp/gmail/*` is every Gmail tool and a target of `*.example.com` is every page on that site.
 */
export function RuleForm({
  label,
  save,
  botField = true,
  forBot,
}: {
  label: string;
  /** The write that adds the rule. The dialog closes when it succeeds and shows why when it fails. */
  save: UseMutationResult<unknown, Error, ApprovalRuleInput>;
  /** Off where the rule applies to every Bot, so there is no Bot to name. */
  botField?: boolean;
  /** The Bot every rule from this form is for, already known from the page it is on. */
  forBot?: string;
}) {
  const { t } = useTranslation("approvals");
  const blank = forBot ? { ...EMPTY_RULE, botId: forBot } : EMPTY_RULE;
  const [rule, setRule] = useState<ApprovalRuleInput>(blank);
  const [open, setOpen] = useState(false);
  const id = useId();
  const toolRefInput = useRef<HTMLInputElement>(null);
  // Closing without saving drops what was typed, so the dialog opens blank next time.
  const close = () => {
    setOpen(false);
    setRule(blank);
  };
  // Opening starts clean: the last attempt's failure belongs to the draft it was about.
  const show = () => {
    save.reset();
    setOpen(true);
  };
  const field = (key: keyof ApprovalRuleInput, title: string, hint: string) => (
    <Field>
      <FieldLabel htmlFor={`${id}-${key}`}>{title}</FieldLabel>
      <Input
        ref={key === "toolRef" ? toolRefInput : undefined}
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
      <Item render={<button onClick={show} type="button" />} size="sm">
        <ItemMedia variant="icon">
          <IconPlus />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{label}</ItemTitle>
          <ItemDescription>{t("form.rowDescription")}</ItemDescription>
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      <Dialog onOpenChange={(next) => (next ? show() : close())} open={open}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>{t("form.wildcardHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form
              id={id}
              onSubmit={(event) => {
                event.preventDefault();
                // A failed save keeps the dialog and the draft, so the person can correct it.
                save.mutate(rule, {
                  onError: () => {
                    requestAnimationFrame(() => toolRefInput.current?.focus());
                  },
                  onSuccess: close,
                });
              }}
            >
              <FieldGroup>
                {field(
                  "toolRef",
                  t("form.toolOrApp"),
                  "mcp/gmail/*, computer_click, host/*",
                )}
                {field(
                  "effect",
                  t("form.kindOfAction"),
                  "* , write, read, delegate",
                )}
                {field("scope", t("form.target"), t("form.targetHint"))}
                {botField
                  ? field("botId", t("form.bot"), t("form.botHint"))
                  : null}
                <Field>
                  <FieldLabel htmlFor={`${id}-behaviour`}>
                    {t("form.behaviour")}
                  </FieldLabel>
                  <LabelSelect
                    id={`${id}-behaviour`}
                    labels={behaviourLabels(t, false)}
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
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={close} size="sm" variant="outline">
              {t("form.cancel")}
            </Button>
            <Button
              disabled={save.isPending || !rule.toolRef.trim()}
              form={id}
              size="sm"
              type="submit"
            >
              {t("form.saveRule")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
