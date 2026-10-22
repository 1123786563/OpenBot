import { Skeleton as SkeletonPrimitive } from "@heroui/react";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HeroUI's Skeleton is a `div` that adds `.skeleton` (pointer-events-none, relative,
 * overflow-hidden, its own radius/tint) and nothing else unless `animationType` is set — the
 * wrapper does not set it, so the app keeps its own `animate-pulse` and muted surface. Size and
 * shape stay where they have always been: in `className` at the call site.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <SkeletonPrimitive
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-ob-muted-surface motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
