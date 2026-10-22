import { TextArea as TextAreaPrimitive } from "@heroui/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HeroUI's TextArea is React Aria's `<textarea>`. It keeps the app API untouched: `rows`,
 * `value` / `defaultValue`, `onChange` (one native event per keystroke), `name`, `placeholder`,
 * `disabled`, `readOnly`, `required`, `aria-invalid` and `ref` all pass through as DOM props.
 *
 * `field-sizing-content` stays for auto-resize behaviour. Focus and invalid states change the
 * boundary without replacing the shared field fill.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <TextAreaPrimitive
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 w-full rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-2 text-base transition-colors outline-none shadow-none placeholder:text-muted-foreground focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
