import { TextArea as TextAreaPrimitive } from "@heroui/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HeroUI's TextArea is React Aria's `<textarea>`. It keeps the app API untouched: `rows`,
 * `value` / `defaultValue`, `onChange` (one native event per keystroke), `name`, `placeholder`,
 * `disabled`, `readOnly`, `required`, `aria-invalid` and `ref` all pass through as DOM props.
 *
 * `field-sizing-content` stays: it is what gives the field its auto-resize behaviour, and the
 * `min-h-16` floor keeps an empty composer tall enough. HeroUI's `.textarea` base paints a
 * resting shadow and fills the surface on hover / focus / invalid; the neutralisers keep the
 * surface the app has always drawn (it sits in `@layer components`, below these utilities).
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <TextAreaPrimitive
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none shadow-none placeholder:text-muted-foreground hover:bg-transparent focus:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-transparent aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
