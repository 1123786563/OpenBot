import { useTranslation } from "react-i18next";
import { PendingApprovals } from "@/components/approvals/inline-approval";
import type { VisibleChatItem } from "./chat-messages";
import { ToolLine } from "./tool-line";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;
export type BrowserGroup = {
  kind: "browser";
  id: string;
  steps: BrowserStep[];
};
export type TranscriptItem = VisibleChatItem | BrowserGroup;

type StepLabelKey =
  | "browser.step.navigate"
  | "browser.step.read"
  | "browser.step.snapshot"
  | "browser.step.click"
  | "browser.step.type"
  | "browser.step.key"
  | "browser.step.scroll";

const labelKeys: Record<string, StepLabelKey> = {
  computer_navigate: "browser.step.navigate",
  computer_read: "browser.step.read",
  computer_snapshot: "browser.step.snapshot",
  computer_click: "browser.step.click",
  computer_type: "browser.step.type",
  computer_key: "browser.step.key",
  computer_scroll: "browser.step.scroll",
};

/** Group adjacent browsing steps without moving messages or hiding requests for human help. */
export function groupBrowserSteps(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  for (const item of items) {
    if (
      item.kind !== "tool" ||
      !Object.hasOwn(labelKeys, item.toolCall.function.name)
    ) {
      grouped.push(item);
      continue;
    }
    const last = grouped.at(-1);
    if (last?.kind === "browser") last.steps.push(item);
    else grouped.push({ kind: "browser", id: item.id, steps: [item] });
  }
  return grouped;
}

function objectOf(value: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function browserStepDetails(step: BrowserStep) {
  const result = objectOf(step.result);
  const args = objectOf(step.toolCall.function.arguments);
  const navigation = step.toolCall.function.name === "computer_navigate";
  const rawUrl = navigation ? (result.url ?? args.url) : undefined;
  let url: URL | undefined;
  try {
    if (typeof rawUrl === "string") {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "https:" || parsed.protocol === "http:")
        url = parsed;
    }
  } catch {
    /* A partial streaming URL is not a link yet. */
  }
  const failed =
    result.ok === false ||
    result.refused === true ||
    step.result?.startsWith("Error:") === true;
  return {
    labelKey: labelKeys[step.toolCall.function.name],
    href: url?.href,
    title:
      navigation && typeof result.title === "string" && result.title.trim()
        ? result.title
        : url?.hostname,
    failed,
    reason: typeof result.reason === "string" ? result.reason : undefined,
    visited: navigation && result.ok === true,
    pending: step.result === undefined,
  };
}

export function BrowserActivity({
  group,
  active,
}: {
  group: BrowserGroup;
  active: boolean;
}) {
  const { t } = useTranslation("channels");
  const steps = group.steps.map((step) => ({
    id: step.id,
    ...browserStepDetails(step),
  }));
  const pages = steps.filter((step) => step.visited).length;
  const issues = steps.filter((step) => step.failed).length;
  const running = active && steps.some((step) => step.pending);
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      <ToolLine
        label={
          running
            ? t("browser.browsing")
            : pages
              ? pages === 1
                ? t("browser.browsedOne")
                : t("browser.browsedMany", { pages })
              : t("browser.activity")
        }
        detail={
          issues
            ? issues === 1
              ? t("browser.issueOne")
              : t("browser.issueMany", { issues })
            : undefined
        }
        running={running}
      >
        <ol className="space-y-2 py-1">
          {steps.map((step) => (
            <li key={step.id} className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-muted-foreground">
                  {t(step.labelKey)}
                </span>
                {step.href ? (
                  <a
                    href={step.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
                  >
                    {step.title ?? step.href}
                  </a>
                ) : null}
                {step.pending && (
                  <span className="text-muted-foreground">
                    {active
                      ? t("browser.inProgress")
                      : t("browser.notCompleted")}
                  </span>
                )}
              </div>
              {step.failed && (
                <p className="mt-0.5 text-destructive">
                  {step.reason ?? t("browser.stepFailed")}
                </p>
              )}
            </li>
          ))}
        </ol>
      </ToolLine>
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}
