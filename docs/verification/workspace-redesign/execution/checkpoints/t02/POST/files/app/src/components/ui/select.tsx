import {
  Header,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Select as SelectPrimitive,
  type SelectRootProps,
} from "@heroui/react";
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconSelector,
} from "@tabler/icons-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * React Aria hardcodes `role="button"` on the select trigger. ARIA's select-only combobox
 * pattern (and every existing call site/test) expects `role="combobox"`, so the adapter widens
 * the type by exactly that one attribute and forwards it; the cast is the narrowest way to say
 * "RAC accepts this attribute at runtime but does not declare it".
 */
const TriggerWithRole = SelectPrimitive.Trigger as React.ComponentType<
  React.ComponentProps<typeof SelectPrimitive.Trigger> & { role?: string }
>;

/*
 * SELECT — Base UI API, HeroUI v3 (React Aria) behaviour.
 *
 * React Aria collections key items by `string | number` (`Key`). The app's values are domain
 * values: strings, numbers, and — for a few call sites — objects whose identity is the value.
 * Every value therefore crosses the boundary through `keyForValue`/`valueForKey`: numbers stay
 * numbers, `null` stays "no selection", and objects keep their identity through a WeakMap. No
 * call site stringifies a domain id, and nothing here does either.
 *
 * The rest is a compound-component translation:
 *   Select               → HeroUI Select (React Aria Select), `value`/`onChange` on keys
 *   SelectTrigger        → HeroUI Select.Trigger (a real <button role="combobox">)
 *   SelectValue          → our own <span>; React Aria's SelectValue would repeat the item's
 *                          checkmark because our items render one
 *   SelectContent        → Select.Popover + ListBox (portalled by React Aria)
 *   SelectItem           → ListBoxItem, `value` → `id`, `label`/`textValue` → `textValue`
 *   SelectGroup/Label    → ListBoxSection/Header
 *   SelectSeparator      → a section-displayed rule (React Aria collections drop bare <div>s)
 *   Scroll buttons       → a sticky affordance; React Aria scrolls the list itself
 *
 * Required HeroUI CSS (owned by the orchestrator, not imported here): select.css,
 * list-box.css, popover.css, label.css.
 */

/* -------------------------------------------------------------------------------------------------
 * Domain value ↔ React Aria key
 * ----------------------------------------------------------------------------------------------- */

/**
 * Object keys are identity keys. The WeakMap keeps two renders of the same option object on the
 * same key, and `KEY_VALUES` is how a key comes back as the caller's exact value. It only holds
 * values that have actually been used as options/selection, so its size is bounded by the app's
 * option vocabulary.
 */
const objectKeys = new WeakMap<object, string>();
const symbolKeys = new Map<symbol, string>();
const keyValues = new Map<string, unknown>();
let nextObjectKey = 0;

function keyForValue(value: unknown): string {
  switch (typeof value) {
    case "string":
      return `s:${value}`;
    case "number":
      return `n:${Object.is(value, -0) ? "-0" : String(value)}`;
    case "bigint":
      return `bi:${value.toString()}`;
    case "boolean":
      return `bo:${value}`;
    case "symbol": {
      let key = symbolKeys.get(value);
      if (key === undefined) {
        key = `sy:${nextObjectKey++}`;
        symbolKeys.set(value, key);
        keyValues.set(key, value);
      }
      return key;
    }
    case "object": {
      if (value === null) {
        // Callers never reach here for null; a null key would mean "nothing selected".
        throw new Error("keyForValue(null) has no key");
      }
      let key = objectKeys.get(value);
      if (key === undefined) {
        key = `o:${nextObjectKey++}`;
        objectKeys.set(value, key);
        keyValues.set(key, value);
      }
      return key;
    }
    default:
      // Functions and `undefined` are object-like for key purposes.
      if (typeof value === "function") {
        let key = objectKeys.get(value);
        if (key === undefined) {
          key = `f:${nextObjectKey++}`;
          objectKeys.set(value, key);
          keyValues.set(key, value);
        }
        return key;
      }
      throw new Error(`keyForValue(${String(value)}) has no key`);
  }
}

type CollectionKey = string | number;

function valueForKey(key: CollectionKey): unknown {
  if (typeof key === "number") return key;
  if (key.startsWith("s:")) return key.slice(2);
  if (key.startsWith("n:")) {
    return key === "n:-0" ? -0 : Number(key.slice(2));
  }
  if (key.startsWith("bi:")) return BigInt(key.slice(3));
  if (key.startsWith("bo:")) return key.slice(3) === "true";
  return keyValues.get(key);
}

