"use client";

/*
 * COMBOBOX — controlled multi-select combobox adapter over React Aria (HeroUI v3 primitives).
 *
 * Base UI's `Combobox` was the previous engine. HeroUI v3.2.6 ships a single-purpose
 * `ComboBox` whose multiple-selection callbacks are second-class (one `Key | null` per toggle,
 * unordered, no change reason), which cannot express the ordered "To:" field contract. This
 * adapter composes the FIRST-CLASS RAC parts — a Popover holding a filter Input,
 * a ListBox (`selectionMode="multiple"`, complete `Set` in `onSelectionChange`) and `useFilter`:
 * - the trigger is a read-only summary button (`aria-haspopup="listbox"` + `aria-expanded`),
 *   which is what the dialog ESC layering guard in `components/ui/dialog.tsx` keys on;
 * - the filter input lives INSIDE the popover. The popover's FocusScope only focuses its
 *   container when nothing inside is focused, so the input's `autoFocus` wins on open and
 *   typing works without fighting focus (pulling focus back into an inline input does not —
 *   the popover's focus containment always wins that fight);
 * - selection: the caller owns order; `onSelectedChange` receives the complete ordered id list;
 * - chips render from `selected` with a remove button; Backspace on an empty input removes the
 *   last chip; focus returns to the filter input after any selection or removal so typed
 *   filtering keeps working;
 * - Escape and outside presses dismiss the popover through RAC's own overlay handling — the
 *   selection is never cleared (Base UI's `reason: "escape-key"` branch has no equivalent).
 * Domain ids flow through as strings (`getKey`) — never `String()`-coerced numbers, no `any`.
 */

import { IconCheck, IconChevronDown, IconX } from "@tabler/icons-react";
import * as React from "react";
import type { Key } from "react-aria-components";
import {
  Input,
  ListBox,
  ListBoxItem,
  Popover,
  useFilter,
} from "react-aria-components";
import { cn } from "@/lib/utils";

export interface ComboboxProps<T> {
  items: T[];
  /** Stable domain id for an item; flows into selection keys untouched. */
  getKey: (item: T) => string;
  /** Human label; drives both filtering and the item's accessible name. */
  itemLabel: (item: T) => string;
  /** Selection in display order; the caller owns this array. */
  selected: T[];
  /** Receives the complete ordered id list after any pick, removal or Backspace. */
  onSelectedChange: (ids: string[]) => void;
  /** Secondary line rendered after the label (e.g. the Bot's title). */
  itemSecondary?: (item: T) => React.ReactNode;
  /** Leading media inside a chip (e.g. the Bot's avatar). */
  chipMedia?: (item: T) => React.ReactNode;
  emptyText: string;
  placeholder: string;
  /** Open the popover on mount (and focus the filter input). */
  defaultOpen?: boolean;
  /** Maximum kept selections; the tail wins, mirroring `toFieldChange`'s slice. */
  maxSelected?: number;
  className?: string;
}

