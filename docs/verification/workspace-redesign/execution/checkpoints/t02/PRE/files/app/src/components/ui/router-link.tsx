import { Link, type LinkProps } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

type AnchorProps = Omit<
  ComponentPropsWithoutRef<"a">,
  "className" | "children" | "href"
>;

/**
 * A router link drawn with the button vocabulary. It is a real `<a>`: the browser keeps new-tab,
 * middle-click and modifier-key behaviour, and nothing is nested inside a `<button>` (or vice
 * versa). Use it wherever a button is really navigation — never `Button render={<Link />}`, which
 * would put `role="button"` on the anchor.
 *
 * Pass `to` (+ `params`/`search`) for an in-app route, or `href` for an external URL. The two are
 * mutually exclusive by intent; `href` wins when both are present.
 */
export type ButtonLinkProps = AnchorProps & {
  to?: LinkProps["to"];
  params?: LinkProps["params"];
  search?: LinkProps["search"];
  /** Router-supplied classes for the active route, e.g. a sidebar row's current-state wash. */
  activeProps?: LinkProps["activeProps"];
  inactiveProps?: LinkProps["inactiveProps"];
  href?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
};

export function ButtonLink({
  to,
  params,
  search,
  activeProps,
  inactiveProps,
  href,
  variant = "default",
  size = "default",
  className,
  children,
  ...anchorProps
}: ButtonLinkProps) {
  const classes = buttonVariants({ variant, size, className });
  const shared = {
    "data-slot": "button",
    "data-size": size,
    "data-variant": variant,
    className: classes,
  } as const;

  if (href !== undefined) {
    return (
      <a {...anchorProps} {...shared} href={href}>
        {children}
      </a>
    );
  }

  return (
    <Link
      {...anchorProps}
      {...shared}
      activeProps={activeProps}
      inactiveProps={inactiveProps}
      params={params}
      search={search}
      to={to as NonNullable<LinkProps["to"]>}
    >
      {children}
    </Link>
  );
}
