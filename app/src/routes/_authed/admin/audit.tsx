import { IconDownload, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  DID_NOT_HAPPEN_EVENT_TYPES,
  eventTypeFilter,
  outcomeOf,
  REFUSED_EVENT_TYPES,
} from "@/lib/audit/outcome";
import { auditEventsQueryOptions, auditExportUrl } from "@/lib/audit/queries";
import { silenceOf } from "@/lib/audit/silence";
import { client } from "@/lib/client";
import { useDateTime } from "@/lib/i18n/datetime";

/**
 * Read surface for policy, computer, component, MCP, and credential audit events.
 */
export const Route = createFileRoute("/_authed/admin/audit")({
  component: AuditPage,
});

/** One row as the API returns it. */
type AuditEvent = {
  id: string;
  actorUserId: string | null;
  /** Absent on a deployment that has not migrated yet. */
  initiatorKind?: string;
  initiatorId?: string | null;
  eventType: string;
  targetType: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

/*
 * The saved views, built from the same lists the row label and colour are decided by.
 *
 * Written out by hand here and again below, they had already drifted: a refusal on one list and not
 * the other is a row drawn as "Allowed" or a row missing from the view somebody clicks to ask what
 * this deployment refused. See `@/lib/audit/outcome`, which is now the only place either question is
 * answered.
 */
const FILTERS = [
  { label: "audit.filters.everything", search: "" },
  {
    label: "audit.filters.computerActions",
    search: "?eventType=computer.action_allowed",
  },
  {
    label: "audit.filters.blocked",
    search: eventTypeFilter(REFUSED_EVENT_TYPES),
  },
  {
    label: "audit.filters.didNotHappen",
    search: eventTypeFilter(DID_NOT_HAPPEN_EVENT_TYPES),
  },
  {
    label: "audit.filters.nobodyWatching",
    search: "?initiatorKind=routine,handoff,responsibility,memory",
  },
] as const satisfies readonly { label: string; search: string }[];

function AuditPage() {
  const { t } = useTranslation("admin");
  const [search, setSearch] = useState<string>(FILTERS[0].search);
  const events = useQuery(auditEventsQueryOptions(search));
  const rows = (events.data?.events ?? []) as AuditEvent[];
  const nameFor = useBotNames();
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportCapped, setExportCapped] = useState<number | null>(null);

  /*
   * The same filtered query as the table, downloaded as a file. The server walks every
   * matching page up to its cap, so this stays a single request no matter how many pages
   * the filter matches; the filename carries the day it was pulled.
   */
  async function exportCsv() {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportCapped(null);
    try {
      const response = await client(auditExportUrl(search), {
        fallback: "Could not export audit events",
      });
      // A file that stopped early must say so, or it reads as the whole trail.
      const capped = Number(response.headers.get("x-audit-export-truncated"));
      if (Number.isInteger(capped) && capped > 0) setExportCapped(capped);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `audit-events-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(
        error instanceof Error
          ? error.message
          : "Could not export audit events",
      );
    } finally {
      setExporting(false);
    }
  }

  return (
    /*
     * THE ONE WIDE PAGE IN ADMIN, and the one that keeps a table. Five columns of short values is
     * what a log is; rows of prose would make every entry a paragraph and the scanning this page
     * exists for impossible. It takes the same header and the same type scale as everything else,
     * and differs only where the content forces it to.
     */
    <PageShell
      action={
        <div className="flex items-center gap-2">
          <Button
            disabled={exporting}
            onClick={exportCsv}
            size="sm"
            variant="outline"
          >
            <IconDownload />
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button onClick={() => events.refetch()} size="sm" variant="ghost">
            <IconRefresh />
            Refresh
          </Button>
        </div>
      }
      description={t("audit.description")}
      title={t("audit.title")}
      width="wide"
    >
      <PageSection>
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <Button
              key={filter.label}
              onClick={() => setSearch(filter.search)}
              size="sm"
              type="button"
              /* The fill is the state, as on every other set of switches in the app. */
              variant={search === filter.search ? "default" : "outline"}
            >
              {t(filter.label)}
            </Button>
          ))}
        </div>

        {exportError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {exportError}
          </p>
        ) : null}
        {exportCapped ? (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            The file holds the newest {exportCapped.toLocaleString()} events,
            not all of them. Narrow the filter or the dates to export the rest.
          </p>
        ) : null}
        {events.isPending ? null : events.isError ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("audit.loadError")}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>{t("audit.noMatches")}</PageEmpty>
        ) : (
          <section
            aria-label={t("audit.title")}
            className="mt-4 overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-2 focus-visible:outline-ring"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: An overflow region needs keyboard focus to scroll in Safari; the region has an accessible name.
            tabIndex={0}
          >
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground text-xs">
                <tr className="border-border border-b">
                  <th className="px-4 py-2 font-medium">{t("audit.when")}</th>
                  <th className="px-4 py-2 font-medium">{t("audit.what")}</th>
                  <th className="px-4 py-2 font-medium">{t("audit.on")}</th>
                  <th className="px-4 py-2 font-medium">{t("audit.bot")}</th>
                  <th className="px-4 py-2 font-medium">
                    {t("audit.startedBy")}
                  </th>
                  <th className="px-4 py-2 font-medium">
                    {t("audit.decision")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <Row event={event} key={event.id} nameFor={nameFor} />
                ))}
              </tbody>
            </table>
          </section>
        )}
      </PageSection>
    </PageShell>
  );
}

function StartedBy({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  const { t } = useTranslation("admin");
  if (event.initiatorKind === "routine") {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {t("audit.initiator.routine")}
      </span>
    );
  }
  if (event.initiatorKind === "handoff") {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {event.initiatorId
          ? t("audit.initiator.handedOnBy", {
              name: nameFor(event.initiatorId),
            })
          : t("audit.initiator.handedOn")}
      </span>
    );
  }
  if (
    event.initiatorKind === "responsibility" ||
    event.initiatorKind === "memory"
  ) {
    return (
      <span
        className="font-medium text-amber-600 dark:text-amber-500"
        title={event.initiatorId ?? undefined}
      >
        {event.initiatorKind === "memory"
          ? t("audit.initiator.memorySource")
          : t("audit.initiator.responsibility")}
      </span>
    );
  }
  if (event.initiatorKind === "deployment") {
    return (
      <span className="text-muted-foreground">
        {t("audit.initiator.deployment")}
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">{t("audit.initiator.person")}</span>
  );
}

function Row({
  event,
  nameFor,
}: {
  event: AuditEvent;
  nameFor: (botId: string) => string;
}) {
  const { t } = useTranslation("admin");
  const { formatTime } = useDateTime();
  const payload = event.payload ?? {};
  const decision = (payload.decision ?? {}) as {
    allowed?: boolean;
    mode?: string;
    rule?: string | null;
    carriedOut?: boolean;
  };
  const element = payload.element as
    | { role?: string; name?: string }
    | string
    | undefined;
  const outcome = outcomeOf(event.eventType);
  const refused = outcome === "refused";
  const stalled = event.eventType === "agent.stream_stalled";
  /*
   * Three different things, and the difference is what somebody comes to this row to find out.
   *
   * A person naming a coworker, the router matching one, and the router giving up and using the
   * default are not the same event, and one label covering all three would make the row worth less
   * than the reason line under it. Nothing here is a refusal, so none of them take the refusal
   * colour.
   */
  const routed =
    event.eventType === "channel.routed"
      ? payload.viaMention === true
        ? t("audit.routed.personChose")
        : payload.fallback === true
          ? t("audit.routed.default")
          : t("audit.routed.intended")
      : null;
  // Allowed by policy but not carried out. A stalled turn belongs in the same family: the Bot was
  // asked and the answer never arrived. Colour is how this table is read, and a row left in the
  // muted foreground reads as "Allowed", which a turn nobody ever got an answer to was not.
  const failed = outcome === "did-not-happen";
  const silence = stalled ? silenceOf(payload) : null;
  const decisionKey =
    event.eventType in DECISIONS
      ? DECISIONS[event.eventType as keyof typeof DECISIONS]
      : null;

  return (
    <tr className="border-border border-t align-top">
      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
        {formatTime(event.createdAt)}
      </td>
      <td className="px-4 py-2 font-medium">
        {/* Strip the internal computer tool namespace for display. */}
        {typeof payload.action === "string"
          ? payload.action.replace("computer_", "")
          : event.eventType}
      </td>
      <td className="px-4 py-2">
        {/*
         * A routing row's subject is the coworker it went to, and it is the only thing on the row
         * worth reading. Its target type is `agent`, which is not a named target because everywhere
         * else an agent id appears it belongs in the Bot column; here nothing acted, so there is no
         * Bot and the target is all there is. Rendered through `nameFor` so it reads as the name on
         * the roster rather than the immutable id.
         */}
        {event.eventType === "channel.routed" && event.targetId ? (
          <span title={event.targetId}>{nameFor(event.targetId)}</span>
        ) : /*
         * A discovery row's subject is the narrowing itself, so the numbers are the subject. A
         * reader asking "why did it not call the tool" needs to see that eleven of thirty were
         * offered before anything else on the row means anything.
         */
        event.eventType === "mcp.tools_discovered" ? (
          <span className="font-mono text-xs">
            {typeof payload.offered === "number" &&
            typeof payload.granted === "number"
              ? t("audit.toolsOffered", {
                  offered: payload.offered,
                  granted: payload.granted,
                })
              : "-"}
          </span>
        ) : /* Named targets and file paths are the audit subject before page elements. */
        NAMED_TARGETS.has(event.targetType) && event.targetId ? (
          <span className="font-mono text-xs">
            {event.targetId}
            {typeof payload.function === "string" ? (
              <span className="text-muted-foreground">
                {" "}
                · {payload.function}
              </span>
            ) : null}
          </span>
        ) : typeof payload.file === "string" ? (
          <span className="font-mono text-xs">{payload.file}</span>
        ) : typeof payload.command === "string" ? (
          // The command is the subject of its own row, the way a path is for a file action.
          <span className="font-mono text-xs">{payload.command}</span>
        ) : typeof element === "object" && element?.name ? (
          <span>
            {element.name}
            {element.role ? (
              <span className="text-muted-foreground"> ({element.role})</span>
            ) : null}
          </span>
        ) : typeof element === "string" ? (
          <span className="text-muted-foreground">{element}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
        {/* Page host is meaningful only for browser actions, not workspace file actions. */}
        {typeof payload.file !== "string" &&
        typeof payload.command !== "string" &&
        typeof payload.page === "string" &&
        payload.page ? (
          <div className="text-xs text-muted-foreground">
            {hostOf(payload.page)}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2 text-muted-foreground">
        {typeof payload.bot === "string" ? (
          // Keep the immutable bot id available even when names collide.
          <span title={payload.bot}>{nameFor(payload.bot)}</span>
        ) : (
          "-"
        )}
      </td>
      <td className="px-4 py-2">
        <StartedBy event={event} nameFor={nameFor} />
      </td>
      <td className="px-4 py-2">
        <span
          className={
            refused
              ? "font-medium text-destructive"
              : failed
                ? "font-medium text-amber-600 dark:text-amber-500"
                : "text-muted-foreground"
          }
        >
          {routed ??
            (decisionKey
              ? t(decisionKey)
              : refused
                ? t("audit.decisionBlocked")
                : failed
                  ? t("audit.decisionDidNotHappen")
                  : t("audit.decisionAllowed"))}
        </span>
        {/* Refusal reasons mirror the conversation-facing reason. */}
        {(event.eventType === "component.refused" ||
          event.eventType === "component.function_refused" ||
          event.eventType === "mcp.call_rejected") &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {/*
         * Why this run was offered what it was, which is the only part of a discovery row that
         * cannot be worked out from the numbers. "Nothing declared" and "selector unavailable" both
         * offer everything and mean entirely different things about the deployment.
         */}
        {event.eventType === "mcp.tools_discovered" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason in DISCOVERY_REASONS
              ? t(
                  DISCOVERY_REASONS[
                    payload.reason as keyof typeof DISCOVERY_REASONS
                  ],
                )
              : payload.reason}
            {Array.isArray(payload.skills) && payload.skills.length > 0
              ? `: ${payload.skills.join(", ")}`
              : ""}
          </div>
        ) : null}
        {event.eventType === "mcp.callback_refused" &&
        typeof payload.refusal === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.refusal}
          </div>
        ) : null}
        {/*
         * Why the conversation went where it went, which is the whole reason the row is written.
         * Without it a routing row says "Allowed" and names nobody, which is indistinguishable from
         * a row that failed to write.
         */}
        {event.eventType === "channel.routed" &&
        typeof payload.reason === "string" ? (
          /*
           * A width rather than a max-width, because the table lays itself out from its content and
           * a max-width on a block inside a cell does not constrain that. A router's reason is a
           * sentence a model wrote, not a rule name, and left unbounded in the last column it
           * pushes the table wider than the page and the end of the sentence goes off the edge,
           * where nobody scrolls to find it.
           */
          <div className="mt-0.5 w-[22rem] break-words text-xs text-muted-foreground">
            {payload.reason}
          </div>
        ) : null}
        {event.eventType === "bot.declined" &&
        typeof payload.reason === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.reason}
            <span className="italic">{t("audit.reportedByBot")}</span>
          </div>
        ) : null}
        {failed && typeof payload.failure === "string" ? (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {payload.failure}
          </div>
        ) : null}
        {/*
         * The two numbers the stall row is worth reading for. Without them every stalled turn looks
         * the same, and the difference between an endpoint that dies halfway through an answer and
         * one that never begins is the difference between a slow Bot and a dead one.
         */}
        {silence ? (
          <div className="mt-0.5 text-xs text-muted-foreground">{silence}</div>
        ) : null}
        {/* Show concrete policy rules, but suppress the uninformative default `true` allow rule. */}
        {decision.rule && decision.rule !== "true" ? (
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {decision.rule}
          </div>
        ) : null}
        {decision.mode === "dry-run" &&
        decision.allowed === false &&
        decision.carriedOut ? (
          <div className="text-xs text-muted-foreground">
            {t("audit.dryRunRecorded")}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * Target types whose id is a name worth putting on screen.
 *
 * Anything else falls through to the element or file subject.
 */
/**
 * Why a run was offered the tools it was, in words rather than in the slug the server writes.
 *
 * Every one of these looks the same from outside: the Bot was handed some tools. The distinction is
 * the difference between a deployment that narrowed on purpose, one that has never declared a skill,
 * and one whose selector could not be reached, and only the last is a fault.
 */
const DISCOVERY_REASONS = {
  "under-floor": "audit.discovery.underFloor",
  "nothing-declared": "audit.discovery.nothingDeclared",
  unavailable: "audit.discovery.unavailable",
  "nothing-chosen": "audit.discovery.nothingChosen",
  selected: "audit.discovery.selected",
} as const satisfies Record<string, string>;

const NAMED_TARGETS = new Set([
  "component",
  "mcp_tool",
  "mcp_server",
  "skill",
  "credential",
]);

const DECISIONS = {
  "bot.declined": "audit.decisions.botDeclined",
  // Not a refusal, so not the refusal colour: nothing was blocked. The Bot was asked and never
  // answered, which is the same complaint as an action that was allowed and then did not happen.
  "agent.stream_stalled": "audit.decisions.streamStalled",
  "computer.policy_loaded": "audit.decisions.boundaryAtStartup",
  "computer.isolation_loaded": "audit.decisions.isolationAtStartup",
  "computer.control_taken": "audit.decisions.controlTaken",
  "computer.control_released": "audit.decisions.controlReleased",
  "computer.help_requested": "audit.decisions.helpRequested",
  "computer.secret_requested": "audit.decisions.secretRequested",
  "computer.secret_supplied": "audit.decisions.secretSupplied",
  "computer.reset": "audit.decisions.computerReset",
  "computer.updated": "audit.decisions.computerUpdated",
  "computer.stopped": "audit.decisions.personPressedStop",

  "component.granted": "audit.decisions.grantedToBot",
  "component.revoked": "audit.decisions.takenFromBot",
  "component.published": "audit.decisions.published",
  "component.unpublished": "audit.decisions.unpublished",
  "component.draft_saved": "audit.decisions.draftSaved",
  "component.refused": "audit.decisions.refused",
  "component.function_granted": "audit.decisions.mayRead",
  "component.function_revoked": "audit.decisions.mayNoLongerRead",
  "component.function_called": "audit.decisions.readRealData",
  "component.function_refused": "audit.decisions.refusedFunction",
  // A function failure is execution failure, not a policy refusal.
  "component.function_failed": "audit.decisions.couldNotBeRead",

  // Not a call and not a decision: the tools this run was allowed to see. Worded so nobody reads it
  // as permission, which it is not — everything named was already granted.
  "mcp.tools_discovered": "audit.decisions.toolsOfferedForRun",
  "mcp.call_succeeded": "audit.decisions.calledOnBehalf",
  "mcp.call_rejected": "audit.decisions.blocked",
  "mcp.call_failed": "audit.decisions.serverDidNotAnswer",
  // Not "Blocked": nothing about the Bot was judged, because nothing proved which Bot it was.
  "mcp.callback_refused": "audit.decisions.couldNotProveBot",

  "configuration.changed": "audit.decisions.configurationChanged",
  "credential.created": "audit.decisions.credentialSaved",
} as const satisfies Record<string, string>;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