/* -------------------------------------------------------------------------------------------------
 * Base UI item metadata (`items` is used only to label the closed trigger)
 * ----------------------------------------------------------------------------------------------- */

type SelectOption<T> = { label: React.ReactNode; value: T };
type SelectItemGroup<T> = { items: readonly SelectOption<T>[] };
export type SelectItems<T> =
  | Readonly<Record<string, React.ReactNode>>
  | readonly SelectOption<T>[]
  | readonly SelectItemGroup<T>[];

function isGroupedItems<T>(
  items: SelectItems<T> | undefined,
): items is readonly SelectItemGroup<T>[] {
  return Array.isArray(items) && items.length > 0 && "items" in (items[0] ?? {});
}

/** Base UI's `serializeValue`, kept verbatim: object values fall back to JSON, never "[object]". */
function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringifyAsLabel(
  value: unknown,
  itemToStringLabel?: (value: never) => string,
): string {
  if (itemToStringLabel && value != null) {
    return itemToStringLabel(value as never) ?? "";
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.label != null) return String(record.label);
    if ("value" in record) return String(record.value);
  }
  return serializeValue(value);
}

/** Base UI's `resolveSelectedLabel`, including the raw-value fallback a revoked scope relies on. */
function resolveSelectedLabel(
  value: unknown,
  items: SelectItems<unknown> | undefined,
  itemToStringLabel?: (value: never) => string,
): React.ReactNode {
  const fallback = () => stringifyAsLabel(value, itemToStringLabel);
  if (itemToStringLabel && value != null) return itemToStringLabel(value as never);
  if (value && typeof value === "object" && "label" in value) {
    const label = (value as { label?: React.ReactNode }).label;
    if (label != null) return label;
  }
  if (items && !Array.isArray(items)) {
    return (
      (items as Readonly<Record<string, React.ReactNode>>)[String(value)] ??
      fallback()
    );
  }
  if (Array.isArray(items)) {
    const flat = isGroupedItems(items)
      ? items.flatMap((group) => group.items)
      : (items as readonly SelectOption<unknown>[]);
    if (value == null || typeof value !== "object") {
      const match = flat.find((item) => item.value === value);
      if (match?.label != null) return match.label;
      return fallback();
    }
    const candidate =
      "value" in value ? (value as { value?: unknown }).value : undefined;
    const match = flat.find((item) => {
      if (item.value === value) return true;
      if (candidate === undefined) return false;
      if (item.value === candidate) return true;
      return (
        item.value !== null &&
        typeof item.value === "object" &&
        "value" in item.value &&
        (item.value as { value?: unknown }).value === candidate
      );
    });
    if (match?.label != null) return match.label;
  }
  return fallback();
}

function hasSelectedValue(
  value: unknown,
  multiple: boolean,
  itemToStringValue?: (value: never) => string,
): boolean {
  if (value === null || value === undefined) return false;
  if (multiple && Array.isArray(value)) return value.length > 0;
  return stringifyAsValue(value, itemToStringValue) !== "";
}

function stringifyAsValue(
  value: unknown,
  itemToStringValue?: (value: never) => string,
): string {
  if (itemToStringValue && value != null) {
    return itemToStringValue(value as never) ?? "";
  }
  if (value && typeof value === "object" && "value" in value && "label" in value) {
    return serializeValue((value as { value?: unknown }).value);
  }
  return serializeValue(value);
}

/** The text React Aria needs for typeahead and its hidden <select>. */
function textValueFor(
  value: unknown,
  children: React.ReactNode,
  explicit: string | undefined,
  items: SelectItems<unknown> | undefined,
  itemToStringLabel?: (value: never) => string,
): string | undefined {
  if (explicit) return explicit;
  const fromChildren = textFromNode(children);
  if (fromChildren !== undefined) return fromChildren;
  const label = resolveSelectedLabel(value, items, itemToStringLabel);
  if (typeof label === "string" || typeof label === "number") return String(label);
  return undefined;
}

function textFromNode(node: React.ReactNode): string | undefined {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    const parts = node.map(textFromNode).filter((part) => part !== undefined);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }
  return undefined;
}

/* -------------------------------------------------------------------------------------------------
 * Root
 * ----------------------------------------------------------------------------------------------- */

type SelectChangeDetails = { reason: string };

type HeroSelectProps = SelectRootProps<object>;

