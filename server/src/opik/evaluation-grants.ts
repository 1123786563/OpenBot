import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  opikEvaluationGrants,
  opikEvaluations,
  personalMemories,
} from "../db/schema";
import { type OpikConfig, opikWriter } from "./client";
import {
  type EvaluationTransaction,
  lockPlatformBudget,
  normalizeEvaluationText,
  withinBudget,
} from "./evaluation";

const MAX_SAMPLE_LENGTH = 8192;
export const scopeInput = z.strictObject({
  memoryId: z.string().min(1).max(200),
  contentSha256: z.hash("sha256").transform((digest) => digest.toLowerCase()),
  purpose: z.literal("normalization-fidelity"),
});
export const realRunInput = scopeInput.extend({
  grantId: z.uuid().transform((id) => id.toLowerCase()),
});
type Scope = z.infer<typeof scopeInput>;
type Run = z.infer<typeof realRunInput>;

async function lockEligibleMemory(
  tx: EvaluationTransaction,
  ownerId: string,
  scope: Scope,
) {
  const [sample] = await tx
    .select({ content: personalMemories.content })
    .from(personalMemories)
    .where(
      and(
        eq(personalMemories.id, scope.memoryId),
        eq(personalMemories.ownerUserId, ownerId),
        eq(personalMemories.enabled, true),
        eq(personalMemories.formedBy, "person"),
        isNull(personalMemories.deletedAt),
        isNull(personalMemories.sourceId),
        isNull(personalMemories.sourceRef),
        isNull(personalMemories.sourceApp),
        sql`${personalMemories.reviewState} in ('confirmed', 'edited')`,
      ),
    )
    .for("share");
  if (!sample || sample.content.length > MAX_SAMPLE_LENGTH) return undefined;
  const digest = new Bun.CryptoHasher("sha256")
    .update(sample.content)
    .digest("hex");
  return digest === scope.contentSha256 ? sample : undefined;
}

export function grantEvaluation(
  database: Database,
  ownerId: string,
  scope: Scope,
) {
  return database.transaction(async (tx) => {
    if (!(await lockEligibleMemory(tx, ownerId, scope))) return undefined;
    const [grant] = await tx
      .insert(opikEvaluationGrants)
      .values({ id: Bun.randomUUIDv7(), ownerId, ...scope })
      .returning({
        id: opikEvaluationGrants.id,
        grantedAt: opikEvaluationGrants.grantedAt,
      });
    return grant;
  });
}

export async function revokeEvaluation(
  database: Database,
  ownerId: string,
  grantId: string,
) {
  const [grant] = await database
    .update(opikEvaluationGrants)
    .set({ revokedAt: sql`coalesce(${opikEvaluationGrants.revokedAt}, now())` })
    .where(
      and(
        eq(opikEvaluationGrants.id, grantId),
        eq(opikEvaluationGrants.ownerId, ownerId),
      ),
    )
    .returning({
      id: opikEvaluationGrants.id,
      revokedAt: opikEvaluationGrants.revokedAt,
    });
  return grant;
}

async function lockSample(tx: EvaluationTransaction, run: Run) {
  const scope = and(
    eq(opikEvaluationGrants.id, run.grantId),
    eq(opikEvaluationGrants.memoryId, run.memoryId),
    eq(opikEvaluationGrants.contentSha256, run.contentSha256),
    eq(opikEvaluationGrants.purpose, run.purpose),
    isNull(opikEvaluationGrants.revokedAt),
  );
  const [candidate] = await tx
    .select({ ownerId: opikEvaluationGrants.ownerId })
    .from(opikEvaluationGrants)
    .where(scope);
  if (!candidate) return undefined;
  // Source mutations lock the memory first and revoke grants from the database trigger.
  const sample = await lockEligibleMemory(tx, candidate.ownerId, run);
  if (!sample) return undefined;
  const [grant] = await tx
    .select({ id: opikEvaluationGrants.id })
    .from(opikEvaluationGrants)
    .where(scope)
    .for("update");
  return grant ? sample : undefined;
}

export async function runRealEvaluation({
  database,
  config,
  dailyCaseLimit,
  operatorId,
  run,
}: {
  database: Database;
  config: OpikConfig;
  dailyCaseLimit: number;
  operatorId: string;
  run: Run;
}) {
  const id = Bun.randomUUIDv7();
  const admission = await database.transaction(async (tx) => {
    await lockPlatformBudget(tx);
    if (!(await lockSample(tx, run))) return "unavailable";
    const [existing] = await tx
      .select({ status: opikEvaluations.status, traceId: opikEvaluations.id })
      .from(opikEvaluations)
      .where(
        and(
          eq(opikEvaluations.kind, "real"),
          eq(opikEvaluations.requestId, run.grantId),
        ),
      );
    if (existing) return existing;
    if (!(await withinBudget(tx, 1, dailyCaseLimit))) return "exhausted";
    await tx.insert(opikEvaluations).values({
      id,
      requestId: run.grantId,
      operatorId,
      project: config.project,
      kind: "real",
      cases: 1,
      target: config.apiUrl.href,
      workspace: config.workspace,
    });
    return "reserved";
  });
  if (admission !== "reserved") return admission;

  // Commit the external identifier before sending. Even a timeout or crash leaves enough
  // information for cleanup. Lock the live authorization for the bounded dispatch.
  return database.transaction(async (tx) => {
    const sample = await lockSample(tx, run);
    if (!sample) return "unavailable";
    const send = opikWriter(config, 5000);
    let status: "completed" | "failed" = "failed";
    try {
      const timestamp = new Date().toISOString();
      const output = normalizeEvaluationText(sample.content);
      await send("traces/batch", "POST", {
        traces: [
          {
            id,
            name: "OpenBot authorized normalization evaluation",
            project_name: config.project,
            start_time: timestamp,
            end_time: timestamp,
            input: { text: sample.content },
            metadata: { purpose: run.purpose },
          },
        ],
      });
      await send("traces/feedback-scores", "PUT", {
        scores: [
          {
            id,
            project_name: config.project,
            source: "sdk",
            name: "normalization_fidelity",
            value: Number(output === sample.content),
          },
        ],
      });
      status = "completed";
    } catch {
      console.warn(
        JSON.stringify({
          type: "opik_real_evaluation_failed",
          evaluationId: id,
        }),
      );
    }
    await tx
      .update(opikEvaluations)
      .set({ status })
      .where(eq(opikEvaluations.id, id));
    return { status, traceId: id };
  });
}
