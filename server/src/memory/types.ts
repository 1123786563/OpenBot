import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
/** The one review-state vocabulary, shared by the patch schema and the record type. */
export const MEMORY_REVIEW_STATES = [
  "unreviewed",
  "confirmed",
  "edited",
] as const;
export type MemoryReviewState = (typeof MEMORY_REVIEW_STATES)[number];
export const memoryInputSchema = z
  .object({
    content: text(6000),
    provenance: text(500).default("You"),
    enabled: z.boolean().default(true),
  })
  .strict();
/**
 * A change to a memory, spelled out rather than `memoryInputSchema.partial()`.
 *
 * `.partial()` keeps each field's `.default()`, so every patch parsed as `provenance: "You",
 * enabled: true`: confirming an imported memory rewrote where it came from to "You", and any edit
 * switched a disabled memory back on. Provenance is not here at all. Where a memory came from is
 * recorded when it is made and is not something an edit gets to change.
 */
export const memoryPatchSchema = z
  .object({
    content: text(6000).optional(),
    enabled: z.boolean().optional(),
    reviewState: z.enum(MEMORY_REVIEW_STATES).optional(),
  })
  .strict();
export const memorySourceInputSchema = z
  .object({
    agentId: text(128),
    toolRef: text(256),
    title: text(160),
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine(
    (input) => {
      // An unserializable args object (circular, BigInt) is invalid input, not a crash.
      try {
        return JSON.stringify(input.args).length <= 8192;
      } catch {
        return false;
      }
    },
    "Source settings are too large.",
  );
export class MemoryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryRefusedError";
  }
}
/**
 * Said to the Bot whose observation arrived while the person paused learning (#392): the
 * switch is the person's own, so the answer says what happened and how it changes back.
 */
export const LEARNING_PAUSED_REFUSAL =
  "Learning is paused for this person. They can turn it back on in their memory settings.";
/**
 * FIX-OCR3 (O3-H2): an enterprise deployment's answer to a Bot observation whose company
 * cannot be proven right now. The proactive seam has no company of its own to carry, and the
 * one honest alternative to this refusal was a tenant-less row invisible to every
 * company-pinned face — unwritable is the fix, not unreadable.
 */
export const MEMORY_ATTRIBUTION_REFUSAL =
  "This memory cannot be attributed to a company right now, so it was not kept.";
/**
 * The person's own pause-switches patch (#392): booleans only. Strict, so a tenant, principal
 * or bank id supplied from the wire is refused as a bad request — identity never travels in a
 * body; the route derives it from the server-issued scope.
 */
export const pauseControlPatchSchema = z
  .object({
    learningPaused: z.boolean().optional(),
    usagePaused: z.boolean().optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.learningPaused !== undefined || patch.usagePaused !== undefined,
    "Choose which switch to change.",
  );
export const parsePauseControlPatch = (input: unknown) =>
  parse(pauseControlPatchSchema, input);
export class MemoryNotFoundError extends Error {
  constructor() {
    super("This memory could not be found.");
    this.name = "MemoryNotFoundError";
  }
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new MemoryRefusedError(
      result.error.issues[0]?.message ?? "Invalid memory.",
    );
  return result.data;
}
export const parseMemoryInput = (input: unknown) =>
  parse(memoryInputSchema, input);
export const parseMemoryPatch = (input: unknown) => {
  const value = parse(memoryPatchSchema, input);
  if (!Object.keys(value).length)
    throw new MemoryRefusedError("Supply a change to this memory.");
  return value;
};
export const parseMemorySourceInput = (input: unknown) =>
  parse(memorySourceInputSchema, input);
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type MemorySourceInput = z.infer<typeof memorySourceInputSchema>;
export type MemoryRecord = MemoryInput & {
  id: string;
  ownerUserId: string;
  sourceId: string | null;
  externalId: string | null;
  importDigest: string | null;
  reviewState: MemoryReviewState;
  /** Who formed it: the person, a source import, or a Bot that observed it. */
  formedBy: "person" | "import" | "bot";
  formedByAgentId: string | null;
  sourceApp: string | null;
  sourceRef: string | null;
  sourceLink: string | null;
  observedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type MemorySource = MemorySourceInput & {
  id: string;
  ownerUserId: string;
  /**
   * FIX-W13 (#376, FR2-2): the company this source belongs to, fixed at binding — the
   * (person, Bot)'s own proven company, never a request's selection. NULL is an ISOLATED
   * source: no company's to list, operate or sync in an enterprise deployment, and the
   * single-user deployment's ordinary standing.
   */
  tenantId: string | null;
  enabled: boolean;
  syncStatus: "idle" | "running" | "succeeded" | "error";
  syncError: string | null;
  lastSyncAt: Date | null;
  nextSyncAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
/** What a Bot says it observed. Provenance is checked by the caller before this reaches the store. */
export const formedMemorySchema = z
  .object({
    content: text(2000),
    sourceApp: text(160),
    sourceLink: z
      .string()
      .trim()
      .max(1000)
      .refine(
        (value) => /^https?:\/\//i.test(value) && URL.canParse(value),
        "Links must be http or https URLs.",
      )
      .optional(),
    observedAt: z.coerce.date().optional(),
  })
  .strict();
export type FormedMemoryInput = z.infer<typeof formedMemorySchema> & {
  agentId: string;
  sourceRef?: string | null;
};
export type ImportedMemory = {
  externalId: string;
  content: string;
  provenance: string;
  digest: string;
};
