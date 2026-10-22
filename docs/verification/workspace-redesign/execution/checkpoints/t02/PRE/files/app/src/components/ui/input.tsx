import { Input as InputPrimitive } from "@heroui/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HeroUI's Input is React Aria's `<input>`: DOM props (`type`, `value`, `defaultValue`, `name`,
 * `placeholder`, `disabled`, `readOnly`, `required`, `aria-invalid`, …) and `ref` pass straight
 * through, and one native change event fires per keystroke. Nothing is remapped — React Aria's
 * input takes `disabled`, not `isDisabled`.
 *
 * The app's class string is authoritative. HeroUI's `.input` base also fills the field on
 * hover / focus / invalid and adds a resting field shadow; the pre-migration field was a
 * transparent box whose only state cue was the focus-visible ring, so the four neutralisers
 * below keep that surface unchanged. The rest of the base (radius, padding, type scale) is
 * overridden by the utilities that were already here — HeroUI's component CSS sits in
 * `@layer components`, below Tailwind's `utilities`.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:bg-transparent focus:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:bg-transparent aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
