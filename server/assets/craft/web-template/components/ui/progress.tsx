"use client";

import type * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  // Normalize against the Radix max (default 100) and clamp to [0, max]: an
  // out-of-range value would slide the indicator clean off the track.
  const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
  const current = typeof value === "number" ? value : 0;
  const percent = Math.min(Math.max((current / max) * 100, 0), 100);
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "bg-muted h-1 rounded-full relative flex w-full items-center overflow-x-hidden",
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary size-full flex-1 transition-all"
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
