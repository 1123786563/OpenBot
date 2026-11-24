import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { ComponentProps, ReactNode } from "react";

import type { Button } from "@/components/ui/button";

type DeploymentButtonProps = Pick<
  ComponentProps<typeof Button>,
  "aria-pressed" | "disabled" | "form" | "onClick" | "type"
> & {
  children: string;
  className?: string;
  icon?: ReactNode;
  size?: "sm" | "lg";
  variant?: "default" | "outline" | "destructive";
};

export function DeploymentButton({
  children,
  disabled,
  icon,
  size = "sm",
  variant = "default",
  ...props
}: DeploymentButtonProps) {
  return (
    <AstryxButton
      {...props}
      icon={icon}
      isDisabled={disabled}
      label={children}
      size={size}
      variant={
        variant === "default"
          ? "primary"
          : variant === "outline"
            ? "secondary"
            : "destructive"
      }
    />
  );
}
