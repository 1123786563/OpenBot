import { Button, type ButtonVariant } from "@astryxdesign/core/Button";
import type { ComponentProps } from "react";

const variants = {
  default: "primary",
  outline: "secondary",
  ghost: "ghost",
  destructive: "destructive",
} satisfies Record<string, ButtonVariant>;

/** Shared by the Computer, Browser, and related management views during the pilot. */
export function DeviceAction({
  children,
  disabled,
  size,
  variant = "default",
  ...props
}: Omit<ComponentProps<"button">, "children" | "size"> & {
  children: string;
  size?: "sm";
  variant?: keyof typeof variants;
}) {
  const nativeButtonProps = { ...props, disabled };
  return (
    <Button
      {...nativeButtonProps}
      isDisabled={disabled}
      label={children}
      size={size}
      variant={variants[variant]}
    />
  );
}
