import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ComponentProps, ReactNode } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { AstryxSurface, astryxScope } from "./theme";
import "./governance.css";

export function GovernanceSurface({ children }: { children: ReactNode }) {
  return (
    <AstryxSurface className="astryx-governance flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
    </AstryxSurface>
  );
}

export function GovernancePage(props: ComponentProps<typeof PageShell>) {
  return (
    <GovernanceSurface>
      <PageShell {...props} />
    </GovernanceSurface>
  );
}

export const governanceOverlay = {
  ...astryxScope,
  className: "astryx-governance-overlay",
};

export function GovernanceAction({
  label,
  variant,
  disabled,
  ...props
}: Pick<
  ComponentProps<"button">,
  "onClick" | "type" | "disabled" | "className"
> & {
  label: string;
  variant?: "outline" | "destructive";
}) {
  const nativeButtonProps = { ...props, disabled };
  return (
    <Button
      {...nativeButtonProps}
      isDisabled={disabled}
      label={label}
      variant={variant === "outline" ? "secondary" : (variant ?? "primary")}
    />
  );
}

export function GovernanceSearch({
  label,
  ...props
}: {
  label: string;
  value: string;
} & Pick<ComponentProps<"input">, "onChange" | "placeholder" | "className">) {
  const { className, onChange, ...input } = props;
  return (
    <div className={className}>
      <TextInput
        {...input}
        isLabelHidden
        label={label}
        onChange={(_value, event) => onChange?.(event)}
        size="lg"
        type="search"
        width="100%"
      />
    </div>
  );
}
