import { Button as AstryxButton } from "@astryxdesign/core/Button";
import type { ComponentProps, ReactNode } from "react";
import {
  AstryxSurface,
  astryxPilot,
  astryxScope,
} from "@/components/astryx-pilot/theme";
import { PageShell } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import "./connection-surface.css";

export function ConnectionSurface({ children }: { children: ReactNode }) {
  return (
    <AstryxSurface className="astryx-connections">{children}</AstryxSurface>
  );
}

export function ConnectionPage(props: ComponentProps<typeof PageShell>) {
  return (
    <ConnectionSurface>
      <PageShell {...props} />
    </ConnectionSurface>
  );
}

export function ConnectionDialogContent({
  className,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      {...astryxScope}
      {...props}
      className={cn(astryxPilot && "astryx-connections-dialog", className)}
    />
  );
}

type ActionProps = Pick<
  ComponentProps<"button">,
  "aria-label" | "className" | "disabled" | "onClick" | "type"
> & {
  children: string;
  endContent?: ReactNode;
  variant?: "default" | "outline";
};

export function ConnectionAction({
  children,
  disabled,
  endContent,
  type = "button",
  variant = "default",
  ...props
}: ActionProps) {
  if (!astryxPilot) {
    return (
      <Button
        {...props}
        disabled={disabled}
        size="sm"
        type={type}
        variant={variant}
      >
        {children}
        {endContent}
      </Button>
    );
  }
  const nativeButtonProps = { ...props, disabled };
  return (
    <AstryxButton
      {...nativeButtonProps}
      endContent={endContent}
      isDisabled={disabled}
      label={children}
      size="sm"
      type={type}
      variant={variant === "outline" ? "secondary" : "primary"}
    />
  );
}
