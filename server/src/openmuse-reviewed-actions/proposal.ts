import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The §6 proposal half: what a reviewed action proposes, how that payload is
 * canonically serialized, and the sha256 `payloadHash` a decision is guarded
 * by. No provider behaviour lives here — R02+ own the dials.
 */

/** §6: existing OpenMuse expires proposals after 30 minutes; retained. */
export const REVIEWED_ACTION_TTL_MS = 30 * 60 * 1000;

export const reviewedActionKinds = [
  "mail",
  "calendar",
  "gmail.send",
  "gcalendar.create",
  "gcalendar.update",
  "gcalendar.delete",
] as const;
export type ReviewedActionKind = (typeof reviewedActionKinds)[number];

/**
 * The §6 event content `gcalendar.create` and `gcalendar.update` share:
 * exactly title/start/end/allDay?/timeZone/calendarId/attendees — the
 * calendar, timezone and attendees the proposal shows are the ones the dial
 * carries, and a moved start is a different hash, so a decision made against
 * it is stale. R06's update keeps the target OUT of this shape: the event id
 * and etag bind first-class as targetId/targetVersion.
 */
const gcalEventSchema = z
  .object({
    title: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    allDay: z.boolean().optional(),
    timeZone: z.string().min(1),
    calendarId: z.string().min(1),
    attendees: z.array(z.string().min(1)),
  })
  .strict();

/**
 * The canonical payload by kind (§6): mail recipients/subject/body with its
 * reply binding, or calendar/time-zone fields. Whichever applies, the SAME
 * object is what gets serialized, hashed, stored and shown back. R02's
 * `gmail.send` carried exactly recipients/subject/body; R03 gave it the same
 * optional reply binding `mail` has — hash-stable, since the binding is part
 * of the canonical serialization and absent fields hash as absent. R05's
 * `gcalendar.create` and R06's `gcalendar.update` carry exactly the shared
 * event content above.
 */
export const reviewedActionPayloadSchemas: Record<
  ReviewedActionKind,
  z.ZodType
> = {
  mail: z
    .object({
      to: z.array(z.string().min(1)).min(1),
      subject: z.string().min(1),
      body: z.string(),
      threadId: z.string().min(1).optional(),
      replyToMessageId: z.string().min(1).optional(),
    })
    .strict(),
  "gmail.send": z
    .object({
      to: z.array(z.string().min(1)).min(1),
      subject: z.string().min(1),
      body: z.string(),
      threadId: z.string().min(1).optional(),
      replyToMessageId: z.string().min(1).optional(),
    })
    .strict(),
  "gcalendar.create": gcalEventSchema,
  "gcalendar.update": gcalEventSchema,
  /*
   * R07's delete carries no event content — only the calendar the doomed
   * event lives on. The event itself is bound first-class, exactly as R06
   * bound the update: targetId/targetVersion, never in the payload.
   */
  "gcalendar.delete": z.object({ calendarId: z.string().min(1) }).strict(),
  calendar: z
    .object({
      summary: z.string().min(1),
      start: z.string().min(1),
      end: z.string().min(1),
      timeZone: z.string().min(1),
    })
    .strict(),
};

/**
 * Deterministic serialization: object keys sorted, no whitespace, arrays in
 * order. Two payloads that mean the same thing hash the same; two that differ
 * in any byte do not.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** The §6 payloadHash: sha256 over the canonical serialization. */
export function payloadHashOf(payload: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex");
}

/** The executor-facing view of one stored proposal. */
export type ReviewedActionProposal = {
  id: string;
  ownerUserId: string;
  kind: ReviewedActionKind;
  payload: unknown;
  accountEmail: string;
  connectionGeneration: number;
  /**
   * §6's first-class target bindings, R06's update duty: the provider event
   * id (`targetId`) and the etag the decision was made against
   * (`targetVersion`). Null when the kind binds no target.
   */
  targetId: string | null;
  targetVersion: string | null;
  attachmentVersionIds: string[];
};

/**
 * R03 (§6 changed-target guard): the reply binding a stored payload carries —
 * the thread/message a decision must still be about. Absent fields mean the
 * proposal is a fresh compose; a decision guarding a field the payload lacks
 * is a mismatch, not a pass.
 */
export function replyBindingOf(payload: unknown): {
  threadId?: string;
  replyToMessageId?: string;
} {
  if (payload === null || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.threadId === "string" && record.threadId !== ""
      ? { threadId: record.threadId }
      : {}),
    ...(typeof record.replyToMessageId === "string" &&
    record.replyToMessageId !== ""
      ? { replyToMessageId: record.replyToMessageId }
      : {}),
  };
}
