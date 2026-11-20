import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { IconPlus } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { astryxPilot } from "./theme";

function NewBotLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} search={{ new: true }} to="/bots" />;
}

export function NewBotAction({ primary = false }: { primary?: boolean }) {
  if (astryxPilot) {
    return (
      <AstryxButton
        as={NewBotLink}
        href="/bots?new=true"
        icon={<IconPlus aria-hidden size={16} />}
        label="New Bot"
        variant={primary ? "primary" : "secondary"}
      />
    );
  }
  return (
    <Button
      render={(props) => <Link {...props} search={{ new: true }} to="/bots" />}
      size="sm"
      variant={primary ? "ghost" : "outline"}
    >
      <IconPlus />
      New Bot
    </Button>
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
  if (astryxPilot) {
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
  return (
    <Button {...props} disabled={disabled} size="lg" variant={variant}>
      {icon}
      {children}
    </Button>
  );
}
