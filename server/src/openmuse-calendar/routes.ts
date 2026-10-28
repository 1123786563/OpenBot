import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import { z } from "zod";
import type { AppVariables } from "../auth/public";
import type { OpenMuseGoogleOAuth } from "../openmuse-connectors/google-oauth";
import {
  OpenMuseConnectionRefusedError,
  OpenMuseOwnerDisabledError,
  OpenMuseVendorUnavailableError,
} from "../openmuse-connectors/google-oauth";
import { parsePageLimit } from "../paging";
import {
  comesAfter,
  decodeCalendarCursor,
  encodeCalendarCursor,
  eventTieKey,
  mapProviderEvent,
  type OpenMuseCalendarEvent,
  sortAscending,
  startKey,
} from "./calendar";
import type { OpenMuseCalendarClient } from "./client";
import { OpenMuseCalendarVendorError } from "./client";

const log = getLogger("server");

/** The §4 list defaults: 50 per page, at most 100. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/*
 * A vendor that needs more provider pages than this to fill one response page
 * is stalling, not paging: the stitch stops and answers what it has, with the
 * last page's truncation flag already on the answer and a cursor that resumes
 * the walk at its first page. ponytail: fixed cap is enough — a token-paging
 * vendor serving ≥1 new row per page reaches surplus within MAX_LIMIT pages.
 */
const MAX_PROVIDER_PAGES = 100;

/*
 * The stitch's total time budget: a slow-but-valid provider must not pin the
 * request for MAX_PROVIDER_PAGES × 30s of dial timeouts. Passing the budget
 * stops the walk exactly like the page cap — truncated on, cursor out — so
 * the client can resume rather than wait out a degraded vendor.
 */
const STITCH_BUDGET_MS = 60_000;

/**
 * An RFC 3339 instant's shape, checked BEFORE `Date.parse`: the parser alone
 * accepts "March 5, 2026" and friends, which would pass this route's 400 gate
 * and surface as a vendor 502 instead of the route's own refusal.
 */
const RFC3339_INSTANT =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * §4: the window spans at most 366 days. A fixed ms ceiling, so a
 * DST-shifted window lands an hour either side of the calendar-day count and
 * still serves — the same slack OpenMuse's own validation tolerated.
 */
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * The window query, validated as one value: both bounds required and
 * parseable as instants, the later strictly after the earlier, and the span
 * inside §4's ceiling — checked BEFORE any vendor call, so a malformed
 * window is answered by the route and never dialed.
 */
const TimeRangeQuery = z
  .object({
    timeMin: z.string().min(1),
    timeMax: z.string().min(1),
  })
  .superRefine((range, issue) => {
    if (
      !RFC3339_INSTANT.test(range.timeMin) ||
      !RFC3339_INSTANT.test(range.timeMax)
    ) {
      issue.addIssue({
        code: "custom",
        message: "timeMin and timeMax must be RFC 3339 instants.",
      });
      return;
    }
    const from = Date.parse(range.timeMin);
    const to = Date.parse(range.timeMax);
    if (Number.isNaN(from) || Number.isNaN(to)) {
      issue.addIssue({
        code: "custom",
        message: "timeMin and timeMax must be RFC 3339 instants.",
      });
      return;
    }
    if (to <= from) {
      issue.addIssue({
        code: "custom",
        message: "timeMax must be after timeMin.",
      });
      return;
    }
    if (to - from > MAX_WINDOW_MS) {
      issue.addIssue({
        code: "custom",
        message: "timeMin and timeMax must span at most 366 days.",
      });
    }
  });

/**
 * `/api/mobile/openmuse-calendar` (A01, contracts §4): the authenticated
 * owner's Calendar events as the §4 DTO — ascending `start` then id, the
 * window half-open `[timeMin, timeMax)` at most 366 days (the provider owns
 * the edge filtering; the route owns refusing a malformed ask), the cursor
 * an opaque owner+connection-bound keyset. The G03 guard runs FIRST: a
 * disconnected account answers its stable 409 before any vendor call is
 * made, and a Gmail grant never satisfies the calendar branch.
 */
