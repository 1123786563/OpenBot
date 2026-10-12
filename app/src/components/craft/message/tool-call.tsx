import {
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconCode,
  IconSearch,
  IconSettings,
  IconTools,
  IconWand,
} from "@tabler/icons-react";
import { useState } from "react";
import type { CraftToolKind, CraftToolStatus } from "@/lib/craft/types";
import { cn } from "@/lib/utils";
import { DiffBody } from "../tool-cards/diff-body";

/**
 * One tool call, whatever its stage: the title with the kind and a status mark, and (on demand) the
 * inputs, a diff, or the raw output. Status drives the indicator — pending/in-progress spin, a
 * completed call checks, a failed one crosses — so a transcript glance shows what happened and what
 * is still happening (onyx's tool card).
 */

const KIND_ICON: Record<CraftToolKind, typeof IconTools> = {
  execute: IconWand,
  read: IconSearch,
  edit: IconTools,
  search: IconSearch,
  fetch: IconTools,
  other: IconCode,
};

export type ToolCardProps = {
  title: string;
  toolKind: CraftToolKind;
  status: CraftToolStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: Array<
    | { type: "diff"; path: string; oldText: string; newText: string }
    | { type: "content"; content: unknown }
  >;
};

export function ToolCall({
  title,
  toolKind,
  status,
  rawInput,
  rawOutput,
  content,
}: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const KindIcon = KIND_ICON[toolKind] ?? IconTools;

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <KindIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{title || toolNameFallback(toolKind)}</span>
        <StatusMark status={status} />
        <IconChevronRight
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2 text-xs">
          {rawInput !== undefined && rawInput !== null ? (
            <Parameter label="Input">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                {stringify(rawInput)}
              </pre>
            </Parameter>
          ) : null}
          {content?.map((block, index) =>
            block.type === "diff" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: tool output blocks are append-only and never reordered.
              <DiffBody key={index} diff={block} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: tool output blocks are append-only and never reordered.
              <Parameter key={index} label="Output">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                  {stringify(block.content)}
                </pre>
              </Parameter>
            ),
          )}
          {outputText(rawOutput) ? (
            <Parameter label="Result">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">
                {outputText(rawOutput)}
              </pre>
            </Parameter>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusMark({ status }: { status: CraftToolStatus }) {
  if (status === "completed") {
    return (
      <IconCircleCheck className="ml-1 size-3.5 shrink-0 text-emerald-600" />
    );
  }
  if (status === "failed") {
    return <IconCircleX className="ml-1 size-3.5 shrink-0 text-destructive" />;
  }
  return (
    <IconSettings className="ml-1 size-3.5 shrink-0 animate-spin text-muted-foreground" />
  );
}

function Parameter({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function toolNameFallback(kind: CraftToolKind): string {
  switch (kind) {
    case "execute":
      return "Run";
    case "read":
    case "search":
      return "Read";
    case "edit":
      return "Edit";
    case "fetch":
      return "Fetch";
    default:
      return "Tool";
  }
}

function outputText(rawOutput: unknown): string | null {
  if (rawOutput === null || rawOutput === undefined) return null;
  if (typeof rawOutput === "string") return rawOutput;
  if (typeof rawOutput === "object") {
    const output = (rawOutput as { output?: unknown }).output;
    if (typeof output === "string") return output;
  }
  return null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
