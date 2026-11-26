/**
 * Whether a control takes no input. Astryx buttons stay focusable and say so with `aria-disabled`
 * instead of the native attribute, so a test that reads `.disabled` alone passes on a shut one.
 */
export function isDisabled(control: Element | null | undefined): boolean {
  if (!control) return false;
  return (
    control.getAttribute("aria-disabled") === "true" ||
    ((control instanceof HTMLButtonElement ||
      control instanceof HTMLInputElement) &&
      control.disabled === true)
  );
}
