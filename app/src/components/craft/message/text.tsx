import { Streamdown } from "streamdown";
import { markdownComponents } from "@/lib/markdown";

/**
 * A Bot's prose, streamed or replayed. `streamdown` renders the markdown incrementally without
 * re-parsing history, and the shared `markdownComponents` keeps links and document chips identical
 * to the rest of the app.
 */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/50 [&_pre]:p-3 [&_pre]:text-xs [&_code]:font-mono [&_code]:text-[13px]">
      <Streamdown components={markdownComponents}>{text}</Streamdown>
    </div>
  );
}
