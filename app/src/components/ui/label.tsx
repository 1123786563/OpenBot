import { Label as LabelPrimitive } from "@heroui/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HeroUI's Label is React Aria's `Label`. It renders a `<label>` and forwards `htmlFor` (plus
 * every other label attribute), so a sibling control keeps its association exactly as before.
 *
 * The app's class string still owns the type scale and list behaviour. React Aria's field
 * context supplies `isDisabled` / `isInvalid` / `isRequired` when a Label sits inside a HeroUI
 * field; those only add HeroUI's `.label--*` modifiers, which the utilities here outrank.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <LabelPrimitive
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-xs leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-[var(--ob-disabled-foreground)] peer-disabled:cursor-not-allowed peer-disabled:text-[var(--ob-disabled-foreground)]",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
