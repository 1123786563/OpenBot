import {
  IconDatabase,
  IconMinus,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  type ObservationRunStep,
  observationRunStepsQueryOptions,
} from "@/lib/ai-observability/runs";
import type { SafeValue } from "../../../../shared/ai-observability";
import type { RunCapabilityLevel } from "../../../../shared/ai-observability-runs";
import { formatDuration } from "./runs-list";
import { observationScreenFault, StateNotice } from "./state-notice";

/*
 * The run's step tree (Issue #24 / T18), rendered into the detail page's Steps section.
 *
 * Every row is one recorded span — a model call, a tool call, a retrieval — and nothing
 * else: a step this run never recorded is not drawn, because on this page an invented row
 * would be a fabricated fact (the Spec is explicit that unobservable internal steps are
 * never shown as if they happened). The tree's shape is the record's own: nesting follows
 * parentSpanId, order follows startedAt, and a step whose linkage is broken (a dangling
 * parent, a cycle) keeps its place at the root rather than vanishing.
 *
 * Gating happens before any query: only detailed coverage with a present upstream record
 * claims step-level spans, so basic and unverified runs answer with their own honest
 * sentences and never ask the store for a timeline that cannot exist.
 */

/** The kind glyph: how a row is recognized before it is read. Null kind = unnamed. */
const KIND_ICONS: Record<
  NonNullable<ObservationRunStep["kind"]>,
  React.ComponentType<{ className?: string }>
> = {
  model: IconSparkles,
  tool: IconTool,
  retrieval: IconDatabase,
};