export type SelectProps<T> = Omit<
  HeroSelectProps,
  | "value"
  | "defaultValue"
  | "onChange"
  | "onSelectionChange"
  | "selectedKey"
  | "defaultSelectedKey"
  | "selectionMode"
  | "items"
  | "children"
  | "className"
  | "isDisabled"
  | "isRequired"
  | "onOpenChange"
  | "isOpen"
  | "defaultOpen"
> & {
  value?: T | null;
  defaultValue?: T | null;
  onValueChange?: (value: T | null, details: SelectChangeDetails) => void;
  /**
   * Base UI metadata for the closed trigger's label. It is never handed to React Aria: a record
   * is not an Iterable and the selection is rendered by our `SelectValue`.
   */
  items?: SelectItems<T>;
  itemToStringLabel?: (value: T) => string;
  itemToStringValue?: (value: T) => string;
  isItemEqualToValue?: (itemValue: T, value: T) => boolean;
  multiple?: boolean;
  disabled?: boolean;
  required?: boolean;
  /** Base UI-only: React Aria Select has no read-only state. Accepted and not forwarded. */
  readOnly?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, details: SelectChangeDetails) => void;
  className?: string;
  children?: React.ReactNode;
};

type SelectRootContextValue = {
  value: unknown;
  multiple: boolean;
  items: SelectItems<unknown> | undefined;
  itemToStringLabel: ((value: never) => string) | undefined;
  isPlaceholder: boolean;
};

const SelectRootContext = React.createContext<SelectRootContextValue | null>(
  null,
);

function useSelectRoot(): SelectRootContextValue {
  const context = React.useContext(SelectRootContext);
  if (!context) {
    throw new Error("Select parts must be used inside <Select>");
  }
  return context;
}

