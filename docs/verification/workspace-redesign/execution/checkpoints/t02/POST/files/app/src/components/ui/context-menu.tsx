/*
 * HeroUI Menu-based context menu adapter.
 *
 * Required HeroUI CSS components (already imported by app/src/styles.css):
 *   @import "@heroui/styles/components/menu.css";
 *   @import "@heroui/styles/components/menu-item.css";
 *   @import "@heroui/styles/components/menu-section.css";
 *   @import "@heroui/styles/components/popover.css";
 *   @import "@heroui/styles/components/separator.css";
 *   @import "@heroui/styles/components/surface.css";
 *
 * HeroUI's Menu is React Aria's Menu. React Aria positions an overlay against an anchor *element*,
 * not against pointer coordinates, and it has no context-menu trigger in its public HeroUI surface.
 * This adapter therefore owns the pointer side itself:
 *
 *   - the trigger wrapper (a plain, non-interactive <div> around the one real control) records
 *     right-click, Shift+F10 / ContextMenu-key, and touch long-press positions;
 *   - the root renders a 1px fixed-position anchor at that point and hands it to HeroUI's Popover
 *     as `triggerRef`, so React Aria's placement, flipping and viewport collision handling still
 *     run — only the anchor is synthetic;
 *   - dismiss (Escape, outside press, focus leaving), focus containment and focus restore come from
 *     React Aria's overlay stack, so they are the same code paths as HeroUI's Dropdown.
 *
 * Item, checkbox, radio, separator, group, label and submenu surfaces keep their pre-migration
 * names and value contracts. Radio values stay domain values and are compared with `Object.is`;
 * nothing is stringified into a collection key.
 */
