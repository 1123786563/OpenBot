import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { PendingApprovals } from "@/components/approvals/inline-approval";
import { markdownComponents } from "@/lib/markdown";
import { type ResearchLabelKey, readToolName } from "@/lib/plugins/tool-name";
import {
  asText,
  forDisplay,
  REFUSAL_MARKER,
  refusalBody,
  toolResultFailed,
} from "@/lib/plugins/tool-result";
import { readTeamBotConsent } from "@/lib/team-bots";
import { readConnectPrompt } from "../../../../shared/connect-prompt";
import { researchRoleOfTool } from "../../../../shared/research";
import {
  browserStepDetails,
  isBrowserStep,
  type StepLabelKey,
} from "./browser-activity";
import type { VisibleChatItem } from "./chat-messages";
import { ToolRenderBoundary } from "./tool-boundary";
import { ToolLine } from "./tool-line";

type ToolItem = Extract<VisibleChatItem, { kind: "tool" }>;

/**
 * Adjacent things a Bot did, drawn as one line that opens to each of them.
 *
 * The fold is a VIEW PROJECTION: the transcript draws it, and the message store is never written
 * back, so history needs no migration — an old thread renders exactly as it always did.
 */
export type ToolGroup = {
  kind: "tools";
  /** The FIRST step's id, so the row keeps its identity while later steps stream in. */
  id: string;
  steps: ToolItem[];
};
export type TranscriptItem = VisibleChatItem | ToolGroup;

/**
 * Fold adjacent tool calls into one row, so a reply that browsed a page and searched two servers
 * reads as one thing the Bot did rather than a stack of lines before the answer.
 *
 * Only calls drawn as a plain line are folded: browser steps and connector (MCP) tools. A tool the
 * app draws itself — a chart, a generated interface — stays where it is, and so does a refusal that
 * asks the person to connect their own account or to let a Team Bot act as them, because a question
 * for the person must never sit behind a disclosure. A human takeover request (`computer_request_help`)
 * is the same kind of question and stays in the open for the same reason.
 *
 * A connector call on its own keeps its own line — the existing single-tool rendering, unchanged.
 * One browser step is still a group, as it always was, so the row does not change shape when the
 * second step arrives.
 */
export function groupToolSteps(
  items: readonly VisibleChatItem[],
): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  let run: ToolItem[] = [];
  const close = () => {
    const [first] = run;
    if (!first) return;
    if (run.length === 1 && !isBrowserStep(first)) grouped.push(first);
    else grouped.push({ kind: "tools", id: first.id, steps: run });
    run = [];
  };
  for (const item of items) {
    if (item.kind === "tool" && foldable(item)) {
      run.push(item);
      continue;
    }
    close();
    grouped.push(item);
  }
  close();
  return grouped;
}

function foldable(item: ToolItem): boolean {
  if (isBrowserStep(item)) return true;
  if (!item.toolCall.function.name.startsWith("mcp__")) return false;
  return !asksThePerson(item.result);
}

/**
 * Fold verdicts already asked for, keyed by the result's own text.
 *
 * `foldable` runs over every item of every render, and a streaming reply re-renders the whole
 * transcript many times a second — so this used to JSON-parse every completed connector result in
 * the history again on each frame, only to answer what the previous frame already knew. Keyed by
 * VALUE because the transcript's arrays are rebuilt as a stream advances and the agent's own is
 * mutated in place: object identity proves nothing here. A completed result's text never changes,
 * so its verdict cannot go stale. FIFO-capped so a long session cannot grow it without bound; a
 * cap-evicted verdict is merely computed once more.
 */
const ASK_VERDICTS_LIMIT = 512;
const askVerdicts = new Map<string, boolean>();

/**
 * Whether this refusal is a question for the person rather than a line about what a Bot did.
 *
 * Both of these draw a card with something to press — a Team Bot asking to act as them, and an app
 * they have not connected — and neither may sit behind a fold for the same reason: a question
 * nobody can see is a conversation that has stopped without saying so. The envelope comes off the
 * one way every reader takes it off (`refusalBody` in `tool-result`, the strip
 * `chat-transcript`'s `connectPromptOf` also reads): the result arrives JSON-encoded and
 * addressed to the model, and the markers only recognise text that starts with them.
 */
