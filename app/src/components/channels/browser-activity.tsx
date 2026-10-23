import type { VisibleChatItem } from "./chat-messages";

type BrowserStep = Extract<VisibleChatItem, { kind: "tool" }>;

type StepLabelKey =
  | "browser.step.navigate"
  | "browser.step.read"
  | "browser.step.snapshot"
  | "browser.step.click"
  | "browser.step.type"
  | "browser.step.key"
  | "browser.step.scroll";

/** The phrases a browsing step is called, keyed for translation. Exported with `isBrowserStep`. */
export type { StepLabelKey };

const labelKeys: Record<string, StepLabelKey> = {
  computer_navigate: "browser.step.navigate",
  computer_read: "browser.step.read",
  computer_snapshot: "browser.step.snapshot",
  computer_click: "browser.step.click",
  computer_type: "browser.step.type",
  computer_key: "browser.step.key",
  computer_scroll: "browser.step.scroll",
};

/**
 * Whether a tool call is a browsing step this file knows how to draw.
 *
 * One answer for the transcript's grouper and its step renderer, so a step can never be a browser
 * step to one and an unknown tool to the other: `groupToolSteps` folds on it, and `stepDetails`
 * reads its shape through {@link browserStepDetails}.
 */
export function isBrowserStep(step: BrowserStep): boolean {
  return Object.hasOwn(labelKeys, step.toolCall.function.name);
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
