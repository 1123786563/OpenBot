import { z } from "zod";

export const onlineCleanupSteps = [
  "postgres",
  "computerVolume",
  "exports",
  "caches",
  "indexes",
  "internalServices",
] as const;

export const cleanupSteps = [...onlineCleanupSteps, "connections"] as const;
export type CleanupStep = (typeof cleanupSteps)[number];
export type CleanupResult = {
  status: "confirmed" | "retrying" | "unconfirmed";
  checkedAt: string;
};

export const intelligenceLocator = z.strictObject({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  agentId: z.string().min(1),
});

export const closureTombstone = z.strictObject({
  id: z.uuid(),
  accountId: z.uuid(),
  workspaceId: z.uuid(),
  acceptedAt: z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
});

export const closureRestoreJournal = z
  .strictObject({
    version: z.literal(2),
    operations: z.array(
      closureTombstone.extend({ intelligence: z.array(intelligenceLocator) }),
    ),
  })
  .transform(({ operations }) => operations);

export const backupSchedule = z
  .array(
    z.strictObject({
      store: z.string().trim().min(1).max(100),
      retentionDays: z.number().int().positive(),
      remainingCopiesExpireBy: z.iso.datetime({ offset: true }),
    }),
  )
  .min(1)
  .refine(
    (stores) =>
      new Set(stores.map(({ store }) => store)).size === stores.length,
  );

const result = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("confirmed"),
    schedule: backupSchedule.optional(),
  }),
  z.object({ status: z.literal("unconfirmed") }),
]);

export type ClosureCleanup = (
  step: Exclude<CleanupStep, "postgres"> | "backups",
  target: z.output<typeof closureTombstone> & {
    intelligence?: z.output<typeof intelligenceLocator>[];
  },
) => Promise<z.output<typeof result>>;

export function closureCleanupClient(
  endpoint: string,
  token: string,
): ClosureCleanup {
  return async (step, target) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ step, ...target }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error("Closure cleanup service unavailable");
    return result.parse(await response.json());
  };
}
