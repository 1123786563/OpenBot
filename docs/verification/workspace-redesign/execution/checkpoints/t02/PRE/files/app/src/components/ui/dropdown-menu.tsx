/*
 * HeroUI Menu / Dropdown adapter.
 *
 * Required HeroUI CSS components (the orchestrator adds the imports to app/src/styles.css):
 *   @import "@heroui/styles/components/dropdown.css";
 *   @import "@heroui/styles/components/menu.css";
 *   @import "@heroui/styles/components/menu-item.css";
 *   @import "@heroui/styles/components/menu-section.css";
 *   @import "@heroui/styles/components/popover.css";
 *   @import "@heroui/styles/components/surface.css";
 *
 * The exported surface is the pre-migration one. HeroUI/React Aria supplies the collection,
 * keyboard and focus plumbing; the app's class vocabulary still decides how it looks.
 */
import { Dropdown, Header, Separator } from "@heroui/react";
import { IconCheck, IconChevronRight } from "@tabler/icons-react";
import type * as React from "react";
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentPropsWithRef,
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
  useContext,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type RenderFunction = (
  props: React.HTMLAttributes<HTMLElement> & Record<string, unknown>,
  state: Record<string, unknown>,
) => ReactElement;

/**
 * Both `render` forms Base UI accepted stay accepted: a React element (adapted by merging React
 * Aria's DOM props into it) or a function. The function signature is wide enough for Base UI's
 * `ComponentRenderFn` (whose state object is `{}`), so existing call sites typecheck unchanged.
 */
type RenderTarget = ReactElement | RenderFunction;

type AnyRenderFunction = (
  props: Record<string, unknown>,
  state: unknown,
) => ReactElement;

type MenuItemRenderFunction = Extract<
  NonNullable<ComponentProps<typeof Dropdown.Item>["render"]>,
  (...args: never[]) => ReactElement
>;
type MenuItemRenderDomProps = Parameters<MenuItemRenderFunction>[0];

type TriggerRenderFunction = Extract<
  NonNullable<ComponentProps<typeof Dropdown.Trigger>["render"]>,
  (...args: never[]) => ReactElement
>;

const EVENT_PROP = /^on[A-Z]/;

function mergeRefs(...refs: (Ref<unknown> | undefined)[]): Ref<unknown> {
  return (node: unknown) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as { current: unknown }).current = node;
    }
  };
}

/**
 * Merge a React Aria DOM props object into an existing element. The element keeps its own props
 * (`to`, `activeProps`, `variant`, …); only the shared plumbing is combined — classes through
 * `cn`, styles and refs joined, and two handlers on the same event both run once. Mirrors the
 * Button adapter so trigger composition behaves the same in both wrappers.
 */
function mergeRenderProps(
  domProps: Record<string, unknown>,
  elementProps: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...domProps, ...elementProps };
  for (const key of new Set([
    ...Object.keys(domProps),
    ...Object.keys(elementProps),
  ])) {
    const fromState = domProps[key];
    const fromElement = elementProps[key];
    if (key === "className") {
      merged[key] = cn(
        fromState as string | undefined,
        fromElement as string | undefined,
      );
    } else if (key === "style") {
      merged[key] = {
        ...(fromState as Record<string, unknown>),
        ...(fromElement as Record<string, unknown>),
      };
    } else if (key === "ref") {
      merged[key] = mergeRefs(
        fromState as Ref<unknown>,
        fromElement as Ref<unknown>,
      );
    } else if (
      EVENT_PROP.test(key) &&
      typeof fromState === "function" &&
      typeof fromElement === "function"
    ) {
      merged[key] = (event: unknown) => {
        fromState(event);
        fromElement(event);
      };
    }
  }
  return merged;
}

/**
 * Both `render` forms Base UI accepted stay accepted: a React element (adapted by merging React
 * Aria's DOM props into it) or a function. A function is called with the merged props, exactly as
 * React Aria would call its own render prop.
 */
function adaptRender(
  render: RenderTarget | undefined,
): AnyRenderFunction | undefined {
  if (!render) return undefined;
  if (!isValidElement(render)) {
    const fn = render as unknown as AnyRenderFunction;
    return (props, state) => fn(props, state);
  }
  const element = render as ReactElement<Record<string, unknown>>;
  return (domProps) =>
    cloneElement(element, mergeRenderProps(domProps, element.props));
}