function Select<T>({
  value,
  defaultValue,
  onValueChange,
  items,
  itemToStringLabel,
  itemToStringValue,
  isItemEqualToValue: _isItemEqualToValue,
  multiple = false,
  disabled,
  required,
  readOnly: _readOnly,
  open,
  defaultOpen,
  onOpenChange,
  className,
  children,
  // React Aria's `validate` is typed for one selection mode only; the app does not use it, and
  // forwarding it would make the dynamic selectionMode generic unsatisfiable.
  validate: _validate,
  ...props
}: SelectProps<T>) {
  const isControlled = value !== undefined;
  const [uncontrolled, setUncontrolled] = React.useState<T | null>(
    () => defaultValue ?? null,
  );
  const current = (isControlled ? value : uncontrolled) as
    | T
    | T[]
    | null
    | undefined;

  const setCurrent = React.useCallback(
    (next: unknown, reason: string) => {
      if (!isControlled) setUncontrolled(next as T | null);
      onValueChange?.(next as T | null, { reason });
    },
    [isControlled, onValueChange],
  );

  const selectionKeys: CollectionKey | readonly CollectionKey[] | null = multiple
    ? Array.isArray(current)
      ? current.map((entry) => keyForValue(entry))
      : current == null
        ? []
        : [keyForValue(current)]
    : current == null || Array.isArray(current)
      ? null
      : keyForValue(current);

  const handleChange = (next: CollectionKey | CollectionKey[] | null) => {
    if (multiple) {
      const keys = Array.isArray(next) ? next : next == null ? [] : [next];
      setCurrent(
        keys.map((key) => valueForKey(key)),
        "item-press",
      );
      return;
    }
    const key = Array.isArray(next) ? (next[0] ?? null) : next;
    setCurrent(key == null ? null : valueForKey(key), "item-press");
  };

  const context: SelectRootContextValue = {
    value: current,
    multiple,
    items: items as SelectItems<unknown> | undefined,
    itemToStringLabel: itemToStringLabel as
      | ((value: never) => string)
      | undefined,
    isPlaceholder: !hasSelectedValue(
      current,
      multiple,
      itemToStringValue as ((value: never) => string) | undefined,
    ),
  };

  return (
    <SelectRootContext.Provider value={context}>
      <SelectPrimitive
        data-slot="select-root"
        className={className}
        isDisabled={disabled}
        isRequired={required}
        isOpen={open}
        defaultOpen={defaultOpen}
        selectionMode={multiple ? "multiple" : "single"}
        allowsEmptyCollection={props.allowsEmptyCollection ?? true}
        value={selectionKeys}
        onChange={handleChange}
        onOpenChange={(nextOpen) =>
          onOpenChange?.(nextOpen, {
            reason: nextOpen ? "trigger-press" : "escape-key",
          })
        }
        {...props}
      >
        {children}
      </SelectPrimitive>
    </SelectRootContext.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Parts
 * ----------------------------------------------------------------------------------------------- */

function SelectGroup({
  className,
  ...props
}: React.ComponentProps<typeof ListBoxSection>) {
  return (
    <ListBoxSection
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      {...props}
    />
  );
}

function SelectValue({
  className,
  children,
  placeholder,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  children?: React.ReactNode | ((value: unknown) => React.ReactNode);
  placeholder?: React.ReactNode;
}) {
  const { value, multiple, items, itemToStringLabel, isPlaceholder } =
    useSelectRoot();

  let rendered: React.ReactNode = null;
  if (typeof children === "function") {
    rendered = children(value);
  } else if (children != null) {
    rendered = children;
  } else if (isPlaceholder) {
    rendered = placeholder;
  } else if (multiple && Array.isArray(value)) {
    rendered = value
      .map((entry) => resolveSelectedLabel(entry, items, itemToStringLabel))
      .reduce<React.ReactNode[]>((parts, label, index) => {
        if (index > 0) parts.push(", ");
        parts.push(label);
        return parts;
      }, []);
  } else {
    rendered = resolveSelectedLabel(value, items, itemToStringLabel);
  }

  return (
    <span
      data-slot="select-value"
      data-placeholder={isPlaceholder ? "" : undefined}
      className={cn("flex flex-1 text-left", className)}
      {...props}
    >
      {rendered}
    </span>
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  disabled,
  ...props
}: Omit<
  React.ComponentProps<typeof SelectPrimitive.Trigger>,
  "disabled" | "isDisabled" | "children"
> & {
  size?: "sm" | "default";
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const { isPlaceholder } = useSelectRoot();
  return (
    <TriggerWithRole
      data-slot="select-trigger"
      data-size={size}
      data-placeholder={isPlaceholder ? "" : undefined}
      /*
       * Base UI's trigger is a select-only combobox, and the app's call sites and tests address it
       * that way (`getByRole("combobox")`). React Aria draws a plain button with
       * aria-haspopup="listbox"; restoring the role keeps the public contract.
       */
      role="combobox"
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 data-placeholder:text-muted-foreground data-[size=default]:h-9 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] pointer-coarse:min-h-11 pointer-coarse:min-w-11 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      isDisabled={disabled}
      {...props}
    >
      {children}
      <IconSelector className="pointer-events-none size-4 text-muted-foreground" />
    </TriggerWithRole>
  );
}

type Side = "top" | "bottom" | "left" | "right" | "inline-start" | "inline-end";
type Align = "start" | "center" | "end";

/** The subset of React Aria's `Placement` this wrapper can produce. */
type HeroPlacement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "top start"
  | "top end"
  | "bottom start"
  | "bottom end"
  | "left top"
  | "left bottom"
  | "right top"
  | "right bottom";

/**
 * Base UI's side/align pair → React Aria's placement. `inline-start`/`inline-end` collapse to
 * left/right: the app is LTR, and React Aria's logical placement is chosen from the locale.
 */
function placementFor(side: Side, align: Align): HeroPlacement {
  if (side === "inline-start") return align === "end" ? "left bottom" : "left top";
  if (side === "inline-end") return align === "end" ? "right bottom" : "right top";
  if (side === "left") return align === "end" ? "left bottom" : "left top";
  if (side === "right") return align === "end" ? "right bottom" : "right top";
  if (align === "center") return side;
  return `${side} ${align}`;
}

const SelectPopoverContext = React.createContext<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  canScrollUp: boolean;
  canScrollDown: boolean;
} | null>(null);

function useScrollEdges(ref: React.RefObject<HTMLElement | null>) {
  const [edges, setEdges] = React.useState({ up: false, down: false });
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const up = node.scrollTop > 1;
      const down = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      setEdges((previous) =>
        previous.up === up && previous.down === down ? previous : { up, down },
      );
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [ref]);
  return edges;
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Popover>, "placement" | "offset" | "crossOffset"> & {
  side?: Side;
  sideOffset?: number;
  align?: Align;
  alignOffset?: number;
  /**
   * Base UI aligns the selected option with the trigger. React Aria has no equivalent
   * (it positions the popover against the trigger box), so the flag is accepted, reflected in
   * `data-align-trigger` for styling, and otherwise ignored — a browser-only visual difference.
   */
  alignItemWithTrigger?: boolean;
}) {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const edges = useScrollEdges(scrollRef);

  return (
    <SelectPrimitive.Popover
      ref={scrollRef}
      data-slot="select-content"
      data-align-trigger={alignItemWithTrigger}
      placement={placementFor(side, align)}
      offset={sideOffset}
      crossOffset={alignOffset}
      className={cn(
        "relative isolate z-50 max-h-[min(320px,calc(100dvh-32px))] min-w-36 overflow-x-hidden overflow-y-auto rounded-lg bg-overlay text-overlay-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-[placement=bottom]:slide-in-from-top-2 data-[placement=left]:slide-in-from-right-2 data-[placement=right]:slide-in-from-left-2 data-[placement=top]:slide-in-from-bottom-2 data-[entering]:animate-in data-[entering]:fade-in-0 data-[entering]:zoom-in-95 data-[exiting]:animate-out data-[exiting]:fade-out-0 data-[exiting]:zoom-out-95",
        className,
      )}
      {...props}
    >
      <SelectPopoverContext.Provider
        value={{
          scrollRef,
          canScrollUp: edges.up,
          canScrollDown: edges.down,
        }}
      >
        <SelectScrollUpButton />
        <ListBox data-slot="select-listbox">{children}</ListBox>
        <SelectScrollDownButton />
      </SelectPopoverContext.Provider>
    </SelectPrimitive.Popover>
  );
}

