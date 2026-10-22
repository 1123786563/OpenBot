import { Button as ButtonPrimitive } from "@heroui/react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  cloneElement,
  isValidElement,
  type ComponentPropsWithRef,
  type ReactElement,
  type Ref,
} from "react";

import { cn } from "@/lib/utils";

/*
 * The app's button vocabulary — six variants and eight sizes, unchanged since the shadcn wrappers.
 * These classes carry the shared workspace tokens and keep the app's public button vocabulary;
 * HeroUI supplies behaviour and state plumbing.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] duration-150 ease-out outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] active:not-aria-[haspopup]:translate-y-px active:transform-none pointer-coarse:min-h-11 pointer-coarse:min-w-11 disabled:pointer-events-none disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--ob-action)] text-[var(--ob-action-foreground)] hover:bg-[var(--ob-action-hover)]",
        outline:
          "border-[var(--ob-control-border)] bg-transparent text-foreground hover:bg-ob-hover hover:text-foreground aria-expanded:bg-ob-hover aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-ob-hover aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-ob-hover hover:text-foreground aria-expanded:bg-ob-hover aria-expanded:text-foreground",
        destructive:
          "bg-[var(--ob-danger-soft)] text-[var(--ob-danger)] hover:bg-[color-mix(in_srgb,var(--ob-danger)_16%,var(--ob-surface))]",
        link: "text-[var(--ob-accent-text)] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type AppVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type AppSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

/*
 * The app's names are not HeroUI's names, and must not become them:
 * `default` is the black action verb (HeroUI `primary`), `destructive` is the soft danger wash
 * (HeroUI `danger-soft`), and `link` is a text-only action (HeroUI `ghost` plus the underline
 * utilities already in the class string). Everything in between is resolved once, here.
 */
const HERO_VARIANT: Record<
  AppVariant,
  "primary" | "outline" | "secondary" | "ghost" | "danger-soft"
> = {
  default: "primary",
  outline: "outline",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "danger-soft",
  link: "ghost",
};

const HERO_SIZE: Record<AppSize, "sm" | "md" | "lg"> = {
  default: "md",
  xs: "sm",
  sm: "sm",
  lg: "lg",
  icon: "md",
  "icon-xs": "sm",
  "icon-sm": "sm",
  "icon-lg": "md",
};

const ICON_SIZES = new Set<AppSize>(["icon", "icon-xs", "icon-sm", "icon-lg"]);

type ButtonPrimitiveProps = ComponentPropsWithRef<typeof ButtonPrimitive>;

/** React Aria's `render` function for the replaced `<button>` element. */
type ButtonRenderFunction = Extract<
  NonNullable<ButtonPrimitiveProps["render"]>,
  (...args: never[]) => ReactElement
>;
type ButtonRenderDomProps = Parameters<ButtonRenderFunction>[0];
type ButtonRenderState = Parameters<ButtonRenderFunction>[1];

const EVENT_PROP = /^on[A-Z]/;

function mergeRefs(
  ...refs: (Ref<unknown> | undefined)[]
): Ref<unknown> {
  return (node: unknown) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as { current: unknown }).current = node;
    }
  };
}

/**
 * Merge the DOM props React Aria hands a `render` function into an existing element. The element
 * keeps its own props (`to`, `search`, `href`); only the shared plumbing is combined: classes go
 * through `cn`, styles and refs are joined, and two handlers on the same event both run once.
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
    } else if (key === "children") {
      merged[key] = fromElement ?? fromState;
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
 * Accepts both forms of `render`: React Aria's function, and a React element. The element form is
 * a compatibility adapter for call sites that have not moved to `ButtonLink` yet — it turns the
 * element into the equivalent render function by merging props. It does NOT make an anchor a
 * button: prefer `ButtonLink` for every router link.
 */
function adaptRender(
  render: ButtonProps["render"],
): ButtonRenderFunction | undefined {
  if (!isValidElement(render)) {
    return render as ButtonRenderFunction | undefined;
  }
  const element = render as ReactElement<Record<string, unknown>>;
  return (domProps: ButtonRenderDomProps, _state: ButtonRenderState) =>
    cloneElement(
      element,
      mergeRenderProps(
        domProps as unknown as Record<string, unknown>,
        element.props,
      ),
    );
}

export type ButtonProps = Omit<
  ButtonPrimitiveProps,
  "className" | "render" | "size" | "variant"
> &
  VariantProps<typeof buttonVariants> & {
    className?: string;
    /**
     * Plain DOM attributes the old `<button>` call sites still pass. React Aria's prop types drop
     * them, but they are inert here and forwarded through the spread like any other DOM prop.
     */
    title?: string;
    role?: ComponentPropsWithRef<"button">["role"];
    /**
     * The app's call sites say `disabled`; React Aria says `isDisabled`. Mapped in one place and
     * never forwarded, so the public button API stays unchanged.
     */
    disabled?: boolean;
    /**
     * React Aria's function, or a React element for call sites that still draw a link through the
     * button. Elements are adapted (see `adaptRender`); new link buttons should use `ButtonLink`.
     */
    render?: ButtonPrimitiveProps["render"] | ReactElement;
    /**
     * Base UI told the trigger whether the rendered element was native. RAC does not need it:
     * its `render` prop is typed over a button element and press handling follows the element.
     * Accepted and ignored so H03's combobox (which still passes it) compiles unchanged until
     * that wrapper migrates.
     *
     * @deprecated No effect. Remove at the call site.
     */
    nativeButton?: boolean;
  };

/**
 * IMPORTANT — `render` IS FOR BUTTONS.
 *
 * HeroUI's Button is React Aria's Button. Its `render` prop replaces the `<button>` element but
 * keeps button semantics (role, Space/Enter activation, `type`). Drawing an anchor through it
 * would put `role="button"` on a link and lose the browser's link behaviour — new tab,
 * middle-click, modifier keys. Every router-link button in the app therefore uses `ButtonLink`
 * from `router-link.tsx`, which draws a real `<a>` with these same visual classes and no nesting.
 */
function Button({
  className,
  variant = "default",
  size = "default",
  disabled,
  isDisabled,
  nativeButton: _nativeButton,
  render,
  ...props
}: ButtonProps) {
  const resolvedVariant = variant ?? "default";
  const resolvedSize = size ?? "default";

  return (
    <ButtonPrimitive
      data-slot="button"
      data-size={resolvedSize}
      data-variant={resolvedVariant}
      className={cn(
        buttonVariants({
          variant: resolvedVariant,
          size: resolvedSize,
          className,
        }),
      )}
      isDisabled={isDisabled ?? disabled}
      isIconOnly={ICON_SIZES.has(resolvedSize) || undefined}
      render={adaptRender(render)}
      size={HERO_SIZE[resolvedSize]}
      variant={HERO_VARIANT[resolvedVariant]}
      {...props}
    />
  );
}

export { Button, buttonVariants };
