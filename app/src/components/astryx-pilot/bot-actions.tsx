import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps, MouseEventHandler, ReactNode } from "react";

function NewBotLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} search={{ new: true }} to="/bots" />;
}

export function NewBotAction({
  onClick,
  primary = false,
}: {
  onClick?: MouseEventHandler<HTMLElement>;
  primary?: boolean;
}) {
  return (
    <AstryxButton
      as={NewBotLink}
      href="/bots?new=true"
      icon={<IconPlus aria-hidden size={16} />}
      label="New Bot"
      onClick={onClick}
      variant={primary ? "primary" : "secondary"}
    />
  );
}

export function BotFormAction({
  children,
  icon,
  variant,
  disabled,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  children: string;
  icon?: ReactNode;
  variant?: "ghost" | "outline";
}) {
  const nativeButtonProps = { ...props, disabled };
  return (
    <AstryxButton
      {...nativeButtonProps}
      icon={icon}
      isDisabled={disabled}
      label={children}
      variant={variant === "outline" ? "secondary" : (variant ?? "primary")}
    />
  );
}
