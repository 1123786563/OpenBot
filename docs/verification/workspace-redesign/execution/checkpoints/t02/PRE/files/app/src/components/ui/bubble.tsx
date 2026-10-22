import { cva, type VariantProps } from "class-variance-authority";
import {
  type ComponentProps,
  type ComponentPropsWithRef,
  cloneElement,
  isValidElement,
  type ReactElement,
  type Ref,
} from "react";

import { cn } from "@/lib/utils";

function BubbleGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="bubble-group"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    />
  );
}

const bubbleVariants = cva(
  "group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "*:data-[slot=bubble-content]:bg-primary *:data-[slot=bubble-content]:text-primary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80",
        secondary:
          "*:data-[slot=bubble-content]:bg-secondary *:data-[slot=bubble-content]:text-secondary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        muted:
          "*:data-[slot=bubble-content]:bg-ob-muted-surface [&>[data-slot=bubble-content]:is(button,a):hover]:bg-ob-hover [&>[data-slot=bubble-content]:is(button,a):hover]:text-ob-hover-foreground",
        tinted:
          "*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)] *:data-[slot=bubble-content]:text-foreground dark:*:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)] [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)] dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]",
        outline:
          "*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-background [&>[data-slot=bubble-content]:is(button,a):hover]:bg-ob-muted-surface [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-input/30",
        ghost:
          "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-ob-muted-surface [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-ob-muted-surface/50",
        destructive:
          "*:data-[slot=bubble-content]:bg-destructive/10 *:data-[slot=bubble-content]:text-destructive dark:*:data-[slot=bubble-content]:bg-destructive/20 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/20 dark:[&>[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end";
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  );
}

type BubbleContentDomProps = ComponentPropsWithRef<"div"> & {
  "data-slot"?: string;
};

type BubbleContentState = { slot: "bubble-content" };

/**
 * Base UI's `useRender` render prop, kept without Base UI: a React element, or a function that
 * receives the merged props and `{ slot: "bubble-content" }` and returns the element to draw.
 * Call sites can use it to make the bubble content the message's one action (`<a>`, `<button>`).
 */
type BubbleContentProps = ComponentPropsWithRef<"div"> & {
  render?:
    | ReactElement
    | ((
        props: ComponentPropsWithRef<"div">,
        state: BubbleContentState,
      ) => ReactElement);
};

const EVENT_HANDLER = /^on[A-Z]/;

function mergeRefs<Instance>(
  ...refs: (Ref<Instance> | undefined)[]
): Ref<Instance> | undefined {
  const present = refs.filter(
    (ref): ref is NonNullable<Ref<Instance>> => ref != null,
  );
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return (instance) => {
    for (const ref of present) {
      if (typeof ref === "function") ref(instance);
      else ref.current = instance;
    }
  };
}

function asHandler(value: unknown): ((...args: unknown[]) => void) | undefined {
  return typeof value === "function"
    ? (value as (...args: unknown[]) => void)
    : undefined;
}

/**
 * The slice of Base UI's `mergeProps` that BubbleContent relies on: the replacement element's own
 * props win, except that `className` is tailwind-merged (its utilities win), `style` is
 * shallow-merged, every `ref` is attached, and two handlers on the same event both run — the
 * replacement element's first, matching Base UI's right-to-left order.
 */
function mergeContentProps(
  base: BubbleContentDomProps,
  override: ComponentPropsWithRef<"div">,
): ComponentPropsWithRef<"div"> {
  const merged: Record<string, unknown> = { ...base, ...override };
  merged.className = cn(base.className, override.className);
  merged.style = { ...base.style, ...override.style };
  merged.ref = mergeRefs(base.ref, override.ref);
  const baseProps = base as unknown as Record<string, unknown>;
  const overrideProps = override as unknown as Record<string, unknown>;
  for (const key of Object.keys(overrideProps)) {
    if (!EVENT_HANDLER.test(key)) continue;
    const ownHandler = asHandler(baseProps[key]);
    const overrideHandler = asHandler(overrideProps[key]);
    if (!ownHandler || !overrideHandler) continue;
    merged[key] = (...args: unknown[]) => {
      overrideHandler(...args);
      ownHandler(...args);
    };
  }
  return merged as unknown as ComponentPropsWithRef<"div">;
}

function BubbleContent({ className, render, ...props }: BubbleContentProps) {
  const domProps: BubbleContentDomProps = {
    "data-slot": "bubble-content",
    ...props,
    className: cn(
      "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/50",
      className,
    ),
  };

  if (typeof render === "function") {
    return render(domProps, { slot: "bubble-content" });
  }
  if (!render) return <div {...domProps} />;
  if (!isValidElement<ComponentPropsWithRef<"div">>(render)) return null;
  return cloneElement(render, mergeContentProps(domProps, render.props));
}

const bubbleReactionsVariants = cva(
  "absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-ob-muted-surface px-1.5 py-0.5 text-sm ring-3 ring-card has-[button]:p-0",
  {
    variants: {
      side: {
        top: "top-0 -translate-y-3/4",
        bottom: "bottom-0 translate-y-3/4",
      },
      align: {
        start: "left-3",
        end: "right-3",
      },
    },
    defaultVariants: {
      side: "bottom",
      align: "end",
    },
  },
);

function BubbleReactions({
  side = "bottom",
  align = "end",
  className,
  ...props
}: ComponentProps<"div"> & {
  align?: "start" | "end";
  side?: "top" | "bottom";
}) {
  return (
    <div
      data-slot="bubble-reactions"
      data-align={align}
      data-side={side}
      className={cn(bubbleReactionsVariants({ side, align }), className)}
      {...props}
    />
  );
}

export { Bubble, BubbleContent, BubbleGroup, BubbleReactions };
