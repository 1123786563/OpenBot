import { IconFileDiff } from "@tabler/icons-react";
import type { CraftDiffBlock } from "@/lib/craft/types";

/**
 * One file edit a tool reported, drawn as a lightweight unified diff — the removed lines in red,
 * the added lines in green, the path above. Deliberately not a real diff library: a change block is
 * already split into `oldText`/`newText` by the server, so "what disappeared vs what appeared" is
 * all a glance needs and a line-by-line algorithm is enough.
 */

const splitLines = (text: string): string[] =>
  text.length === 0 ? [] : text.split("\n");

export function DiffBody({ diff }: { diff: CraftDiffBlock }) {
  const removed = splitLines(diff.oldText);
  const added = splitLines(diff.newText);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <header className="flex items-center gap-1.5 border-b border-border bg-ob-muted-surface/30 px-2.5 py-1.5">
        <IconFileDiff className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{diff.path}</span>
      </header>
      <pre className="max-h-64 overflow-auto p-2 text-xs leading-relaxed">
        {removed.map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are append-only and never reordered.
            key={`-${index}`}
            className="whitespace-pre-wrap break-all text-destructive"
          >
            - {line}
          </div>
        ))}
        {added.map((line, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are append-only and never reordered.
            key={`+${index}`}
            className="whitespace-pre-wrap break-all text-emerald-600 dark:text-emerald-400"
          >
            + {line}
          </div>
        ))}
      </pre>
    </div>
  );
}