function asksThePerson(result: string | undefined): boolean {
  if (result === undefined) return false;
  /*
   * A refusal can only wear two shapes, and each is recognisable from the result's first
   * characters. `refusalBody` decodes through `asText`, which rewrites a result only when it starts
   * with a quote, and answers a body only for text that starts with the marker — so a verdict of
   * true needs the result to open with the marker itself, or with the quote right in front of the
   * marker that its JSON encoding opens with (the envelope is the runtime's own encoding, which
   * escapes nothing in the marker's letters). Anything else is false before the cache or a parse is
   * ever consulted — which is what keeps a long research session, more distinct results than the
   * FIFO holds so every frame re-judges history it has already judged, from re-parsing all of it.
   */
  const lead = result.trimStart();
  if (
    !lead.startsWith(REFUSAL_MARKER) &&
    !lead.startsWith(`"${REFUSAL_MARKER}`)
  ) {
    return false;
  }
  const cached = askVerdicts.get(result);
  if (cached !== undefined) return cached;
  const body = refusalBody(result);
  const verdict =
    body !== null &&
    (readTeamBotConsent(body) !== null || readConnectPrompt(body) !== null);
  if (askVerdicts.size >= ASK_VERDICTS_LIMIT) {
    const oldest = askVerdicts.keys().next();
    if (!oldest.done) askVerdicts.delete(oldest.value);
  }
  askVerdicts.set(result, verdict);
  return verdict;
}

/**
 * How a step is classified for the summary line.
 *
 * The two research kinds are the shared catalogue's roles, read through `researchRoleOfTool` —
 * the same table the server intersects grants with, so the transcript can never call a step a
 * search the catalogue does not.
 */
type StepKind = "search" | "fetch" | "browser" | "connector";

export type StepDetails = {
  id: string;
  kind: StepKind;
  /** What was done, in a couple of words — the humanised tool name for a connector. */
  label: string;
  /** A browser or research step's label is a phrase of the transcript's own, keyed rather than spelled. */
  labelKey?: StepLabelKey | ResearchLabelKey;
  /** What it was done to: a page title, a query, a host, a server. Muted beside the label. */
  detail?: string;
  href?: string;
  pending: boolean;
  /** It was permitted and did not work. A different request might. */
  failed: boolean;
  /** A policy or a boundary said no. Final: nothing the Bot does differently will help. */
  refused: boolean;
  reason?: string;
  /** Pages a browser step opened or a completed fetch read; zero for anything else. */
  pages: number;
  /** The connector a connector step reached, said the way a person would. */
  connector?: string;
  /** Every argument, whole: the expanded step is where the full thing lives. */
  inputs: [string, string][];
  /** The result as a person reads it, marker and model-only notices already off. */
  output?: string;
};

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

/** "google-drive" as "Google Drive". */
function connectorName(key: string): string {
  return key
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The first textual value among a search's candidate arguments, however the vendor spells query.
 *
 * A search names what it looked for, and the three reviewed vendors do not agree on the field —
 * a bare `query`, an `objective`, or a list of `search_queries`/`queries`. The first non-empty
 * string among them is the one the person would recognise; nothing is invented when they are all
 * absent, because the step's own disclosure carries every argument whole.
 */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const found = value.find(
        (entry): entry is string => typeof entry === "string" && !!entry.trim(),
      );
      if (found) return found.trim();
    }
  }
  return undefined;
}

/** The URLs a fetch was handed, however the vendor spells them: one `url` or a list of `urls`. */
function urlsOf(args: Record<string, unknown>): string[] {
  const urls = Array.isArray(args.urls) ? args.urls : [args.url];
  return urls.filter(
    (url): url is string => typeof url === "string" && !!url.trim(),
  );
}

