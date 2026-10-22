/*
 * HeroUI Tooltip adapter.
 *
 * Required HeroUI CSS components (the orchestrator adds the imports to app/src/styles.css):
 *   @import "@heroui/styles/components/tooltip.css";
 *
 * Composition rule learned in H01: HeroUI's `Tooltip.Trigger` draws a `div[role=button]`. Wrapping
 * an existing button in it produces two interactive roles, so this adapter always passes a
 * `render` target and strips the synthetic `role` — the element the caller supplies (a Button, an
 * anchor, or the default real `<button>`) is the single interactive trigger. React Aria still
 * wires `aria-describedby`, hover and keyboard focus onto that element.
 */
import { Tooltip as TooltipPrimitive } from "@heroui/react";
import type * as React from "react";
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentPropsWithRef,
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useContext,
} from "react";
import { cn } from "@/lib/utils";

type RenderFunction = (
  props: React.HTMLAttributes<HTMLElement> & Record<string, unknown>,
  state: Record<string, unknown>,
) => ReactElement;

type RenderTarget = ReactElement | RenderFunction;

type AnyRenderFunction = (
  props: Record<string, unknown>,
  state: unknown,
) => ReactElement;

type TooltipTriggerRenderFunction = NonNullable<
  ComponentProps<typeof TooltipPrimitive.Trigger>["render"]
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

/** Same merge contract as the menu/button adapters: element props win, shared plumbing is joined. */
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

/* -------------------------------------------------------------------------------------------------
 * Provider
 * -----------------------------------------------------------------------------------------------*/

type TooltipDefaults = { delay?: number; closeDelay?: number };

const TooltipDefaultsContext = createContext<TooltipDefaults | undefined>(
  undefined,
);

/**
 * The app wraps its tree once and relied on a single provider-level delay. HeroUI has no provider
 * component, so the defaults live in React context and each root reads them.
 */
function TooltipProvider({
  delay = 0,
  closeDelay,
  children,
}: TooltipDefaults & { children?: ReactNode }) {
  return (
    <TooltipDefaultsContext.Provider value={{ delay, closeDelay }}>
      {children}
    </TooltipDefaultsContext.Provider>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Root
 * -----------------------------------------------------------------------------------------------*/

type TooltipProps = Omit<
  ComponentPropsWithRef<typeof TooltipPrimitive>,
  "children" | "delay" | "closeDelay" | "isOpen" | "onOpenChange"
> & {
  children?: ReactNode;
  delay?: number;
  closeDelay?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  delay,
  closeDelay,
  children,
  ...props
}: TooltipProps) {
  const defaults = useContext(TooltipDefaultsContext);
  return (
    <TooltipPrimitive
      closeDelay={closeDelay ?? defaults?.closeDelay}
      data-slot="tooltip"
      defaultOpen={defaultOpen}
      delay={delay ?? defaults?.delay}
      isOpen={open}
      onOpenChange={onOpenChange}
      {...props}
    >
      {children}
    </TooltipPrimitive>
  );
}

/* -------------------------------------------------------------------------------------------------
 * Trigger and content
 * -----------------------------------------------------------------------------------------------*/

type TooltipTriggerProps = Omit<
  ComponentPropsWithRef<"div">,
  "children" | "className" | "render"
> & {
  children?: ReactNode;
  className?: string;
  render?: RenderTarget;
};

function TooltipTrigger({ render, children, ...props }: TooltipTriggerProps) {
  const adapted = adaptRender(render);

  const renderTrigger: TooltipTriggerRenderFunction = (domProps) => {
    // The default HeroUI trigger is a div with a synthetic button role. Callers always bring their
    // own interactive element (or get a real button below), so the role must not be layered on top.
    const record = domProps as unknown as Record<string, unknown>;
    const { role: _role, ...rest } = record;
    if (adapted) return adapted(rest, undefined);
    return (
      <button
        {...(rest as ComponentPropsWithoutRef<"button">)}
        type={
          (rest.type as "button" | "submit" | "reset" | undefined) ?? "button"
        }
      />
    );
  };

  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      render={renderTrigger}
      {...props}
    >
      {children}
    </TooltipPrimitive.Trigger>
  );
}

type Side = "top" | "right" | "bottom" | "left" | "inline-start" | "inline-end";
type Align = "start" | "center" | "end";
type Placement = NonNullable<
  ComponentProps<typeof TooltipPrimitive.Content>["placement"]
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

type TooltipContentProps = Omit<
  ComponentPropsWithRef<typeof TooltipPrimitive.Content>,
  "children" | "className" | "placement" | "offset" | "crossOffset"
> & {
  children?: ReactNode;
  className?: string;
  align?: Align;
  alignOffset?: number;
  side?: Side;
  sideOffset?: number;
  /** The pre-migration tooltip always drew its little square arrow. */
  showArrow?: boolean;
};

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  showArrow = true,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Content
      className={cn(
        "z-50 inline-flex w-fit max-w-xs origin-(--trigger-anchor-point) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm",
        className,
      )}
      crossOffset={alignOffset}
      data-slot="tooltip-content"
      offset={sideOffset + (showArrow ? 4 : 0)}
      placement={toPlacement(side, align)}
      {...props}
    >
      {children}
      {showArrow ? (
        <TooltipPrimitive.Arrow className="z-50">
          <span className="block size-2.5 rotate-45 rounded-[2px] bg-foreground" />
        </TooltipPrimitive.Arrow>
      ) : null}
    </TooltipPrimitive.Content>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
