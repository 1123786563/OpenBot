import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { ComponentProps, ReactNode } from "react";

export function RoutineAction({
  children,
  disabled,
  icon,
  style,
  variant = "default",
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  children: string;
  icon?: ReactNode;
  variant?: "default" | "destructive" | "ghost" | "outline";
}) {
  return (
    <AstryxButton
      {...props}
      icon={icon}
      isDisabled={disabled}
      label={children}
      size="sm"
      style={{
        minBlockSize: "var(--spacing-11, 2.75rem)",
        minInlineSize: "var(--spacing-11, 2.75rem)",
        ...style,
      }}
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
