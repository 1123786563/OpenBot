import { Input as InputPrimitive } from "@heroui/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HeroUI's Input is React Aria's `<input>`: DOM props (`type`, `value`, `defaultValue`, `name`,
 * `placeholder`, `disabled`, `readOnly`, `required`, `aria-invalid`, …) and `ref` pass straight
 * through, and one native change event fires per keystroke. Nothing is remapped — React Aria's
 * input takes `disabled`, not `isDisabled`.
 *
 * The wrapper explicitly opts into the shared field fill and boundary tokens. Focus and invalid
 * states change the boundary only, so the field surface remains stable while editing.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 min-h-9 w-full min-w-0 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 pointer-coarse:!h-11 pointer-coarse:!min-h-11 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