export function Combobox<T>({
  items,
  getKey,
  itemLabel,
  selected,
  onSelectedChange,
  itemSecondary,
  chipMedia,
  emptyText,
  placeholder,
  defaultOpen = false,
  maxSelected,
  className,
}: ComboboxProps<T>) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [query, setQuery] = React.useState("");
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const contains = useFilter({ sensitivity: "base" }).contains;
  const filtered = React.useMemo(
    () =>
      query ? items.filter((item) => contains(itemLabel(item), query)) : items,
    [items, query, contains, itemLabel],
  );
  const selectedIds = React.useMemo(
    () => new Set(selected.map(getKey)),
    [selected, getKey],
  );
  const commit = (ids: Iterable<Key>) => {
    const idSet = new Set(ids);
    // Keep the caller's order, append newcomers in roster order, cap at the tail.
    const ordered = [
      ...selected.filter((item) => idSet.has(getKey(item))).map(getKey),
      ...items
        .filter(
          (item) => idSet.has(getKey(item)) && !selectedIds.has(getKey(item)),
        )
        .map(getKey),
    ].slice(maxSelected !== undefined && maxSelected > 0 ? -maxSelected : 0);
    onSelectedChange(ordered);
  };
  const toggle = (id: string) =>
    commit(
      selectedIds.has(id)
        ? selected.map(getKey).filter((key) => key !== id)
        : [...selected.map(getKey), id],
    );
  const removeLast = () => {
    if (selected.length) toggle(getKey(selected[selected.length - 1]));
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      <button
        type="button"
        ref={triggerRef}
        data-slot="combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        /*
         * Toggle, not just open, so a direct press on an already-open list closes it. Two paths
         * reach the same closed state and both are fine: in a real browser the modal underlay's
         * outside-press dismissal handles presses that land on the overlay (the pinned React Aria
         * Popover has no trigger exclusion, so this handler may not even see those), while direct
         * dispatch on the button — happy-dom's fireEvent, keyboard activation, any non-modal host
         * of this trigger — is handled here. Verified open-then-press closes under both paths.
         */
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-1 text-left text-sm transition-colors focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)]"
      >
        <span
          className={cn(
            "truncate",
            !selected.length && "text-muted-foreground",
          )}
        >
          {selected.length ? selected.map(itemLabel).join(", ") : placeholder}
        </span>
        <IconChevronDown className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </button>
      <Popover
        data-slot="combobox-content"
        isOpen={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        placement="bottom start"
        shouldFlip
        aria-label={placeholder}
        className="relative flex max-h-[min(320px,calc(100dvh-32px))] min-w-40 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 enter:transition enter:duration-100"
      >
        <div
          data-slot="combobox-chips"
          className="flex min-h-8 flex-wrap items-center gap-1 border-b border-input px-2 py-1.5"
        >
          {selected.map((item) => (
            <span
              key={getKey(item)}
              data-slot="combobox-chip"
              className="flex h-[calc(--spacing(5.25))] w-fit items-center justify-center gap-1 rounded-sm bg-ob-muted-surface px-1.5 text-xs font-medium whitespace-nowrap text-foreground"
            >
              {chipMedia?.(item)}
              {itemLabel(item)}
              <button
                type="button"
                aria-label={`Remove ${itemLabel(item)}`}
                data-slot="combobox-chip-remove"
                onClick={(event) => {
                  event.stopPropagation();
                  // Keep filtering seamless: the click would otherwise leave focus on the
                  // (about-to-unmount) remove button.
                  inputRef.current?.focus();
                  toggle(getKey(item));
                }}
                className="mr-0.5 -ml-0.5 size-4 cursor-pointer rounded-sm opacity-50 hover:opacity-100"
              >
                <IconX className="pointer-events-none size-3" />
              </button>
            </span>
          ))}
          <Input
            ref={inputRef}
            data-slot="combobox-chip-input"
            aria-label={placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !query && selected.length) {
                removeLast();
              }
            }}
            autoFocus
            placeholder={placeholder}
            className="min-w-16 flex-1 bg-[var(--ob-field-background)] outline-none"
          />
        </div>
        <ListBox
          data-slot="combobox-list"
          aria-label={placeholder}
          selectionMode="multiple"
          selectedKeys={selectedIds}
          onSelectionChange={(keys) => {
            if (keys === "all") return;
            commit(keys);
            // Pointer selection leaves focus on the pressed item (RAC re-asserts it after the
            // press completes); hand focus back to the filter on the next frame so typing keeps
            // working. An immediate focus() here loses that race.
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          items={filtered}
          className="min-h-0 flex-1 scroll-py-1 overflow-y-auto overscroll-contain p-1 outline-none"
        >
          {(item) => (
            <ListBoxItem
              key={getKey(item)}
              id={getKey(item)}
              textValue={itemLabel(item)}
              data-item-id={getKey(item)}
              data-slot="combobox-item"
              className="group/combobox-item relative flex min-h-10 w-full cursor-default items-center gap-2 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-focused:bg-ob-hover data-focused:text-ob-hover-foreground pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              {itemLabel(item)}
              {itemSecondary?.(item)}
              <IconCheck
                data-slot="combobox-item-indicator"
                className="pointer-events-none absolute right-2 size-4 opacity-0 group-data-selected/combobox-item:text-ob-hover-foreground group-data-selected/combobox-item:opacity-100"
              />
            </ListBoxItem>
          )}
        </ListBox>
        {filtered.length === 0 && (
          <div
            data-slot="combobox-empty"
            className="w-full py-2 text-center text-sm text-muted-foreground"
          >
            {emptyText}
          </div>
        )}
      </Popover>
    </div>
  );
}
