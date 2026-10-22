import { Switch as SwitchPrimitive } from "@heroui/react";
import {
  type ComponentPropsWithRef,
  type ReactNode,
  useEffect,
  useRef,
} from "react";

import { cn } from "@/lib/utils";

type SwitchPrimitiveProps = ComponentPropsWithRef<typeof SwitchPrimitive>;

export type SwitchProps = Omit<
  SwitchPrimitiveProps,
  | "checked"
  | "children"
  | "className"
  | "defaultChecked"
  | "disabled"
  | "isDisabled"
  | "isSelected"
  | "onChange"
  | "size"
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  /** Accepted for parity with the old API; mapped to React Aria's `isDisabled`. */
  isDisabled?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  size?: "sm" | "default";
  className?: string;
  children?: ReactNode;
};

/**
 * The app's switch: a 32×18.4 track that fills brand teal when ON, with a light thumb.
 *
 * Same construction as `Checkbox`: the Control must sit inside HeroUI's clickable `Content`
 * label, or the track is a picture of a switch rather than a switch. The visual dimensions and
 * the teal-on state are restored in `styles/heroui-theme.css` under `.ob-switch`, because
 * WorkBuddy's track is smaller than HeroUI's and its ON colour is the brand, not the action
 * black (`--accent`).
 *
 * `id` is written to the hidden input so the "Hybrid search" row's `<Label htmlFor>` keeps
 * toggling the control; React Aria strips `id` from the field root on purpose.
 */
function Switch({
  checked,
  defaultChecked,
  disabled = false,
  isDisabled,
  onCheckedChange,
  size = "default",
  className,
  children,
  id,
  inputRef,
  "aria-label": ariaLabel,
  ...props
}: SwitchProps) {
  const hiddenInput = useRef<HTMLInputElement | null>(null);
  const selected = checked ?? defaultChecked ?? false;
  const off = isDisabled ?? disabled;

  /*
   * React Aria conveys the switch state through the native checkbox's `checked` property, so the
   * element carries no `aria-checked`/`data-checked`. The app and its tests have always read those
   * attributes off the `role="switch"` element, so mirror them onto the input whenever state moves.
   */
  useEffect(() => {
    const element = hiddenInput.current;
    if (!element) return;
    element.setAttribute("aria-checked", String(selected));
    element.toggleAttribute("data-checked", selected);
    element.toggleAttribute("data-disabled", off);
  }, [selected, off]);

  return (
    <SwitchPrimitive
      data-slot="switch"
      data-size={size}
      className={cn("ob-switch", className)}
      defaultSelected={defaultChecked}
      aria-label={ariaLabel}
      inputRef={(element) => {
        hiddenInput.current = element;
        if (element && id) {
          element.id = id;
        }
        /*
         * React Aria names a switch from its visible label. A caller that supplies `aria-label`
         * and no children (the update-routing rows) expects that name on the control itself.
         */
        if (element && ariaLabel) {
          element.setAttribute("aria-label", ariaLabel);
        }
        if (typeof inputRef === "function") inputRef(element);
        else if (inputRef) inputRef.current = element;
        /*
         * The mirror effect runs when PROPS move. An uncontrolled switch (`defaultChecked`, no
         * `checked`) changes state without a prop, so its `aria-checked`/`data-checked` would go
         * stale after the first click; the input's own change event is the one signal that fires
         * there too. (H14, closing the H02 review's uncontrolled-mirror gap.)
         */
        if (element) {
          element.addEventListener("change", () => {
            element.setAttribute("aria-checked", String(element.checked));
            element.toggleAttribute("data-checked", element.checked);
          });
        }
      }}
      isDisabled={isDisabled ?? disabled}
      isSelected={checked}
      onChange={onCheckedChange}
      size={size === "sm" ? "sm" : "md"}
      {...props}
    >
      <SwitchPrimitive.Content data-slot="switch-content">
        <SwitchPrimitive.Control data-slot="switch-control">
          <SwitchPrimitive.Thumb data-slot="switch-thumb" />
        </SwitchPrimitive.Control>
        {children}
      </SwitchPrimitive.Content>
    </SwitchPrimitive>
  );
}

export { Switch };
