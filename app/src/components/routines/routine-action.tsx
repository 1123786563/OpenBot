import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { ComponentProps, ReactNode } from "react";
import { astryxPilot } from "@/components/astryx-pilot/theme";
import { Button } from "@/components/ui/button";

export function RoutineAction({
  children,
  disabled,
  icon,
  variant = "default",
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  children: string;
  icon?: ReactNode;
  variant?: "default" | "destructive" | "ghost" | "outline";
}) {
  if (astryxPilot) {
    return (
      <AstryxButton
        {...props}
        icon={icon}
        isDisabled={disabled}
        label={children}
        size="sm"
        variant={
          variant === "default"
            ? "primary"
            : variant === "outline"
              ? "secondary"
              : variant
        }
      />
    );
  }
  return (
    <Button {...props} disabled={disabled} size="sm" variant={variant}>
      {icon}
      {children}
    </Button>
  );
}
