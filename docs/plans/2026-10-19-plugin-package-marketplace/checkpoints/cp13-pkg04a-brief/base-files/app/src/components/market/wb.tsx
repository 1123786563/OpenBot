import { IconCheck, IconLoader2, IconPlus } from "@tabler/icons-react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * WorkBuddy-styled primitives for the marketplace.
 *
 * The visual contract comes from the WorkBuddy desktop client's 专家·技能·连接器 screen (v5.7.7):
 * cards are 16px-radius white surfaces with a hairline border and a barely-there shadow that
 * deepens on hover; icon slots are 48px with the same radius; names are 16px/medium, descriptions
 * 14px in a 70%-strength foreground and always single-line; category chips are 32px tall with a
 * 6px radius; the one primary verb per view is a black button. The values here are those measures,
 * expressed in the app's own theme tokens (foreground/border/card) so the same design holds in the
 * dark theme instead of hard-coding WorkBuddy's light-only palette.
 */

/** The card surface every shelf draws. WB: rounded-16, p-20, border 8% black, shadow 0 4 12 3%. */
export function WbCard({
  className,
  interactive = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 self-start rounded-2xl border border-border bg-card p-5 shadow-card transition-[box-shadow,border-color] duration-200",
        interactive &&
          "cursor-pointer hover:border-foreground/20 hover:shadow-card-hover",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** The 48px icon slot at a card's top-left. WB: 48px, radius 16, hairline border. */
export function WbIconSlot({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-card text-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Card title. WB: 16px/24px, weight 500, single line. */
export function WbName({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "block truncate text-base font-medium leading-6 text-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Card description. WB: 14px/22px at 70% foreground, single line. */
export function WbDesc({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "block truncate text-sm leading-[22px] text-foreground/70",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small factual chip on a card (tags, categories). WB: 4%-black pill, 12px text. */
export function WbTag({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-md bg-foreground/[0.04] px-2 text-xs leading-none text-foreground/70",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The 32px category filter chip row. WB: h-32, radius 6, 14px/500, selected tinted. */
export function WbCategoryChips({
  categories,
  value,
  allLabel,
  onChange,
}: {
  categories: string[];
  value: string;
  allLabel: string;
  onChange: (next: string) => void;
}) {
  if (categories.length === 0) return null;
  const chip = (label: string, key: string) => (
    <button
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-md px-3 text-sm font-medium transition-colors",
        value === key
          ? "bg-foreground/[0.06] text-foreground"
          : "text-foreground/50 hover:bg-foreground/[0.03] hover:text-foreground",
      )}
      key={key}
      onClick={() => onChange(key)}
      type="button"
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {chip(allLabel, "all")}
      {categories.map((entry) => chip(entry, entry))}
    </div>
  );
}

/** A 16px semibold text sub-tab (WB's 推荐/SkillHub/套件 row). */
export function WbSegmentTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center gap-5">
      {tabs.map((entry) => (
        <button
          className={cn(
            "flex items-center gap-1.5 text-base leading-6 font-semibold transition-colors",
            value === entry.key
              ? "text-foreground"
              : "text-foreground/50 hover:text-foreground",
          )}
          key={entry.key}
          onClick={() => onChange(entry.key)}
          type="button"
        >
          {entry.label}
          {entry.count !== undefined ? (
            <span className="text-sm font-normal text-foreground/40">
              {entry.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** The black primary verb (WB's 召唤 / 添加技能 / 自定义连接器). */
export function WbPrimaryButton({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  /*
   * Delegates to the system Button for states (hover 80%, ring-3 focus, 1px press, disabled) and
   * keeps only the WB sizing (px-3.5) here — the states were the drift: opacity-85 hover and no
   * focus ring read as a different product next to every other button on a market page.
   */
  return (
    <Button className={cn("px-3.5", className)} {...props}>
      {children}
    </Button>
  );
}

/** The same black verb as a router link (a button cannot nest one). */
export function WbPrimaryLink(props: LinkProps) {
  return (
    <Button
      className="px-3.5"
      render={(buttonProps) => <Link {...props} {...buttonProps} />}
    />
  );
}

/** The outlined secondary verb (WB's 我的专家 / 已安装(N)). */
export function WbSecondaryButton({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <Button variant="outline" className={cn("px-3", className)} {...props}>
      {children}
    </Button>
  );
}

/** The 24px square install affordance in a card's top-right corner. WB: radius 6 on 6% black. */
export function WbAddButton({
  pending = false,
  installed = false,
  label,
  installedLabel,
  onClick,
}: {
  pending?: boolean;
  installed?: boolean;
  label: string;
  installedLabel: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  if (installed) {
    return (
      <span
        aria-label={installedLabel}
        className="flex size-6 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/70"
        role="img"
        title={installedLabel}
      >
        <IconCheck className="size-3.5" />
      </span>
    );
  }
  return (
    <button
      aria-label={pending ? undefined : label}
      className="flex size-6 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground transition-colors hover:bg-foreground/[0.12] disabled:pointer-events-none"
      disabled={pending}
      onClick={onClick}
      title={pending ? undefined : label}
      type="button"
    >
      {pending ? (
        <IconLoader2 className="size-3.5 animate-spin" />
      ) : (
        <IconPlus className="size-3.5" />
      )}
    </button>
  );
}

/** A section heading with its leading icon (WB's 精选技能 / 专家帮你做). */
export function WbSectionTitle({
  icon,
  children,
  action,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-1.5 text-base font-medium leading-6 text-foreground">
        {icon}
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Three-centre stat readout inside a detail dialog (WB's 版本/使用量/开发者信息 row). */
export function WbStatsRow({
  stats,
}: {
  stats: { value: React.ReactNode; label: string }[];
}) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1">
      {stats.map((stat) => (
        <div
          className="flex min-w-0 flex-col items-center gap-1 text-center"
          key={stat.label}
        >
          <span className="max-w-full truncate text-base leading-6 font-semibold text-foreground">
            {stat.value}
          </span>
          <span className="text-xs leading-4 text-foreground/50">
            {stat.label}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A soft-grey quoted row (WB's 专家帮你做 example prompts). */
export function WbQuoteRow({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="relative rounded-xl bg-foreground/[0.03] p-3.5 pr-11 text-sm leading-relaxed text-foreground/80">
      {children}
      {action ? (
        <div className="absolute top-1/2 right-2.5 -translate-y-1/2">
          {action}
        </div>
      ) : null}
    </div>
  );
}

/** The muted ID strip at a detail dialog's bottom (WB's ID: ex_… row). */
export function WbIdRow({ label, id }: { label: string; id: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.03] px-3.5 py-2.5 text-sm text-foreground/60">
      <span className="shrink-0">{label}</span>
      <span className="truncate font-mono text-xs">{id}</span>
    </div>
  );
}

/** Centered empty state (WB's 还没有创建任何专家: glyph over muted text). */
export function WbEmpty({
  glyph,
  title,
  hint,
  action,
}: {
  glyph: string;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-center">
      <span aria-hidden="true" className="text-5xl leading-none opacity-60">
        {glyph}
      </span>
      <p className="mt-2 text-sm text-foreground/40">{title}</p>
      {hint ? (
        <p className="max-w-sm text-xs leading-5 text-foreground/35">{hint}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** Card-shaped loading placeholder matching WbCard's footprint. */
export function WbCardSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-border bg-card p-5",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <div className="size-12 animate-pulse rounded-2xl bg-foreground/[0.06]" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 animate-pulse rounded bg-foreground/[0.06]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-foreground/[0.04]" />
        </div>
      </div>
      <div className="h-3 w-3/4 animate-pulse rounded bg-foreground/[0.04]" />
    </div>
  );
}
