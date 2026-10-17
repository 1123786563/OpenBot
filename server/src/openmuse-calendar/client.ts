import { getLogger } from "../../../shared/logger";
import { createOpenMuseMailDial } from "../openmuse-mail/client";

const log = getLogger("server");

/**
 * The Calendar vendor dial for OpenMuse Calendar reads (A01, contracts §4),
 * split the way `openmuse-mail/client.ts` is split:
 * {@link buildOpenMuseCalendarClient} is pure assembly over an injectable
 * dial, so every test below it is an object literal and no socket is ever
 * opened; {@link createOpenMuseCalendarClient} is the thin layer that owns
 * the real `fetch` and the base address.
 *
 * THE ACTION-CALL SEAM is the one the adapter already models
 * (`openconnector-adapter.ts` `actions.execute`): `POST /v1/actions/<actionId>`
 * with body `{ input }`, running in the owner's connection via the
 * `x-oo-connector-alias` header — the alias `openmuseAlias(userId,
 * "googlecalendar")` minted in G01. THE ACTION ID IS A PLACEHOLDER: this
 * repository pins no gcalendar action ids, so `gcalendar.list` stands in as a
 * documented name and the live id is verified against the vendor's catalogue
 * at O02 deployment.
 *
 * THE PROVIDER ANSWER SHAPE IS THE FAKE'S CONTRACT, not a pinned vendor one:
 * `{events, truncated, nextToken}` where the fake filters half-open on
 * `[timeMin, timeMax)` and pages by its own token — defined from what the §4
 * DTO needs, and O02's live check verifies the real dial answers the same.
 */
export type CalendarWireDial = (
  path: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

/**
 * Placeholder action id (see the module header): `gcalendar.list` for the
 * windowed events read. O02 verifies it against the vendor's
 * `listServiceActions("gcalendar")` catalogue; overridable without a code
 * change, so a catalogue mismatch is a deployment variable, not a re-release.
 */
export const GCAL_LIST_ACTION_ID =
  process.env.OPENCONNECTOR_GCAL_LIST_ACTION_ID ?? "gcalendar.list";

/*
 * Boot-time O02 reminder (round 6 M13, openmuse-mail/client.ts's own
 * baseline): the id above is a placeholder this repository pins by name
 * alone, so the signal fires once at module load — an operator checking
 * listServiceActions("gcalendar") has the exact string to verify against,
 * and a skipped O02 check leaves a trace rather than nothing (calendar
 * reads 502 with only a generic vendor sentence otherwise).
 */
log.info(
  { type: "openmuse-calendar-placeholder-action-id", id: GCAL_LIST_ACTION_ID },
  "openmuse-calendar-placeholder-action-id",
);

/** One event as the vendor's action answers it — mapped to the §4 DTO in calendar.ts. */
export type GCalendarProviderEvent = Record<string, unknown>;

/** One action answer, envelope unwrapped: the events, whether the vendor held some back, and its own resume token (a non-null `nextToken` means more provider pages are held back; the request passes it back as `pageToken` to continue the walk). */
export type GCalendarProviderAnswer = {
  events: GCalendarProviderEvent[];
  truncated: boolean;
  nextToken: string | null;
};

/**
 * One generic action call's RAW wire answer (R05): ok, status and body,
 * nothing unwrapped and nothing thrown — failed-versus-outcome_unknown is
 * the reviewed-action executor's judgment (R02's classification), not this
 * layer's.
 */
export type CalendarActionAnswer = {
  ok: boolean;
  status: number | null;
  body: unknown;
};

export type OpenMuseCalendarClient = {
  /**
   * The windowed events read in the owner's connection. The window is
   * forwarded verbatim — the provider owns half-open filtering, as the
   * fake's recorded contract holds and O02 verifies.
   */
  list(
    alias: string,
    input: { timeMin: string; timeMax: string; pageToken?: string },
  ): Promise<GCalendarProviderAnswer>;
  /**
   * One action call in the owner's connection over the SAME transport (R05,
   * the create dial): `POST /v1/actions/<actionId>` with `{ input }` and the
   * alias header — the seam `list` already rides, opened up for the
   * reviewed-actions executor so the dial is never duplicated beside it.
   */
  callAction(
    alias: string,
    actionId: string,
    input: unknown,
  ): Promise<CalendarActionAnswer>;
};

/** A vendor failure, named so routes can answer 502 rather than 500. */
export class OpenMuseCalendarVendorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMuseCalendarVendorError";
  }
}

