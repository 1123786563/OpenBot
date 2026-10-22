import { Separator as SeparatorPrimitive } from "@heroui/react";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/lib/utils";

type SeparatorProps = ComponentPropsWithRef<typeof SeparatorPrimitive>;

/*
 * HeroUI's Separator is React Aria's, so `orientation` keeps its meaning (`horizontal` draws an
 * `<hr>`, `vertical` a `<div>` with `role="separator"` + `aria-orientation`) and it still renders
 * a decorative, non-focusable line.
 *
 * React Aria names the resolved axis on the element as `data-orientation`, not Base UI's
 * `data-horizontal` / `data-vertical`, so the thin-line utilities key off that attribute. They
 * keep the app's 1px rule and `bg-border` colour; HeroUI's `.separator` base (h-px / w-full /
 * rounded-sm / `bg-separator`) lives in `@layer components` and is outranked by them.
 */
function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorProps) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
