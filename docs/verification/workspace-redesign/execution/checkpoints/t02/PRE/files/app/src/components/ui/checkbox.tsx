import { Checkbox as CheckboxPrimitive } from "@heroui/react";
import { IconCheck } from "@tabler/icons-react";
import type { ComponentPropsWithRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

type CheckboxPrimitiveProps = ComponentPropsWithRef<typeof CheckboxPrimitive>;

export type CheckboxProps = Omit<
  CheckboxPrimitiveProps,
  | "checked"
  | "children"
  | "className"
  | "defaultChecked"
  | "disabled"
  | "isDisabled"
  | "isIndeterminate"
  | "isSelected"
  | "onChange"
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  /**
   * The half-check state. React Aria drives the native input's `indeterminate` property, which is
   * the platform's "mixed" checkbox state (exposed to assistive technology as `mixed`); the
   * wrapper also carries `data-indeterminate` on the root for styling.
   */
  indeterminate?: boolean;
  disabled?: boolean;
  /** Accepted for parity with the old API; mapped to React Aria's `isDisabled`. */
  isDisabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
  /** Optional visible label rendered inside the clickable area. */
  children?: ReactNode;
};

/**
 * The app's checkbox: a 16px teal-when-on control that submits `name`/`value` with a real form.
 *
 * HeroUI's Checkbox is a React Aria `CheckboxField` (a plain wrapper) around a
 * `CheckboxButton` (a `<label>` holding the visually-hidden native input). The Control has to be
 * INSIDE that label or the square is decorative — clicking it would not toggle anything. The
 * wrapper therefore renders `Content > Control + Indicator`, which also keeps a pointer click and
 * a programmatic `input.click()` on the same path.
 *
 * `aria-label`, `onClick` and the rest of the RAC props still reach the native input, so the old
 * call sites (a table row with a shift-click range, checkboxes named by a sibling `<label
 * htmlFor>`) keep the same event target.
 *
 * `id` is applied to the hidden input through `inputRef`: React Aria deliberately removes `id`
 * from the field root, and an external `<Label htmlFor>` must keep pointing at the control that
 * actually toggles.
 */
function Checkbox({
  checked,
  defaultChecked,
  indeterminate = false,
  disabled = false,
  isDisabled,
  onCheckedChange,
  className,
  children,
  id,
  inputRef,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive
      data-slot="checkbox"
      className={cn("ob-checkbox", className)}
      defaultSelected={defaultChecked}
      inputRef={(element) => {
        if (element && id) {
          element.id = id;
        }
        if (typeof inputRef === "function") inputRef(element);
        else if (inputRef) inputRef.current = element;
      }}
      isDisabled={isDisabled ?? disabled}
      isIndeterminate={indeterminate}
      isSelected={checked}
      onChange={onCheckedChange}
      {...props}
    >
      <CheckboxPrimitive.Content data-slot="checkbox-content">
        <CheckboxPrimitive.Control
          data-slot="checkbox-control"
          className="rounded-[4px] border-input shadow-xs"
        >
          <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
            <IconCheck className="size-3" />
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Control>
        {children}
      </CheckboxPrimitive.Content>
    </CheckboxPrimitive>
  );
}

export { Checkbox };