function providerAnswerOf(body: unknown): GCalendarProviderAnswer {
  const record =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  if (!Array.isArray(record?.events)) {
    throw new OpenMuseCalendarVendorError(
      "The Calendar answer came back in a shape this deployment could not read.",
    );
  }
  return {
    events: record.events,
    truncated: record.truncated === true,
    nextToken:
      typeof record.nextToken === "string" && record.nextToken !== ""
        ? record.nextToken
        : null,
  };
}

export function buildOpenMuseCalendarClient(deps: {
  dial: CalendarWireDial;
}): OpenMuseCalendarClient {
  const vendorFailure = (
    status: number | null,
    body: unknown,
  ): OpenMuseCalendarVendorError => {
    const record =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : null;
    const vendorMessage =
      typeof record?.message === "string" && record.message !== ""
        ? record.message
        : null;
    log.warn(
      { type: "openmuse-calendar-vendor-failed", status },
      "openmuse-calendar-vendor-failed",
    );
    return new OpenMuseCalendarVendorError(
      vendorMessage ??
        `The Calendar service answered this deployment's request with a failure (${status ?? "an unreadable status"}).`,
    );
  };

  /*
   * THE RUNTIME FACE ANSWERS `{ data: ... }` — the same envelope the adapter's
   * `answerOf` unwraps; unwrapped here once so the mapping layer never sees it.
   */
  const unwrapEnvelope = (body: unknown): unknown =>
    body !== null && typeof body === "object" && "data" in body
      ? (body as Record<string, unknown>).data
      : body;

  return {
    async list(alias, input) {
      let wire: Awaited<ReturnType<CalendarWireDial>>;
      try {
        wire = await deps.dial(
          `/v1/actions/${encodeURIComponent(GCAL_LIST_ACTION_ID)}`,
          {
            method: "POST",
            headers: { "x-oo-connector-alias": alias },
            body: { input },
          },
        );
      } catch (error) {
        // M28's calendar half, the same classification mail's dialAction
        // gained: a transport failure is a NAMED vendor failure (502, logged)
        // — not the generic 503 of an unconfigured connector.
        log.warn(
          {
            type: "openmuse-calendar-vendor-failed",
            status: null,
            transport: true,
            error: error instanceof Error ? error.message : String(error),
          },
          "openmuse-calendar-vendor-failed",
        );
        throw new OpenMuseCalendarVendorError(
          `The Calendar service could not be reached (${
            error instanceof Error
              ? error.message
              : "an unknown transport failure"
          }).`,
        );
      }
      let body: unknown;
      try {
        body = await wire.json();
      } catch {
        throw new OpenMuseCalendarVendorError(
          "The Calendar service answered with something this deployment could not read as JSON.",
        );
      }
      if (!wire.ok) throw vendorFailure(wire.status ?? null, body);
      return providerAnswerOf(unwrapEnvelope(body));
    },

    async callAction(alias, actionId, input) {
      let wire: Awaited<ReturnType<CalendarWireDial>>;
      try {
        wire = await deps.dial(`/v1/actions/${encodeURIComponent(actionId)}`, {
          method: "POST",
          headers: { "x-oo-connector-alias": alias },
          body: { input },
        });
      } catch (error) {
        // M28: named and logged like list()'s. callAction answers the
        // reviewed-action executors, whose own judgment (R02) treats an
        // answered failure by status — an unreachable vendor reads ok:false
        // with no status here, a definite pre-flight failure.
        log.warn(
          {
            type: "openmuse-calendar-vendor-failed",
            status: null,
            transport: true,
            error: error instanceof Error ? error.message : String(error),
          },
          "openmuse-calendar-vendor-failed",
        );
        return { ok: false, status: null, body: null };
      }
      let body: unknown;
      try {
        body = await wire.json();
      } catch {
        body = null;
      }
      return { ok: wire.ok, status: wire.status ?? null, body };
    },
  };
}

/**
 * The transport layer reuses mail's own dial (exported since R02 so the
 * reviewed-action executor would not build a second one): the URL
 * validation, the scheme whitelist, the user-info refusal, `redirect:
 * "manual"` and the 30s per-dial timeout are ONE construction path shared
 * by every OpenConnector caller, so a transport rule cannot drift between
 * copies. `CalendarWireDial` and `MailWireDial` are the same shape.
 */
export function createOpenMuseCalendarClient(config: {
  url: string;
}): OpenMuseCalendarClient {
  const dial: CalendarWireDial = createOpenMuseMailDial(config);
  return buildOpenMuseCalendarClient({ dial });
}
