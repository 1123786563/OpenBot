import { IconListCheck } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * The agent's plan, folded into a checklist. Entries arrive as the model's `agent_plan_update`
 * (`entries: unknown`), and each carries a description with an optional status; anything outside
 * that shape falls back to a compact JSON so an unreadable plan renders rather than vanishes.
 */

type PlanEntry = {
  id?: unknown;
  description?: unknown;
  status?: unknown;
  [key: string]: unknown;
};

/** Readable copy for an entry: the description is the lead; missing one, the whole entry. */
function label(entry: PlanEntry): string {
  return typeof entry.description === "string" && entry.description
    ? entry.description
    : typeof entry.id === "string"
      ? entry.id
      : JSON.stringify(entry);
}

export function MessagePlan({ entries }: { entries: unknown }) {
  if (Array.isArray(entries)) {
    return (
      <div className="rounded-md border border-border p-3">
        <header className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <IconListCheck className="size-3.5" />
          Plan
        </header>
        <ul className="space-y-1.5">
          {(entries as PlanEntry[]).map((entry, index) => {
            const status = entry.status;
            const done =
              typeof status === "string" &&
              (status === "completed" || status === "done");
            const current =
              typeof status === "string" &&
              (status === "in_progress" || status === "running");
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: plan entries are append-only and never reordered.
              <li key={index} className="flex items-start gap-2 text-sm">
                <span
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    done
                      ? "bg-emerald-600"
                      : current
                        ? "bg-primary"
                        : "bg-muted-foreground/40",
                  )}
                />
                <span
                  className={cn(
                    "leading-relaxed",
                    done && "text-muted-foreground line-through",
                  )}
                >
                  {label(entry)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  return null;
}
