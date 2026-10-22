import { Link, type LinkProps } from "@tanstack/react-router";
import type { VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { buttonVariants } from "@/components/ui/button";

type ButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "className" | "href">;

/**
 * A router link drawn with the button vocabulary. It is a real `<a>`: the browser keeps new-tab,
 * middle-click and modifier-key behaviour, and nothing is nested inside a `<button>` (or vice
 * versa). Use it wherever a button is really navigation — never `Button render={<Link />}`, which
 * would put `role="button"` on the anchor.
 *
 * Pass `to` (+ `params`/`search`) for an in-app route, or `href` for an external URL. The two are
 * mutually exclusive by intent; callers pass one destination.
 */
export type ButtonLinkProps = AnchorProps & {
  to?: LinkProps["to"];
  params?: LinkProps["params"];
  search?: LinkProps["search"];
  activeProps?: LinkProps["activeProps"];
  inactiveProps?: LinkProps["inactiveProps"];
  href?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
};

export function ButtonLink(props: ButtonLinkProps) {
  const { variant = "default", size = "default", className, children } = props;
  const classes = buttonVariants({ variant, size, className });
  const shared = {
    "data-slot": "button",
    "data-size": size,
    "data-variant": variant,
    className: classes,
  } as const;

  if (props.href !== undefined) {
    const {
      href,
      variant: _variant,
      size: _size,
      className: _className,
      children: _children,
      ...anchorProps
    } = props;
    return (
      <a {...anchorProps} {...shared} href={href}>
        {children}
      </a>
    );
  }

  const {
    to,
    params,
    search,
    activeProps,
    inactiveProps,
    variant: _variant,
    size: _size,
    className: _className,
    children: _children,
    ...anchorProps
  } = props;
  return (
    <Link
      {...anchorProps}
      {...shared}
      activeProps={activeProps}
      inactiveProps={inactiveProps}
      params={params}
      search={search}
      to={to}
    >
      {children}
    </Link>
  );
}
