import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { ComponentProps, ReactNode } from "react";
import { astryxPilot } from "@/components/astryx-pilot/theme";
import { Button } from "@/components/ui/button";

type DeploymentButtonProps = Pick<
  ComponentProps<typeof Button>,
  "aria-pressed" | "disabled" | "form" | "onClick" | "type"
> & {
  children: string;
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
  if (astryxPilot) {
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
  return (
    <Button {...props} disabled={disabled} size={size} variant={variant}>
      {icon}
      {children}
    </Button>
  );
}
