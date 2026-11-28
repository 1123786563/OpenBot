import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Text } from "@astryxdesign/core/Text";
import type {
  WhatIfLayer,
  WhatIfLayerId,
  WhatIfOutcome,
  WhatIfResult,
  WhatIfVerdict,
} from "@openbot/shared/what-if";
import {
  IconBan,
  IconChecks,
  IconCircleCheck,
  IconHandStop,
  IconInfoCircle,
  IconLifebuoy,
  IconLockAccess,
  IconMessageQuestion,
  IconPlug,
  IconPuzzle,
  IconShieldCheck,
  IconWorld,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * What each of OpenBot's controls says about one action, in the order it asks them.
 *
 * One row per control, stacked, so it reads down a narrow column: the control, what it says and why,
 * and its verdict. The control that settles the action is highlighted. The rows it bypasses keep
 * their hypothetical explanations available on request.
 */

/** The same icons the Admin sidebar gives the pages these controls are set on. */
const ICONS: Record<
  WhatIfLayerId,
  React.ComponentType<{ className?: string }>
> = {
  grant: IconPuzzle,
  app_allowlist: IconPlug,
  capabilities: IconLockAccess,
  network: IconWorld,
  boundaries: IconShieldCheck,
  safety: IconLifebuoy,
  approvals: IconChecks,
};

/** What the row's detail line is about, by control. */
const BASIS_WORDS: Record<WhatIfLayerId, string> = {
  grant: "Not given",
  app_allowlist: "Setting",
  capabilities: "Permission",
  network: "Allowlist",
  boundaries: "Rule",
  safety: "Why",
  approvals: "Rule",
};

/** The page each control's setting is on, as the sidebar names it. */
const PAGE_WORDS: Record<NonNullable<WhatIfLayer["page"]>, string> = {
  "/admin/plugins": "Open Plugins",
  "/admin/permissions": "Open Permissions",
  "/admin/computers": "Open Computers",
  "/admin/boundaries": "Open Boundaries",
  "/admin/approvals": "Open Approvals",
};

const VERDICTS: Record<WhatIfVerdict, { label: string; tone: string }> = {
  allows: {
    label: "Allows",
    tone: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-400",
  },
  refuses: { label: "Blocks", tone: "bg-destructive/10 text-destructive" },
  asks: {
    label: "Asks first",
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  hands_off: {
    label: "Hands off",
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  trial: {
    label: "Would refuse",
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

/** The tint on the row that settles the action, as Audit tints the rows worth stopping at. */
const DECIDES_ROW: Record<WhatIfVerdict, string> = {
  allows: "",
  refuses: "bg-destructive/5",
  asks: "bg-amber-500/5",
  hands_off: "bg-amber-500/5",
  trial: "",
};

const OUTCOMES: Record<
  WhatIfOutcome,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    tone: string;
  }
> = {
  allowed: {
    label: "Allowed",
    icon: IconCircleCheck,
    tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  refused: {
    label: "Blocked",
    icon: IconBan,
    tone: "bg-destructive/10 text-destructive",
  },
  asks: {
    label: "Asks first",
    icon: IconMessageQuestion,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  hands_off: {
    label: "Person does it",
    icon: IconHandStop,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

const LINK =
  "rounded-sm font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring";

function VerdictPill({ verdict }: { verdict: WhatIfVerdict }) {
  const { label, tone } = VERDICTS[verdict];
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full px-2 py-0.5 font-medium text-xs",
        tone,
      )}
      data-verdict={verdict}
    >
      {label}
    </span>
  );
}

function LayerRow({ layer }: { layer: WhatIfLayer }) {
  const Icon = ICONS[layer.id];
  const hasFooter =
    layer.unreached || layer.basis || layer.rule || layer.caveat || layer.page;
  return (
    <Item
      className={layer.decides ? DECIDES_ROW[layer.verdict] : undefined}
      data-decides={layer.decides ? "true" : undefined}
      data-layer={layer.id}
      data-unreached={layer.unreached ? "true" : undefined}
      size="sm"
    >
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        {/* `line-clamp-none` makes the title a block, so the tag keeps its own space. */}
        <ItemTitle className="line-clamp-none">
          {layer.title}
          {layer.decides ? (
            <span className="ms-2 whitespace-nowrap font-medium text-foreground text-xs">
              Decides
            </span>
          ) : null}
        </ItemTitle>
        {layer.unreached ? null : (
          <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
            {layer.summary}
          </ItemDescription>
        )}
      </ItemContent>
      <ItemActions className="shrink-0 self-start">
        {layer.unreached ? (
          <Text color="secondary" size="sm">
            Not reached
          </Text>
        ) : (
          <VerdictPill verdict={layer.verdict} />
        )}
      </ItemActions>
      {hasFooter ? (
        <ItemFooter className="flex-col items-start gap-1 pl-11 text-muted-foreground text-sm">
          {layer.unreached ? (
            <Collapsible
              chevronPosition="start"
              defaultIsOpen={false}
              trigger={`If ${layer.title} were reached`}
            >
              <Text as="p" size="sm">
                {layer.summary}
              </Text>
            </Collapsible>
          ) : null}
          {layer.basis ? (
            <span className="[overflow-wrap:anywhere]">
              <span className="font-medium text-foreground/80">
                {BASIS_WORDS[layer.id]}:
              </span>{" "}
              {layer.basis}
            </span>
          ) : null}
          {layer.rule && layer.rule !== layer.basis ? (
            <Collapsible
              chevronPosition="start"
              defaultIsOpen={false}
              trigger={`${layer.title} rule expression`}
            >
              <code className="font-mono [overflow-wrap:anywhere]">
                {layer.rule}
              </code>
            </Collapsible>
          ) : null}
          {layer.caveat ? (
            <span className="flex gap-1">
              <IconInfoCircle className="mt-px size-3.5 shrink-0" />
              <span>{layer.caveat}</span>
            </span>
          ) : null}
          {layer.page ? (
            <Link className={LINK} to={layer.page}>
              {PAGE_WORDS[layer.page]}
            </Link>
          ) : null}
        </ItemFooter>
      ) : null}
    </Item>
  );
}

/**
 * The answer: what happens, in one line, then each control's row. `inDialog` draws the rows on the
 * dialog's muted fill, where a card's colour would vanish into the popover's.
 */
export function WhatIfResultView({
  result,
  inDialog = false,
}: {
  result: WhatIfResult;
  inDialog?: boolean;
}) {
  const outcome = OUTCOMES[result.outcome];
  const decider = result.layers.find((layer) => layer.decides);
  const rows = cn(inDialog && "bg-muted dark:bg-muted");
  return (
    <div className="flex flex-col" data-what-if-result={result.outcome}>
      <PageRows className={cn(rows, inDialog && "mt-0")}>
        <Item size="sm" data-what-if-headline>
          <ItemMedia
            className={cn("rounded-full", outcome.tone)}
            variant="icon"
          >
            <outcome.icon />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="line-clamp-none">{outcome.label}</ItemTitle>
            <ItemDescription className="line-clamp-none text-sm">
              {decider
                ? `${decider.title} decide${decider.title.endsWith("s") ? "" : "s"}. ${decider.summary}`
                : result.headline.replace(/^[^.]*\.\s*/, "")}
            </ItemDescription>
          </ItemContent>
        </Item>
      </PageRows>
      <PageRows className={rows}>
        {result.layers.map((layer, index) => (
          <div key={layer.id}>
            {index > 0 ? <Separator /> : null}
            <LayerRow layer={layer} />
          </div>
        ))}
      </PageRows>
      <div className="mt-3 flex flex-col gap-1.5 text-pretty text-muted-foreground text-sm">
        {result.notApplicable.length > 0 ? (
          <p>
            Doesn't apply to this kind of action:{" "}
            {result.notApplicable.join(", ")}.
          </p>
        ) : null}
        {result.notChecked.length > 0 ? (
          <div>
            <p>Not checked here, because only a real action shows it:</p>
            <ul className="mt-1 list-disc ps-4">
              {result.notChecked.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