/** A projected leaf as display text, whatever the projection did to it. */
export function projectedValueText(
  value: SafeValue,
  truncatedMarker: string,
): string | null {
  switch (value.state) {
    case "omitted":
      return null;
    case "truncated":
      return `${plainText(value.value)} · ${truncatedMarker}`;
    case "projected":
      return plainText(value.value);
  }
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

export function ObservationRunSteps({
  botId,
  runId,
  upstream,
  capability,
}: {
  botId: string;
  runId: string;
  upstream: "present" | "unreconciled" | "absent";
  capability: RunCapabilityLevel;
}) {
  const { t } = useTranslation("ai-observability-runs");

  // No upstream record to read steps from: the availability half's own words, not new ones.
  if (upstream === "unreconciled") {
    return (
      <StateNotice
        description={t("availability.syncing.description")}
        title={t("availability.syncing.title")}
      />
    );
  }
  if (upstream === "absent") {
    return (
      <StateNotice
        description={t("detail.upstream.absentDescription")}
        title={t("detail.upstream.absentTitle")}
      />
    );
  }
  /*
   * Step-level spans are claimed only by detailed coverage. Basic coverage says the remote
   * runtime's interior was never recorded — the absence is not evidence nothing happened —
   * and an unverified verdict vouches for nothing, so neither run asks the store. The
   * gate is total on purpose (OCR round 3, R3-13): anything that is not literally
   * "detailed" — including a verdict word this build has never heard of, which the
   * detail guard now refuses upstream — answers with its own honest sentence and never
   * falls through to a timeline query.
   */
  if (capability !== "detailed") {
    return (
      <PageEmpty>
        {capability === "basic"
          ? t("detail.steps.basicNote")
          : t("detail.steps.coverageNote")}
      </PageEmpty>
    );
  }
  return <StepTimeline botId={botId} runId={runId} />;
}

function StepTimeline({ botId, runId }: { botId: string; runId: string }) {
  const { t } = useTranslation("ai-observability-runs");
  const screen = useQuery(observationRunStepsQueryOptions(botId, runId));

  if (screen.isPending) return null;

  // A transport-level error is the store failing to answer — the unavailable sentence.
  const fault = observationScreenFault(screen);
  if (fault !== null) {
    return (
      <StateNotice
        description={t(`availability.${fault}.description`)}
        title={t(`availability.${fault}.title`)}
      />
    );
  }

  const answer = screen.data;
  if (answer === undefined || answer.view !== "steps") return null;
  const steps = answer.result.steps;
  if (steps.length === 0) {
    // Recorded is the operative word: no spans were written, which is a fact about the
    // recording, never a claim that nothing happened inside the run.
    return <PageEmpty>{t("detail.steps.empty")}</PageEmpty>;
  }
  return (
    <PageRows>
      {buildStepTree(steps).map((node) => (
        <StepNode key={node.step.spanId} node={node} />
      ))}
    </PageRows>
  );
}

type StepNodeModel = {
  step: ObservationRunStep;
  children: readonly StepNodeModel[];
};

/**
 * The timeline the record dictates: steps sorted by their recorded start (input order when
 * a timestamp does not parse), nested under their recorded parent. A step whose parent is
 * dangling or cyclic keeps its place at the root — dropping it would invent a timeline.
 */
function buildStepTree(
  steps: readonly ObservationRunStep[],
): readonly StepNodeModel[] {
  const ordered = [...steps].sort((left, right) => {
    const a = Date.parse(left.startedAt);
    const b = Date.parse(right.startedAt);
    // An unparseable timestamp keeps the wire's own order rather than being ranked.
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    return a - b;
  });
  const bySpan = new Map(ordered.map((step) => [step.spanId, step]));
  const childrenOf = new Map<string, ObservationRunStep[]>();
  for (const step of ordered) {
    // The explicit null check is the narrowing isRoot's boolean cannot give the loop.
    if (step.parentSpanId === null || isRoot(step, bySpan)) continue;
    const siblings = childrenOf.get(step.parentSpanId) ?? [];
    siblings.push(step);
    childrenOf.set(step.parentSpanId, siblings);
  }
  const nodeOf = (step: ObservationRunStep): StepNodeModel => ({
    step,
    children: (childrenOf.get(step.spanId) ?? []).map(nodeOf),
  });
  return ordered.filter((step) => isRoot(step, bySpan)).map(nodeOf);
}

/**
 * Whether this step renders at the top level: no recorded parent, a parent the body never
 * carried, or a parent chain that cycles back to this step. A cycle roots the steps on it
 * (both, if it is a two-cycle) so nothing is dropped; a step hanging off a broken chain
 * still nests under its real parent, and only the broken ancestor roots.
 */
function isRoot(
  step: ObservationRunStep,
  bySpan: Map<string, ObservationRunStep>,
): boolean {
  const parentId = step.parentSpanId;
  if (parentId === null) return true;
  if (!bySpan.has(parentId)) return true; // a dangling parent roots its orphan
  const seen = new Set<string>([step.spanId]);
  let current: ObservationRunStep | undefined = bySpan.get(parentId);
  while (current !== undefined) {
    if (current.parentSpanId === null) return false; // the chain terminates: step nests
    if (seen.has(current.spanId)) {
      // The chain cycles; this step roots only if the cycle returns to it.
      return current.spanId === step.spanId;
    }
    seen.add(current.spanId);
    current = bySpan.get(current.parentSpanId);
  }
  return false; // an ancestor dangles: it roots itself, this step keeps its real parent
}

function StepNode({ node }: { node: StepNodeModel }) {
  const { t } = useTranslation("ai-observability-runs");
  const { step } = node;
  const KindIcon = step.kind === null ? IconMinus : KIND_ICONS[step.kind];

  const title =
    step.name ??
    (step.kind === null ? step.spanId : t(`detail.steps.kind.${step.kind}`));

  const duration = stepDuration(step);
  const meta = [
    step.kind === null ? null : t(`detail.steps.kind.${step.kind}`),
    step.executionState === undefined
      ? null
      : t(`detail.steps.execution.${step.executionState}`),
    duration === null ? t("row.durationUnavailable") : duration,
  ].filter((part): part is string => part !== null);

  const summary = stepSummary(step, t);

  return (
    <div data-step={step.spanId}>
      <Item size="sm">
        <ItemMedia variant="icon">
          <KindIcon className="size-4 text-muted-foreground" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{title}</ItemTitle>
          <ItemDescription className="line-clamp-none">
            {meta.join(" · ")}
          </ItemDescription>
          {summary !== null ? (
            // The payload preview is a summary, so it clamps; the record keeps the whole.
            <ItemDescription>{summary}</ItemDescription>
          ) : null}
        </ItemContent>
        <ItemActions>
          <span className="text-muted-foreground text-xs">
            {t(`states.${step.state}`)}
          </span>
        </ItemActions>
      </Item>
      {node.children.length > 0 ? (
        <div className="mt-2.5 ml-6 flex flex-col gap-2.5">
          {node.children.map((child) => (
            <StepNode key={child.step.spanId} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The step's own window, when both ends parse and agree on their order. */
function stepDuration(step: ObservationRunStep): string | null {
  const start = Date.parse(step.startedAt);
  const end = Date.parse(step.endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return formatDuration(end - start);
}

type StepTranslate = TFunction<"ai-observability-runs">;

/** The one-line summary under the meta: the query and its hits, or the payload preview. */
function stepSummary(
  step: ObservationRunStep,
  t: StepTranslate,
): string | null {
  const marker = (value: SafeValue | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    return projectedValueText(value, t("marker.truncated"));
  };
  if (step.retrieval !== undefined) {
    const parts = [
      marker(step.input),
      retrievalDetail(step.retrieval, t),
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return marker(step.output) ?? marker(step.input);
}

function retrievalDetail(
  retrieval: NonNullable<ObservationRunStep["retrieval"]>,
  t: StepTranslate,
): string | null {
  switch (retrieval.outcome) {
    case "hit": {
      const parts = [
        t("detail.steps.fragments", { count: retrieval.fragmentCount }),
        retrieval.kbIds.length > 0
          ? t("detail.steps.kbs", { count: retrieval.kbIds.length })
          : null,
      ].filter((part): part is string => part !== null);
      return parts.join(" · ");
    }
    case "miss":
      return t("detail.steps.noResults");
    case "degraded":
      return t("detail.steps.degraded", { reason: retrieval.reason });
  }
}
