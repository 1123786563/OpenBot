import { IconBrain, IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A step's reasoning, folded away by default so the answer leads and the chain stays one click deep
 * — onyx's ThinkingCard. `streaming` keeps it open while the model is still working through it;
 * once the block settles it collapses so the transcript reads as answers, not as scratch.
 */
export function MessageThinking({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(streaming);

  if (!text) return null;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-ob-muted-surface/40"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <IconBrain className="size-3.5 shrink-0" />
        <span>Thinking</span>
        <IconChevronRight
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {text}
        </div>
      ) : null}
    </div>
  );
}