/** `https://www.example.com/a` as `example.com` — or the text back, when it was never a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function stepDetails(step: ToolItem): StepDetails {
  const args = objectOf(step.toolCall.function.arguments);
  const inputs = Object.entries(args).map(
    ([key, value]) => [key, inputValue(value)] as [string, string],
  );
  if (isBrowserStep(step)) {
    const browser = browserStepDetails(step);
    return {
      id: step.id,
      kind: "browser",
      label: "",
      labelKey: browser.labelKey,
      ...(browser.title ? { detail: browser.title } : {}),
      ...(browser.href ? { href: browser.href } : {}),
      pending: browser.pending,
      failed: browser.failed,
      refused: false,
      ...(browser.reason ? { reason: browser.reason } : {}),
      pages: browser.visited ? 1 : 0,
      inputs,
    };
  }

  const name = step.toolCall.function.name;
  const { label, detail, labelKey } = readToolName(name);
  /*
   * The same reading `ServerToolLine` does: the result arrives JSON-encoded, a refusal carries the
   * server's marker rather than a guessed wording, and everything else is the vendor's answer —
   * which the group shows through `forDisplay` when it is drawn, untrusted envelope and all. The
   * marker strip is `refusalBody`, the one sequence every reader shares; the decoded answer is
   * asked for only when no refusal is carrying the text.
   */
  const refusal = refusalBody(step.result);
  const refused = refusal !== null;
  const body =
    refusal ?? (step.result === undefined ? undefined : asText(step.result));
  const [, server = ""] = name.split("__");
  /*
   * A research step is its role first: the label is the role's, the detail is what it acted on,
   * and the vendor appears nowhere. Only the reviewed pairs are roles — anything else a provider
   * offers stays an ordinary connector step, wearing its own name.
   */
  const role = researchRoleOfTool(server, name.split("__").slice(2).join("__"));
  const base = {
    id: step.id,
    label,
    ...(labelKey ? { labelKey } : {}),
    pending: step.result === undefined,
    failed: !refused && toolResultFailed(step.result),
    refused,
    inputs,
    ...(body ? { output: body } : {}),
  };
  if (role === "search") {
    const query = firstString(
      args.query,
      args.objective,
      args.search_queries,
      args.queries,
    );
    return {
      ...base,
      kind: "search",
      ...(query ? { detail: query } : {}),
      // A search found sources; it read nothing, whatever came back.
      pages: 0,
    };
  }
  if (role === "fetch") {
    const urls = urlsOf(args);
    const [first, ...more] = urls;
    const href = first && /^https?:\/\//.test(first) ? first : undefined;
    return {
      ...base,
      kind: "fetch",
      ...(first
        ? {
            // The host names where it went; a multi-URL call keeps every URL whole behind the
            // step's own disclosure, which is where a truncated "and two more" would send a
            // reader anyway.
            detail: hostOf(first),
          }
        : {}),
      ...(href && !more.length ? { href } : {}),
      /*
       * PAGES COME FROM WHAT CAME BACK, never from what was asked. A completed call read the
       * pages it named — that is what returning means. A pending, failed or refused call read
       * nothing, and counting its arguments would print a number the transcript's own steps
       * contradict, so it counts zero and the issue count says what happened instead.
       */
      pages:
        !base.pending && !base.failed && !base.refused
          ? Math.max(urls.length, 1)
          : 0,
    };
  }
  return {
    ...base,
    kind: "connector",
    ...(detail ? { detail } : {}),
    pages: 0,
    connector: connectorName(server),
  };
}

/**
 * A value from a tool's arguments, kept whole.
 *
 * The collapsed line never shows argument values — they live behind the step's own disclosure, the
 * one place in the transcript where the full text of what the Bot sent can be read. Truncating here
 * would put a step whose only error is its input beyond reach, which is the one thing this view
 * must not do.
 */
function inputValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export type ToolGroupSummary = {
  /** Browser steps that opened a page. */
  browsed: number;
  /** Browser steps of every kind, opened or not. */
  browserSteps: number;
  /** Distinct connectors the group reached, said the way a person would, first-seen order. */
  connectors: string[];
  /** Research searches that actually returned. A refused or failed call is not a search. */
  searches: number;
  /** Pages completed fetches read; a step that never returned contributes nothing. */
  fetchedPages: number;
};

/**
 * What a group of steps did, counted rather than listed — the list is what the line opens to.
 *
 * Pure, so the summary is unit-testable without a renderer: the component phrases these counts in
 * the reader's language. Research counts only completed calls, so a run whose provider refused or
 * errored summarises as issues, never as work that happened.
 */
export function summarise(steps: readonly StepDetails[]): ToolGroupSummary {
  const returned = (step: StepDetails): boolean =>
    !step.pending && !step.failed && !step.refused;
  return {
    browsed: steps.reduce(
      (sum, step) => sum + (step.kind === "browser" ? step.pages : 0),
      0,
    ),
    browserSteps: steps.filter((step) => step.kind === "browser").length,
    connectors: [
      ...new Set(
        steps.flatMap((step) => (step.connector ? [step.connector] : [])),
      ),
    ],
    searches: steps.filter((step) => step.kind === "search" && returned(step))
      .length,
    fetchedPages: steps.reduce(
      (sum, step) => sum + (step.kind === "fetch" ? step.pages : 0),
      0,
    ),
  };
}

/** What one step is called on screen, keyed for browser steps and humanised for connectors. */
function stepLabel(step: StepDetails, t: TFunction<"channels">): string {
  return step.labelKey ? t(step.labelKey) : step.label;
}

function StepStatus({ step, active }: { step: StepDetails; active: boolean }) {
  const { t } = useTranslation("channels");
  if (step.pending)
    return (
      <span className="shrink-0 text-muted-foreground">
        {active ? t("browser.inProgress") : t("browser.notCompleted")}
      </span>
    );
  if (step.refused)
    return (
      <span className="shrink-0 text-destructive">
        {t("tools.stepBlocked")}
      </span>
    );
  if (step.failed)
    return (
      <span className="shrink-0 text-amber-600 dark:text-amber-500">
        {t("tools.stepFailed")}
      </span>
    );
  return null;
}