import { Dropdown, Header, Menu, Popover, Separator } from "@heroui/react";
import { IconCheck, IconChevronRight } from "@tabler/icons-react";
import {
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------------------------------
 * Pointer plumbing shared by the root and the trigger
 * -----------------------------------------------------------------------------------------------*/

type Point = { x: number; y: number };

/** Base UI's trigger policy, stated once: 500 ms hold, cancelled by a 10 px drag. */
const LONG_PRESS_DELAY = 500;
const LONG_PRESS_MOVE_THRESHOLD = 10;

type ContextMenuRootValue = {
  open: boolean;
  disabled: boolean;
  /** Viewport coordinates of the last context-menu request; the anchor lives here. */
  point: Point | null;
  anchorRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLElement | null>;
  requestOpen: (point: Point | null) => void;
  setOpen: (open: boolean) => void;
};

const ContextMenuRootContext = createContext<ContextMenuRootValue | null>(null);

function useContextMenuRoot(): ContextMenuRootValue {
  const value = useContext(ContextMenuRootContext);
  if (!value) {
    throw new Error("Context menu parts must be used within <ContextMenu />");
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * Root
 * -----------------------------------------------------------------------------------------------*/

type ContextMenuProps = {
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Base UI's root-level `disabled`: no trigger path opens the menu. */
  disabled?: boolean;
};

function ContextMenu({
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  disabled = false,
}: ContextMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = open ?? uncontrolledOpen;
  const [point, setPoint] = useState<Point | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const setOpen = (next: boolean) => {
    if (open === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const requestOpen = (next: Point | null) => {
    if (disabled) return;
    setPoint(next);
    setOpen(true);
  };

  /* A programmatic open (controlled `open`, no pointer event) has no point of its own. Fall back
   * to the trigger's top-left corner so the menu is anchored to the row it belongs to. */
  useLayoutEffect(() => {
    if (!isOpen || point || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPoint({ x: rect.left, y: rect.top });
  }, [isOpen, point]);

  const value: ContextMenuRootValue = {
    open: isOpen,
    disabled,
    point,
    anchorRef,
    triggerRef,
    requestOpen,
    setOpen,
  };

  return (
    <ContextMenuRootContext.Provider value={value}>
      {children}
    </ContextMenuRootContext.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Trigger — right click, Shift+F10 / ContextMenu key, touch long-press
 * -----------------------------------------------------------------------------------------------*/

type ContextMenuTriggerProps = ComponentPropsWithoutRef<"div">;

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches("input, textarea, select") || target.isContentEditable)
  );
}

function ContextMenuTrigger({
  className,
  children,
  style,
  onContextMenu,
  onKeyDown,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
  ...props
}: ContextMenuTriggerProps) {
  const { requestOpen, disabled, triggerRef } = useContextMenuRoot();
  const longPress = useRef<{
    timer: ReturnType<typeof setTimeout>;
    point: Point;
  } | null>(null);
  /* Shift+F10 also fires a synthetic `contextmenu` event in most engines. Remember the keyboard
   * request briefly so that event does not re-anchor the menu at the browser's own coordinates
   * (0,0 in some browsers). */
  const keyboardRequest = useRef<{ point: Point; at: number } | null>(null);

  const cancelLongPress = () => {
    if (!longPress.current) return;
    clearTimeout(longPress.current.timer);
    longPress.current = null;
  };

  useEffect(() => cancelLongPress, []);

  return (
    <div
      {...props}
      ref={(node) => {
        triggerRef.current = node;
      }}
      className={cn("select-none", className)}
      data-slot="context-menu-trigger"
      style={{ WebkitTouchCallout: "none", ...style }}
      onContextMenu={(event) => {
        onContextMenu?.(event);
        if (event.defaultPrevented) return;
        /* The trigger area never shows the browser's own menu. */
        event.preventDefault();
        const keyboard = keyboardRequest.current;
        if (keyboard) {
          keyboardRequest.current = null;
          /* The synthetic event follows the keydown in the same task; anything later is a real
           * right click and must open at the pointer. */
          if (Date.now() - keyboard.at < 500) return;
        }
        cancelLongPress();
        requestOpen({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || disabled) return;
        const keyboardMenuKey =
          (event.key === "F10" && event.shiftKey) || event.key === "ContextMenu";
        if (!keyboardMenuKey || isEditableTarget(event.target)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const point = {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
        keyboardRequest.current = { point, at: Date.now() };
        cancelLongPress();
        requestOpen(point);
      }}
      onTouchStart={(event) => {
        onTouchStart?.(event);
        cancelLongPress();
        if (event.defaultPrevented || disabled) return;
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        const point = { x: touch.clientX, y: touch.clientY };
        const timer = setTimeout(() => {
          longPress.current = null;
          requestOpen(point);
        }, LONG_PRESS_DELAY);
        longPress.current = { timer, point };
      }}
      onTouchMove={(event) => {
        onTouchMove?.(event);
        const press = longPress.current;
        if (!press) return;
        if (event.touches.length !== 1) {
          cancelLongPress();
          return;
        }
        const touch = event.touches[0];
        if (
          Math.abs(touch.clientX - press.point.x) > LONG_PRESS_MOVE_THRESHOLD ||
          Math.abs(touch.clientY - press.point.y) > LONG_PRESS_MOVE_THRESHOLD
        ) {
          cancelLongPress();
        }
      }}
      onTouchEnd={(event) => {
        onTouchEnd?.(event);
        cancelLongPress();
      }}
      onTouchCancel={(event) => {
        onTouchCancel?.(event);
        cancelLongPress();
      }}
    >
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Content — the anchored popover plus the HeroUI Menu
 * -----------------------------------------------------------------------------------------------*/

type Side = "top" | "right" | "bottom" | "left" | "inline-start" | "inline-end";
type Align = "start" | "center" | "end";
type Placement = NonNullable<
  ComponentProps<typeof Popover.Content>["placement"]
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

const CONTENT_CLASS =
  "z-50 min-w-36 overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none";

function ContextMenuAnchor() {
  const { point, anchorRef } = useContextMenuRoot();
  if (!point || typeof document === "undefined") return null;

  /* Portalled to <body>: a `position: fixed` descendant would otherwise be captured by any
   * ancestor with `contain`/`transform` (the roster rows use `content-visibility: auto`). */
  return createPortal(
    <div
      ref={anchorRef}
      aria-hidden="true"
      data-slot="context-menu-anchor"
      style={{
        position: "fixed",
        left: point.x,
        top: point.y,
        width: 1,
        height: 1,
        pointerEvents: "none",
      }}
    />,
    document.body,
  );
}

function ContextMenuMenu({ children }: { children?: ReactNode }) {
  const { setOpen } = useContextMenuRoot();
  return (
    <Menu
      className="gap-0 p-0 outline-none"
      data-slot="context-menu-content"
      onClose={() => setOpen(false)}
    >
      {children}
    </Menu>
  );
}

type ContextMenuContentProps = {
  children?: ReactNode;
  className?: string;
  /** Which edge of the pointer the menu grows from; kept from the pre-migration positioning API. */
  side?: Side;
  align?: Align;
  sideOffset?: number;
  alignOffset?: number;
};

function ContextMenuContent({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 0,
  alignOffset = 0,
}: ContextMenuContentProps) {
  const { open, setOpen, anchorRef } = useContextMenuRoot();

  return (
    <>
      <ContextMenuAnchor />
      <Popover.Content
        className={cn(CONTENT_CLASS, className)}
        crossOffset={alignOffset}
        data-slot="context-menu-popover"
        isOpen={open}
        offset={sideOffset}
        onOpenChange={setOpen}
        placement={toPlacement(side, align)}
        trigger="ContextMenu"
        triggerRef={anchorRef}
      >
        <ContextMenuMenu>{children}</ContextMenuMenu>
      </Popover.Content>
    </>
  );
}

/** The popover already portals; the component stays for API compatibility. */
function ContextMenuPortal({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

/* -------------------------------------------------------------------------------------------------
 * Items
 *
 * Both `render` forms Base UI accepted stay accepted: a React element (adapted by merging React
 * Aria's DOM props into it) or a function. The function signature is wide enough for Base UI's
 * `ComponentRenderFn` (whose state object is `{}`), so existing call sites typecheck unchanged.
 * -----------------------------------------------------------------------------------------------*/

type RenderFunction = (
  props: ComponentPropsWithoutRef<"div"> & Record<string, unknown>,
  state: Record<string, unknown>,
) => ReactElement;

type RenderTarget = ReactElement | RenderFunction;

type AnyRenderFunction = (
  props: Record<string, unknown>,
  state: unknown,
) => ReactElement;

type MenuItemRenderFunction = Extract<
  NonNullable<ComponentProps<typeof Menu.Item>["render"]>,
  (...args: never[]) => ReactElement
>;
type MenuItemRenderDomProps = Parameters<MenuItemRenderFunction>[0];

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
      merged as ComponentPropsWithoutRef<"div"> &
        ComponentPropsWithoutRef<"a">,
    );
  };
}

function composeClick(
  domProps: Record<string, unknown>,
  onClick: MouseEventHandler<HTMLElement> | undefined,
): Record<string, unknown> {
  if (!onClick) return domProps;
  /* A disabled item must not run the old API's click handler either; React Aria suppresses its own
   * activation and the injected handler follows the same rule. */
  const disabled =
    domProps["aria-disabled"] === true ||
    domProps["aria-disabled"] === "true" ||
    domProps["data-disabled"] !== undefined;
  if (disabled) return { ...domProps, onClick: undefined };
  /* `domProps.onClick` is React Aria's own handler (it performs `onAction`, closes the menu, and
   * follows links). The old API's handler runs first, then React Aria's — never replacing it. */
  const fromAria = domProps.onClick;
  return {
    ...domProps,
    onClick: (event: unknown) => {
      onClick(event as MouseEvent<HTMLElement>);
      if (typeof fromAria === "function") fromAria(event);
    },
  };
}

const ITEM_CLASS =
  "group/context-menu-item relative flex min-h-9 cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive data-disabled:pointer-events-none data-disabled:text-[var(--ob-disabled-foreground)] data-disabled:opacity-100 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 focus:*:[svg]:text-ob-hover-foreground data-[variant=destructive]:*:[svg]:text-destructive";

const CHECK_RADIO_ITEM_CLASS =
  "relative flex min-h-9 cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none active:transform-none focus:bg-ob-hover focus:text-ob-hover-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:text-[var(--ob-disabled-foreground)] data-disabled:opacity-100 pointer-coarse:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

type ContextMenuItemProps = Omit<
  ComponentProps<typeof Menu.Item>,
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

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  disabled,
  onClick,
  render,
  ...props
}: ContextMenuItemProps) {
  return (
    <Menu.Item
      className={cn(ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="context-menu-item"
      data-variant={variant}
      isDisabled={disabled}
      render={adaptMenuItemRender(render, (domProps) =>
        composeClick(domProps, onClick),
      )}
      variant={variant === "destructive" ? "danger" : "default"}
      {...props}
    />
  );
}

/* Checkbox and radio items keep their own controlled API. They use a plain menu selection mode
 * (the role is overridden on the DOM node) so `checked`/`value` stay booleans and domain values,
 * never stringified collection keys. */
type ContextMenuCheckboxItemProps = Omit<ContextMenuItemProps, "variant"> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  closeOnClick?: boolean;
};

function ContextMenuCheckboxItem({
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
}: ContextMenuCheckboxItemProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultChecked);
  const isChecked = checked ?? uncontrolled;

  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setUncontrolled((value) => !value);
    onCheckedChange?.(!isChecked);
  };

  return (
    <Menu.Item
      className={cn(CHECK_RADIO_ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="context-menu-checkbox-item"
      isDisabled={disabled}
      onAction={toggle}
      render={adaptMenuItemRender(render, (domProps) => ({
        ...composeClick(domProps, onClick),
        "aria-checked": isChecked,
        role: "menuitemcheckbox",
      }))}
      shouldCloseOnSelect={closeOnClick}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2"
        data-slot="context-menu-checkbox-item-indicator"
      >
        {isChecked ? <IconCheck /> : null}
      </span>
      {children}
    </Menu.Item>
  );
}

type RadioGroupValue = {
  value: unknown;
  setValue: (value: unknown) => void;
  disabled: boolean;
};

const RadioGroupContext = createContext<RadioGroupValue | null>(null);

type ContextMenuRadioGroupProps = Omit<
  ComponentProps<typeof Menu.Section>,
  "children"
> & {
  children?: ReactNode;
  value?: unknown;
  defaultValue?: unknown;
  onValueChange?: (value: unknown) => void;
  disabled?: boolean;
};

function ContextMenuRadioGroup({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  ...props
}: ContextMenuRadioGroupProps) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const current = value === undefined ? uncontrolled : value;

  const setValue = (next: unknown) => {
    if (value === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };

  return (
    <RadioGroupContext.Provider value={{ value: current, setValue, disabled }}>
      <Menu.Section data-slot="context-menu-radio-group" {...props}>
        {children}
      </Menu.Section>
    </RadioGroupContext.Provider>
  );
}

type ContextMenuRadioItemProps = Omit<ContextMenuItemProps, "variant"> & {
  /** The pre-migration value contract: any domain value, compared without stringifying. */
  value: unknown;
  closeOnClick?: boolean;
};

function ContextMenuRadioItem({
  className,
  children,
  value,
  closeOnClick = false,
  disabled,
  onClick,
  render,
  inset,
  ...props
}: ContextMenuRadioItemProps) {
  const group = useContext(RadioGroupContext);
  const isChecked = group ? Object.is(group.value, value) : false;
  const isDisabled = disabled || group?.disabled;

  const select = () => {
    if (isDisabled) return;
    group?.setValue(value);
  };

  return (
    <Menu.Item
      className={cn(CHECK_RADIO_ITEM_CLASS, className)}
      data-inset={inset}
      data-slot="context-menu-radio-item"
      isDisabled={isDisabled}
      onAction={select}
      render={adaptMenuItemRender(render, (domProps) => ({
        ...composeClick(domProps, onClick),
        "aria-checked": isChecked,
        role: "menuitemradio",
      }))}
      shouldCloseOnSelect={closeOnClick}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2"
        data-slot="context-menu-radio-item-indicator"
      >
        {isChecked ? <IconCheck /> : null}
      </span>
      {children}
    </Menu.Item>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Groups, labels, separators, shortcuts
 * -----------------------------------------------------------------------------------------------*/

type ContextMenuGroupProps = ComponentProps<typeof Menu.Section>;

function ContextMenuGroup(props: ContextMenuGroupProps) {
  return <Menu.Section data-slot="context-menu-group" {...props} />;
}

type ContextMenuLabelProps = ComponentProps<typeof Header> & {
  inset?: boolean;
};

function ContextMenuLabel({
  className,
  inset,
  ...props
}: ContextMenuLabelProps) {
  return (
    <Header
      className={cn(
        "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
        className,
      )}
      data-inset={inset}
      data-slot="context-menu-label"
      {...props}
    />
  );
}

type ContextMenuSeparatorProps = ComponentProps<typeof Separator>;

function ContextMenuSeparator({
  className,
  ...props
}: ContextMenuSeparatorProps) {
  return (
    <Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      data-slot="context-menu-separator"
      {...props}
    />
  );
}

function ContextMenuShortcut({
  className,
  ...props
}: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-focus/context-menu-item:text-ob-hover-foreground",
        className,
      )}
      data-slot="context-menu-shortcut"
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------------------------------
 * Submenus
 *
 * React Aria's SubmenuTrigger takes the trigger item and the submenu popover as exactly two
 * children, so the pre-migration `<ContextMenuSub>` root is that pair.
 * -----------------------------------------------------------------------------------------------*/

type ContextMenuSubProps = {
  children: [ReactElement, ReactElement];
  delay?: number;
};

function ContextMenuSub({ children, delay }: ContextMenuSubProps) {
  return (
    <Dropdown.SubmenuTrigger data-slot="context-menu-sub" delay={delay}>
      {children}
    </Dropdown.SubmenuTrigger>
  );
}

type ContextMenuSubTriggerProps = ContextMenuItemProps;

function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: ContextMenuSubTriggerProps) {
  return (
    <ContextMenuItem
      className={cn(
        "data-popup-open:bg-ob-hover data-popup-open:text-ob-hover-foreground data-open:bg-ob-hover data-open:text-ob-hover-foreground",
        className,
      )}
      data-slot="context-menu-sub-trigger"
      {...props}
    >
      {children}
      <IconChevronRight className="ml-auto" />
    </ContextMenuItem>
  );
}

type ContextMenuSubContentProps = Omit<ContextMenuContentProps, "side" | "align">;

function ContextMenuSubContent({
  className,
  children,
  sideOffset = 0,
  alignOffset = -3,
}: ContextMenuSubContentProps) {
  const { setOpen } = useContextMenuRoot();

  return (
    <Popover.Content
      className={cn(CONTENT_CLASS, "shadow-lg", className)}
      crossOffset={alignOffset}
      data-slot="context-menu-sub-popover"
      offset={sideOffset}
      placement={toPlacement("right", "start")}
    >
      <Menu
        className="gap-0 p-0 outline-none"
        data-slot="context-menu-sub-content"
        onClose={() => setOpen(false)}
      >
        {children}
      </Menu>
    </Popover.Content>
  );
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuPortal,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