function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof Header>) {
  return (
    <Header
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  value,
  disabled,
  label,
  textValue,
  ...props
}: Omit<
  React.ComponentProps<typeof ListBoxItem>,
  "id" | "value" | "children" | "className" | "isDisabled" | "textValue"
> & {
  value?: unknown;
  disabled?: boolean;
  /** Base UI's typeahead label. */
  label?: string;
  /** React Aria's equivalent; `label` wins when both are given. */
  textValue?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const { items, itemToStringLabel } = useSelectRoot();
  const text = textValueFor(
    value,
    children,
    label ?? textValue,
    items,
    itemToStringLabel,
  );

  return (
    <ListBoxItem
      data-slot="select-item"
      id={value === null || value === undefined ? undefined : keyForValue(value)}
      textValue={text}
      isDisabled={disabled}
      className={cn(
        "relative flex min-h-9 w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-focused:bg-ob-hover data-focused:text-ob-hover-foreground data-hovered:bg-ob-hover data-hovered:text-ob-hover-foreground data-disabled:pointer-events-none data-disabled:text-[var(--ob-disabled-foreground)] data-disabled:opacity-100 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      {(state) => (
        <>
          <span
            data-slot="select-item-text"
            className="flex flex-1 shrink-0 gap-2 whitespace-nowrap"
          >
            {typeof children === "function"
              ? (children as (state: unknown) => React.ReactNode)(state)
              : children}
          </span>
          {state.isSelected ? (
            <span
              data-slot="select-item-indicator"
              className="pointer-events-none absolute right-2 flex size-4 items-center justify-center"
            >
              <IconCheck className="pointer-events-none" />
            </span>
          ) : null}
        </>
      )}
    </ListBoxItem>
  );
}

/**
 * React Aria collections only materialise Item/Section nodes, so a bare separator would vanish.
 * A section heading renders in place and can be drawn as the old rule; it is hidden from
 * assistive technology because a divider carries no meaning inside a listbox.
 */
function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <ListBoxSection aria-hidden>
      <Header className="p-0">
        <div
          data-slot="select-separator"
          className={cn(
            "pointer-events-none -mx-1 my-1 h-px w-full bg-border",
            className,
          )}
          {...props}
        />
      </Header>
    </ListBoxSection>
  );
}

const SCROLL_STEP = 32;

function SelectScrollButton({
  direction,
  className,
  ...props
}: React.ComponentProps<"div"> & { direction: "up" | "down" }) {
  const context = React.useContext(SelectPopoverContext);
  const isUp = direction === "up";
  const visible = context
    ? isUp
      ? context.canScrollUp
      : context.canScrollDown
    : false;
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };
  const scroll = () => {
    context?.scrollRef.current?.scrollBy({
      top: isUp ? -SCROLL_STEP : SCROLL_STEP,
    });
  };
  const start = () => {
    scroll();
    stop();
    timer.current = setInterval(scroll, 60);
  };
  React.useEffect(() => stop, []);

  if (!visible) return null;
  return (
    <div
      data-slot={isUp ? "select-scroll-up-button" : "select-scroll-down-button"}
      aria-hidden="true"
      className={cn(
        "sticky z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        isUp ? "top-0" : "bottom-0",
        className,
      )}
      onPointerEnter={start}
      onPointerLeave={stop}
      {...props}
    >
      {isUp ? <IconChevronUp /> : <IconChevronDown />}
    </div>
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <SelectScrollButton direction="up" className={className} {...props} />;
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <SelectScrollButton direction="down" className={className} {...props} />
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