function StepRow({ step, active }: { step: StepDetails; active: boolean }) {
  const { t } = useTranslation("channels");
  const line = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0">{stepLabel(step, t)}</span>
      {step.href ? (
        <a
          href={step.href}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
        >
          {step.detail ?? step.href}
        </a>
      ) : step.detail ? (
        <span className="truncate text-muted-foreground">{step.detail}</span>
      ) : null}
      <StepStatus step={step} active={active} />
    </span>
  );
  const reason =
    step.failed && step.kind === "browser" ? (
      <p className="mt-0.5 pl-6 text-destructive">
        {step.reason ?? t("browser.stepFailed")}
      </p>
    ) : null;
  // A browser step says everything it has in its line. Anything else opens to what it was given
  // and what came back, which no other place in the transcript shows.
  if (step.kind === "browser" || (!step.inputs.length && !step.output))
    return (
      <li className="min-w-0">
        {line}
        {reason}
      </li>
    );
  return (
    <li className="min-w-0">
      <details className="tool-line min-w-0">
        <summary className="flex cursor-pointer list-none items-center gap-1.5">
          <span
            aria-hidden
            className="tool-line-chevron shrink-0 text-xs text-muted-foreground transition-transform"
          >
            ▸
          </span>
          {line}
        </summary>
        <div className="mt-1.5 space-y-2 pl-5">
          {step.inputs.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {step.inputs.map(([key, value]) => (
                <div className="contents" key={key}>
                  <dt className="text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {step.output ? (
            /*
             * The fold draws a vendor's answer with the same markdown machinery the transcript
             * gives a Bot's prose, but the text arrives from the MCP server, not from the app, and
             * no app-authored component card sits around it. A drawing that throws here must cost
             * this step its result alone — the single-tool path draws behind the same boundary —
             * never the whole conversation it sits inside.
             */
            <ToolRenderBoundary name={step.label}>
              <div className="max-h-60 overflow-auto border-l pl-3 text-xs [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h4]:text-xs [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium">
                {/*
                 * The same drawing `ServerToolLine` gives a single call: `forDisplay` takes the
                 * model's untrusted-content notice back off and unwraps a vendor's JSON envelope,
                 * and what a server wrote for a model reads as prose. Nothing here treats that
                 * content as instruction or authorization — it is drawn, never obeyed.
                 */}
                <Streamdown components={markdownComponents}>
                  {forDisplay(step.output)}
                </Streamdown>
              </div>
            </ToolRenderBoundary>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function ToolActivity({
  group,
  active,
}: {
  group: ToolGroup;
  /** This is the newest row of a turn still in flight, so a step without a result is running. */
  active: boolean;
}) {
  const { t } = useTranslation("channels");
  const steps = group.steps.map(stepDetails);
  const running = active && steps.some((step) => step.pending);
  const current = steps.find((step) => step.pending);
  const issues = steps.filter((step) => step.failed || step.refused).length;
  const summary = summarise(steps);
  const phrases: string[] = [];
  if (summary.searches > 0)
    phrases.push(t("tools.searchedTimes", { count: summary.searches }));
  if (summary.fetchedPages > 0)
    phrases.push(t("tools.readPages", { count: summary.fetchedPages }));
  if (summary.browsed > 0)
    phrases.push(t("tools.browsedPages", { count: summary.browsed }));
  else if (summary.browserSteps > 0) phrases.push(t("tools.usedBrowser"));
  if (summary.connectors.length === 1)
    phrases.push(
      t("tools.usedConnector", { connector: summary.connectors[0] }),
    );
  else if (summary.connectors.length > 1)
    phrases.push(
      t("tools.usedConnectors", { count: summary.connectors.length }),
    );
  const joined =
    phrases.length <= 1
      ? (phrases[0] ?? "")
      : `${phrases.slice(0, -1).join(t("tools.listSeparator"))}${t("tools.andPhrase")}${phrases.at(-1)}`;
  const label = joined
    ? joined.charAt(0).toUpperCase() + joined.slice(1)
    : steps[0]
      ? stepLabel(steps[0], t)
      : t("tools.usedBrowser");
  // The folded line draws its own steps, so a waiting approval gets its card beside it, not inside.
  return (
    <>
      <ToolLine
        label={running && current ? `${stepLabel(current, t)}…` : label}
        detail={issues ? t("tools.issueCount", { count: issues }) : undefined}
        running={running}
      >
        <ol className="space-y-2 py-1">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} active={active} />
          ))}
        </ol>
      </ToolLine>
      <PendingApprovals
        toolCallIds={group.steps.map((step) => step.toolCall.id)}
      />
    </>
  );
}
