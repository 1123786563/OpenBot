import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { IconCheck } from "@tabler/icons-react";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        /*
         * Checked fill is the brand teal — WorkBuddy's own controls turn their brand color when
         * ON while buttons stay black; same separation as the switch. The glyph is ink
         * (--brand-foreground), not white: ink on teal is 7.84:1 where white is 2.29:1.
         */
        "peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-brand data-checked:bg-brand data-checked:text-brand-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <IconCheck className="size-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
