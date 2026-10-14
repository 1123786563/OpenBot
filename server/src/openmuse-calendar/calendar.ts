import type { GCalendarProviderEvent } from "./client";

/**
 * The §4 Calendar read DTO — the only shape an OpenMuse Calendar response
 * ever carries. Provider fields beyond these are dropped at the mapping, so
 * no vendor action shape can leak into the DTO. `start`/`end` are
 * pass-through: an RFC 3339 instant for timed events, a date-only string for
 * all-day ones (start inclusive, end exclusive), exactly as the provider
 * holds them — A03 owns rendering them in the reader's zone.
 */
export type OpenMuseCalendarEvent = {
  id: string;
  calendarId: string;
  etag: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  timeZone: string;
  location: string;
  description: string;
  attendees: string[];
};

/**
 * Map one provider row onto the DTO, or null for a row with no id to keyset
 * on — a row that cannot even be named is dropped rather than guessed at.
 */
export function mapProviderEvent(
  row: GCalendarProviderEvent,
): OpenMuseCalendarEvent | null {
  if (typeof row.id !== "string" || row.id === "") return null;
  return {
    id: row.id,
    calendarId: readString(row.calendarId),
    etag: readString(row.etag),
    title: readString(row.title),
    start: readString(row.start),
    end: readString(row.end),
    allDay: row.allDay === true,
    timeZone: readString(row.timeZone),
    location: readString(row.location),
    description: readString(row.description),
    attendees: readAttendees(row.attendees),
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Attendees as §4 answers them: addresses. The live provider shape is not
 * pinned here, so both plausible forms map — a bare string and the `{email}`
 * object Google's events carry; anything else drops. O02 records which the
 * live dial answers.
 */
function readAttendees(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((attendee): string[] => {
    if (typeof attendee === "string") return [attendee];
    if (attendee !== null && typeof attendee === "object") {
      const email = (attendee as Record<string, unknown>).email;
      if (typeof email === "string" && email !== "") return [email];
    }
    return [];
  });
}

/**
 * One event's start as the sort and keyset key: its instant for timed rows,
 * UTC midnight for a date-only one (which `Date.parse` answers stably), and
 * an unparseable start sorts as 0 rather than scattering `NaN` through the
 * page — the same choice mail's `receivedAtMs` makes.
 */
export function startKey(start: string): number {
  const parsed = Date.parse(start);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function eventStartMs(event: OpenMuseCalendarEvent): number {
  return startKey(event.start);
}

/**
 * The tiebreak key every same-start comparison uses: `calendarId` + NUL +
 * `id`. Provider event ids are unique PER CALENDAR only (the §4 DTO carries
 * calendarId for exactly that reason), so an aggregated multi-calendar
 * answer can legitimately hold two rows with one id — dedupe, sort and
 * keyset all key on this composite or one of the two is silently lost.
 */
export function eventTieKey(event: { calendarId: string; id: string }): string {
  return `${event.calendarId}\u0000${event.id}`;
}

/** The §4 list sort: ascending start, then the composite (calendarId, id). */
export function sortAscending(
  events: OpenMuseCalendarEvent[],
): OpenMuseCalendarEvent[] {
  return [...events].sort((left, right) => {
    const leftAt = eventStartMs(left);
    const rightAt = eventStartMs(right);
    if (leftAt !== rightAt) return leftAt - rightAt;
    return tieOrder(eventTieKey(left), eventTieKey(right));
  });
}

/** String comparison bent into a comparator: ascending, like the ids it keys. */
function tieOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Whether an event sorts strictly after the cursor position (both ascending). */
export function comesAfter(
  event: OpenMuseCalendarEvent,
  cursor: { startMs: number; tieKey: string },
): boolean {
  const at = eventStartMs(event);
  if (at !== cursor.startMs) return at > cursor.startMs;
  return eventTieKey(event) > cursor.tieKey;
}

/**
 * The opaque cursor: base64 of the owner+connection binding and the keyset
 * position. Opaque because it names a person's alias, and bound because a
 * cursor from another owner or another connection seat must refuse (400), not
 * silently continue somebody else's page. The keyset position is the last
 * shipped event's own `start` string, kept verbatim so a date-only all-day
 * start round-trips without being re-serialized into an instant.
 *
 * The providerToken (mail's M02 shape) is where the next request resumes the
 * provider's own page walk: the entry token of the earliest fetched provider
 * page still holding an unshipped event, so resuming can never skip past one
 * into a gap — without it every cursor page re-walked the provider from its
 * first page, an O(pages²) dial bill deep pagination pays on every press.
 */
/*
 * The cursor also binds the QUERY WINDOW it was minted under (round 6 M11,
 * mail's own cursor discipline): the keyset position and the provider's
 * resume token are both window-shaped, so a client reusing a cursor against
 * a different timeMin/timeMax would silently page from the OLD window's
 * position — events before it in the new window skipped without an error —
 * and mix a token the old window minted into the new one's pagination. A
 * window mismatch answers the same 400 as a foreign cursor.
 */
export function encodeCalendarCursor(cursor: {
  owner: string;
  alias: string;
  start: string;
  id: string;
  /** The tiebreak's calendar half — a cursor without it cannot resume an id. */
  calendarId: string;
  /** The window this page was served under (M11): mismatched reuse refuses. */
  timeMin: string;
  timeMax: string;
  providerToken?: string | null;
}): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64");
}

export function decodeCalendarCursor(value: string): {
  owner: string;
  alias: string;
  start: string;
  id: string;
  calendarId: string;
  timeMin: string;
  timeMax: string;
  providerToken: string | null;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.owner !== "string" ||
    typeof record.alias !== "string" ||
    typeof record.start !== "string" ||
    typeof record.id !== "string"
  ) {
    return null;
  }
  return {
    owner: record.owner,
    alias: record.alias,
    start: record.start,
    id: record.id,
    // Lenient for a cursor minted before the field existed: "" sorts
    // before every real calendar id.
    calendarId: typeof record.calendarId === "string" ? record.calendarId : "",
    // Same leniency for pre-M11 cursors: "" matches no window a request
    // names, so window-bound reuse of an old cursor refuses (400) rather
    // than paging from a position the new window never minted.
    timeMin: typeof record.timeMin === "string" ? record.timeMin : "",
    timeMax: typeof record.timeMax === "string" ? record.timeMax : "",
    // Lenient for a cursor minted before the field existed: null re-walks
    // the provider from its first page.
    providerToken:
      typeof record.providerToken === "string" ? record.providerToken : null,
  };
}