export function createOpenMuseCalendarRoutes(deps: {
  /** Absent when the vendor base URL could not be built — reads answer 503. */
  client?: OpenMuseCalendarClient;
  /** G01's requireConnection seam, borrowed whole — the G03 calendar branch or the 409 refusal. */
  service: Pick<OpenMuseGoogleOAuth, "requireConnection">;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
  /**
   * The §9 disabled-owner marker, REQUIRED: this route's own gate is the
   * only disabled-owner refusal requireConnection never makes, so an absent
   * callback would silently re-open a disabled owner's calendar reads. The
   * assembly passes the shared deletion-marker query (connectors rows).
   */
  ownerDisabled: (userId: string) => Promise<boolean>;
}): Hono<{ Variables: AppVariables }> {
  const client = () => {
    if (!deps.client) throw new OpenMuseVendorUnavailableError();
    return deps.client;
  };
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", deps.requireUser);
  routes.onError((error, context) => {
    if (error instanceof OpenMuseOwnerDisabledError) {
      // §9: the disabled marker is consulted before anything else, so a
      // disabled owner's reads stop without a vendor call.
      return context.json(
        { error: "This owner's calendar is unavailable." },
        403,
      );
    }
    if (error instanceof OpenMuseConnectionRefusedError) {
      // §4: a provider call without that provider's consent stops here, 409,
      // with a code the client can key on rather than a sentence to parse.
      return context.json(
        { error: error.message, code: "connection_required" },
        error.status,
      );
    }
    if (error instanceof OpenMuseVendorUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    if (error instanceof OpenMuseCalendarVendorError) {
      return context.json({ error: error.message }, 502);
    }
    // The unrecognized remainder is not a vendor answer: log it, or an
    // ownerDisabled-store outage or a code defect hides behind the 503.
    log.error(
      {
        type: "openmuse-calendar-route-error",
        error: error instanceof Error ? error.message : String(error),
        route: context.req.path,
      },
      "openmuse-calendar-route-error",
    );
    return context.json(
      { error: "Calendar is unavailable right now. Try again." },
      503,
    );
  });

  routes.get("/", async (context) => {
    context.header("Cache-Control", "no-store");
    const actor = context.var.actor;
    if (await deps.ownerDisabled(actor.id)) {
      throw new OpenMuseOwnerDisabledError(actor.id);
    }
    // The guard BEFORE the dial: disconnected means the vendor is never asked.
    const connection = await deps.service.requireConnection(
      actor.id,
      "googlecalendar",
    );
    const limit = parsePageLimit(context.req.query("limit") ?? null, MAX_LIMIT);
    if (!limit.ok) {
      return context.json({ error: limit.error }, 400);
    }
    const pageSize = limit.limit ?? DEFAULT_LIMIT;
    const range = TimeRangeQuery.safeParse({
      timeMin: context.req.query("timeMin"),
      timeMax: context.req.query("timeMax"),
    });
    if (!range.success) {
      return context.json(
        { error: range.error.issues[0]?.message ?? "Supply a valid window." },
        400,
      );
    }
    const { timeMin, timeMax } = range.data;

    const rawCursor = context.req.query("cursor");
    let cursor: {
      startMs: number;
      tieKey: string;
      providerToken: string | null;
    } | null = null;
    // The inbound cursor's own keyset position, replayed onto the outbound
    // cursor when a truncation ships an empty page (M10).
    let resumePosition: {
      start: string;
      id: string;
      calendarId: string;
    } | null = null;
    if (rawCursor !== undefined && rawCursor !== "") {
      const decoded = decodeCalendarCursor(rawCursor);
      if (
        decoded === null ||
        decoded.owner !== actor.id ||
        decoded.alias !== connection.alias ||
        // M11, mail's own cursor discipline: the window is part of the
        // binding, so a cursor reused against a different window refuses
        // instead of silently resuming the old one's position.
        decoded.timeMin !== timeMin ||
        decoded.timeMax !== timeMax
      ) {
        return context.json(
          { error: "That cursor does not belong to this account." },
          400,
        );
      }
      cursor = {
        startMs: startKey(decoded.start),
        tieKey: eventTieKey(decoded),
        providerToken: decoded.providerToken,
      };
      // M10: the inbound position itself, kept for a truncation that ships
      // an EMPTY page — the resume cursor then re-states it rather than
      // leaving the client positionless.
      resumePosition = {
        start: decoded.start,
        id: decoded.id,
        calendarId: decoded.calendarId,
      };
    }

    /*
     * The provider pages by its own token, and the walk resumes at the token
     * the inbound cursor recorded (mail's M02 shape). The stitch keeps dialing
     * while the page is not yet full-plus-surplus and the provider holds more,
     * because a later provider page can hold a row that sorts BEFORE the last
     * row shipped here — stopping early would strand it behind the keyset
     * forever. Rows are deduped by id across pages: a row re-served at a page
     * boundary must not reach the page twice. Every fetched page is remembered
     * with its entry token: the outbound cursor must resume the provider walk
     * at the EARLIEST page still holding an unshipped row, since resuming
     * later drops that row into a gap (and resuming earlier only re-reads
     * what the keyset skips).
     */
    const pages: Array<{ entryToken: string | null; keys: Set<string> }> = [];
    const byId = new Map<string, OpenMuseCalendarEvent>();
    let remainingCount = 0;
    let truncated = false;
    let nextToken = cursor?.providerToken ?? null;
    let pageFetches = 0;
    const seenTokens = new Set<string>();
    const stitchStartedAt = Date.now();
    let stoppedShort = false;
    let stitchTimedOut = false;
    while (pageFetches < MAX_PROVIDER_PAGES) {
      if (Date.now() - stitchStartedAt > STITCH_BUDGET_MS) {
        stitchTimedOut = true;
        break;
      }
      if (nextToken !== null) {
        // A repeating token is a vendor loop, not a page: an honest cut, not
        // a silent "complete".
        if (seenTokens.has(nextToken)) {
          stoppedShort = true;
          break;
        }
        seenTokens.add(nextToken);
      }
      const entryToken = nextToken;
      const answer = await client().list(connection.alias, {
        timeMin,
        timeMax,
        ...(entryToken === null ? {} : { pageToken: entryToken }),
      });
      pageFetches += 1;
      // Accumulated across stitched pages: any page the vendor held back on
      // keeps the flag on, even if a later page exhausts the walk.
      truncated = truncated || answer.truncated;
      const fetched = { entryToken, keys: new Set<string>() };
      pages.push(fetched);
      for (const row of answer.events) {
        const event = mapProviderEvent(row);
        if (event === null) continue;
        // Deduped by the (calendarId, id) composite: provider event ids are
        // unique per calendar only, so a re-served row at a page boundary
        // is the SAME row, and an id reused across calendars is not.
        const key = eventTieKey(event);
        if (byId.has(key)) continue;
        byId.set(key, event);
        fetched.keys.add(key);
        if (cursor === null || comesAfter(event, cursor)) remainingCount += 1;
      }
      nextToken = answer.nextToken;
      if (nextToken === null || remainingCount > pageSize) break;
    }
    const sorted = sortAscending([...byId.values()]);
    // The keyset: only events strictly after the cursor's position.
    const remaining =
      cursor === null
        ? sorted
        : sorted.filter((event) => comesAfter(event, cursor));
    const page = remaining.slice(0, pageSize);
    const last = page.at(-1);
    const hasSurplus = remaining.length > pageSize;
    /*
     * M12: a token ring (stoppedShort) is an involuntary stop exactly like
     * the page cap and the time budget — folding it into `capped` is what
     * makes every truncated response carry a resumable cursor, instead of a
     * "there is more" flag with no position to resume from.
     */
    const capped =
      (nextToken !== null && pageFetches >= MAX_PROVIDER_PAGES) ||
      stitchTimedOut ||
      stoppedShort;
    let resumeToken = nextToken;
    if (hasSurplus) {
      const unshipped = new Set(remaining.slice(pageSize).map(eventTieKey));
      resumeToken =
        pages.find((fetched) =>
          [...fetched.keys].some((key) => unshipped.has(key)),
        )?.entryToken ?? null;
    }
    /*
     * M10: an EMPTY page under an involuntary stop still states the resume
     * position — the inbound cursor's own keyset, since every fetched row
     * sorted before it — so the client keeps its place instead of retrying
     * from zero into the same stop. Without an inbound cursor there is no
     * position to state (mail's recorded empty-page tradeoff), and the
     * truncation flag alone stays honest.
     */
    const mustResume = hasSurplus || capped;
    const position = !mustResume
      ? null
      : last !== undefined
        ? { start: last.start, id: last.id, calendarId: last.calendarId }
        : resumePosition;
    return context.json({
      events: page,
      truncated: truncated || stoppedShort || capped,
      ...(position !== null
        ? {
            nextCursor: encodeCalendarCursor({
              owner: actor.id,
              alias: connection.alias,
              start: position.start,
              id: position.id,
              calendarId: position.calendarId,
              timeMin,
              timeMax,
              providerToken: resumeToken,
            }),
          }
        : {}),
    });
  });

  return routes;
}