/**
 * Always render an item through a function when we need to decorate the DOM node (checkbox and
 * radio roles, a `render` target, or a click handler the old API fired on the item itself).
 */
function adaptMenuItemRender(
  render: RenderTarget | undefined,
  decorate?: (props: Record<string, unknown>) => Record<string, unknown>,
): MenuItemRenderFunction | undefined {
  const adapted = adaptRender(render);
  if (!adapted && !decorate) return undefined;
  return (domProps: MenuItemRenderDomProps) => {
    const record = domProps as unknown as Record<string, unknown>;
    const merged = decorate ? decorate(record) : record;
    if (adapted) return adapted(merged, undefined);
    const tag = typeof merged.href === "string" ? "a" : "div";
    return createElement(
      tag,
      merged as ComponentPropsWithoutRef<"div"> & ComponentPropsWithoutRef<"a">,
    );
  };
}

function composeClick(
  domProps: Record<string, unknown>,
  onClick: MouseEventHandler<HTMLElement> | undefined,
): Record<string, unknown> {
  if (!onClick) return domProps;
  // A disabled item must not run the old API's click handler either. React Aria suppresses its own
  // activation, and the injected handler has to follow the same rule.
  const disabled =
    domProps["aria-disabled"] === true ||
    domProps["aria-disabled"] === "true" ||
    domProps["data-disabled"] !== undefined;
  if (disabled) return domProps;
  const fromAria = domProps.onClick;
  return {
    ...domProps,
    onClick: (event: unknown) => {
      onClick(event as React.MouseEvent<HTMLElement>);
      if (typeof fromAria === "function") fromAria(event);
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Root
 * -----------------------------------------------------------------------------------------------*/

type DropdownMenuProps = Omit<
  ComponentPropsWithRef<typeof Dropdown.Root>,
  "isOpen" | "onOpenChange" | "children"
> & {
  children?: ReactNode;
  /** The pre-migration names. `open`/`onOpenChange` map to React Aria's controlled state. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Base UI's `disabled`, applied to the trigger (React Aria has no disabled MenuTrigger). */
  disabled?: boolean;
};

const DropdownMenuDisabledContext = createContext(false);

function DropdownMenu({
  open,
  defaultOpen,
  onOpenChange,
  disabled = false,
  children,
  ...props
}: DropdownMenuProps) {
  return (
    <DropdownMenuDisabledContext.Provider value={disabled}>
      <Dropdown.Root
        data-slot="dropdown-menu"
        defaultOpen={defaultOpen}
        isOpen={open}
        onOpenChange={onOpenChange}
        {...props}
      >
        {children}
      </Dropdown.Root>
    </DropdownMenuDisabledContext.Provider>
  );
}

function DropdownMenuPortal({
  children,
  container,
}: {
  children?: ReactNode;
  /** Retained for API parity; React Aria's popover already portals to `document.body`. */
  container?: Element | null;
}) {
  if (container && typeof document !== "undefined") {
    return createPortal(children, container);
  }
  return <>{children}</>;
}

/** The interactive element. Exactly one — never the old Base UI trigger wrapped in a second button. */
type DropdownMenuTriggerProps = Omit<
  ComponentPropsWithRef<typeof Dropdown.Trigger>,
  "render" | "children" | "className"
> & {
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  render?: RenderTarget;
};

function DropdownMenuTrigger({
  children,
  className,
  disabled,
  render,
  ...props
}: DropdownMenuTriggerProps) {
  const rootDisabled = useContext(DropdownMenuDisabledContext);
  const adapted = adaptRender(render);
  const renderTrigger: TriggerRenderFunction | undefined = adapted
    ? (domProps) =>
        adapted(domProps as unknown as Record<string, unknown>, undefined)
    : undefined;

  return (
    <Dropdown.Trigger
      className={className}
      data-slot="dropdown-menu-trigger"
      isDisabled={disabled ?? rootDisabled}
      render={renderTrigger}
      {...props}
    >
      {children}
    </Dropdown.Trigger>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Content
 * -----------------------------------------------------------------------------------------------*/

type Side = "top" | "right" | "bottom" | "left" | "inline-start" | "inline-end";
type Align = "start" | "center" | "end";
type Placement = NonNullable<
  ComponentProps<typeof Dropdown.Popover>["placement"]
>;

const PLACEMENTS = {
  top: { start: "top start", center: "top", end: "top end" },
  bottom: { start: "bottom start", center: "bottom", end: "bottom end" },
  left: { start: "left top", center: "left", end: "left bottom" },
  right: { start: "right top", center: "right", end: "right bottom" },
  "inline-start": {
    start: "start top",
    center: "start",
    end: "start bottom",
  },
  "inline-end": { start: "end top", center: "end", end: "end bottom" },
} as const satisfies Record<Side, Record<Align, Placement>>;

function toPlacement(side: Side, align: Align): Placement {
  return PLACEMENTS[side][align];
}

type DropdownMenuContentProps = Omit<
  ComponentPropsWithRef<typeof Dropdown.Popover>,
  "children" | "className" | "placement" | "offset" | "crossOffset"
> & {
  children?: ReactNode;
  className?: string;
  align?: Align;
  alignOffset?: number;
  side?: Side;
  sideOffset?: number;
};

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  children,
  ...props
}: DropdownMenuContentProps) {
  return (
    <Dropdown.Popover
      className={cn(
        "z-50 max-h-[calc(100vh-16px)] w-(--trigger-width) min-w-32 origin-(--trigger-anchor-point) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
        className,
      )}
      crossOffset={alignOffset}
      offset={sideOffset}
      placement={toPlacement(side, align)}
      {...props}
    >
      <Dropdown.Menu className="outline-none" data-slot="dropdown-menu-content">
        {children}
      </Dropdown.Menu>
    </Dropdown.Popover>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Groups, labels, separators, shortcuts
 * -----------------------------------------------------------------------------------------------*/

type DropdownMenuGroupProps = ComponentPropsWithRef<typeof Dropdown.Section>;

function DropdownMenuGroup(props: DropdownMenuGroupProps) {
  return <Dropdown.Section data-slot="dropdown-menu-group" {...props} />;
}

type DropdownMenuLabelProps = ComponentPropsWithRef<typeof Header> & {
  inset?: boolean;
};

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: DropdownMenuLabelProps) {
  return (
    <Header
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className,
      )}
      data-inset={inset}
      data-slot="dropdown-menu-label"
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Items
 * -----------------------------------------------------------------------------------------------*/

const ITEM_CLASS =
  "group/dropdown-menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none focus:bg-ob-hover focus:text-ob-hover-foreground not-data-[variant=destructive]:focus:**:text-ob-hover-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive";

const CHECK_RADIO_ITEM_CLASS =
  "relative flex cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none focus:bg-ob-hover focus:text-ob-hover-foreground focus:**:text-ob-hover-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

type DropdownMenuItemProps = Omit<
  ComponentProps<typeof Dropdown.Item>,
  "children" | "onClick" | "disabled" | "isDisabled" | "render" | "variant"
> & {
  children?: ReactNode;
  className?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
  render?: RenderTarget;
};

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  disabled,
  onClick,
  render,
  ...props
}: DropdownMenuItemProps) {
  return (
    <Dropdown.Item
      className={cn(ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="dropdown-menu-item"
      data-variant={variant}
      isDisabled={disabled}
      render={adaptMenuItemRender(render, (domProps) =>
        composeClick(domProps, onClick),
      )}
      {...props}
    />
  );
}

/* Checkbox and radio items keep their own controlled API. They use a plain menu selection mode
 * (role overridden on the DOM node) so `checked`/`value` stay booleans and domain values, never
 * stringified collection keys. */
type DropdownMenuCheckboxItemProps = Omit<DropdownMenuItemProps, "variant"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  closeOnClick?: boolean;
};

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  onClick,
  render,
  closeOnClick = false,
  inset,
  ...props
}: DropdownMenuCheckboxItemProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultChecked);
  const isChecked = checked ?? uncontrolled;

  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setUncontrolled((value) => !value);
    onCheckedChange?.(!isChecked);
  };

  return (
    <Dropdown.Item
      className={cn(CHECK_RADIO_ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="dropdown-menu-checkbox-item"
      isDisabled={disabled}
      onAction={toggle}
      render={adaptMenuItemRender(render, (domProps) => {
        const withClick = composeClick(domProps, onClick);
        return {
          ...withClick,
          "aria-checked": isChecked,
          role: "menuitemcheckbox",
        };
      })}
      shouldCloseOnSelect={closeOnClick}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        {isChecked ? <IconCheck /> : null}
      </span>
      {children}
    </Dropdown.Item>
  );
}

type RadioGroupValue = {
  value: unknown;
  setValue: (value: unknown) => void;
  disabled: boolean;
};

const RadioGroupContext = createContext<RadioGroupValue | null>(null);

type DropdownMenuRadioGroupProps = Omit<
  ComponentPropsWithRef<typeof Dropdown.Section>,
  "children"
> & {
  children?: ReactNode;
  value?: unknown;
  defaultValue?: unknown;
  onValueChange?: (value: unknown) => void;
  disabled?: boolean;
};

function DropdownMenuRadioGroup({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  ...props
}: DropdownMenuRadioGroupProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const current = value === undefined ? uncontrolled : value;

  const setValue = (next: unknown) => {
    if (value === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };

  return (
    <RadioGroupContext.Provider value={{ value: current, setValue, disabled }}>
      <Dropdown.Section data-slot="dropdown-menu-radio-group" {...props}>
        {children}
      </Dropdown.Section>
    </RadioGroupContext.Provider>
  );
}

type DropdownMenuRadioItemProps = Omit<DropdownMenuItemProps, "variant"> & {
  /** The pre-migration value contract: any domain value, compared without stringifying. */
  value: unknown;
  closeOnClick?: boolean;
};

function DropdownMenuRadioItem({
  className,
  children,
  value,
  closeOnClick = false,
  disabled,
  onClick,
  render,
  inset,
  ...props
}: DropdownMenuRadioItemProps) {
  const group = useContext(RadioGroupContext);
  const isChecked = group ? Object.is(group.value, value) : false;
  const isDisabled = disabled || group?.disabled;

  const select = () => {
    if (isDisabled) return;
    group?.setValue(value);
  };

  return (
    <Dropdown.Item
      className={cn(CHECK_RADIO_ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="dropdown-menu-radio-item"
      isDisabled={isDisabled}
      onAction={select}
      render={adaptMenuItemRender(render, (domProps) => {
        const withClick = composeClick(domProps, onClick);
        return {
          ...withClick,
          "aria-checked": isChecked,
          role: "menuitemradio",
        };
      })}
      shouldCloseOnSelect={closeOnClick}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        {isChecked ? <IconCheck /> : null}
      </span>
      {children}
    </Dropdown.Item>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Submenus
 * -----------------------------------------------------------------------------------------------*/

type DropdownMenuSubProps = ComponentProps<typeof Dropdown.SubmenuTrigger>;

function DropdownMenuSub(props: DropdownMenuSubProps) {
  return <Dropdown.SubmenuTrigger data-slot="dropdown-menu-sub" {...props} />;
}

type DropdownMenuSubTriggerProps = Omit<DropdownMenuItemProps, "variant"> & {
  inset?: boolean;
};

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: DropdownMenuSubTriggerProps) {
  return (
    <DropdownMenuItem
      className={cn(
        "data-popup-open:bg-ob-hover data-popup-open:text-ob-hover-foreground data-open:bg-ob-hover data-open:text-ob-hover-foreground",
        className,
      )}
      data-inset={inset}
      data-slot="dropdown-menu-sub-trigger"
      {...props}
    >
      {children}
      <IconChevronRight className="ml-auto" />
    </DropdownMenuItem>
  );
}

type DropdownMenuSubContentProps = DropdownMenuContentProps;

function DropdownMenuSubContent({
  className,
  side = "right",
  align = "start",
  alignOffset = -3,
  sideOffset = 0,
  ...props
}: DropdownMenuSubContentProps) {
  return (
    <DropdownMenuContent
      align={align}
      alignOffset={alignOffset}
      className={cn("w-auto min-w-[96px]", className)}
      data-slot="dropdown-menu-sub-content"
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Separator and shortcut
 * -----------------------------------------------------------------------------------------------*/

type DropdownMenuSeparatorProps = ComponentPropsWithRef<typeof Separator>;

function DropdownMenuSeparator({
  className,
  ...props
}: DropdownMenuSeparatorProps) {
  return (
    <Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/dropdown-menu-item:text-ob-hover-foreground",
        className,
      )}
      data-slot="dropdown-menu-shortcut"
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
