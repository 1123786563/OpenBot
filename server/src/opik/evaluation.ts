import { and, eq, sql, sum } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { opikEvaluations } from "../db/schema";
import { type OpikConfig, opikFetch, opikWriter } from "./client";

export type OpikEvaluationConfig = {
  synthetic: OpikConfig;
  operators: ReadonlySet<string>;
  dailyCaseLimit: number;
  real?: OpikConfig;
};

const scoreName = "exact_match";
export const normalizeEvaluationText = (value: string) =>
  value.trim().replace(/\s+/g, " ");
export const syntheticCases = [
  { input: "  amber   robot ", expected: "amber robot" },
  { input: " blue robot ", expected: "green robot" },
].map(({ input, expected }) => {
  const output = normalizeEvaluationText(input);
  return { input, expected, output, score: Number(output === expected) };
});

const experimentResult = z.object({
  name: z.string(),
  feedback_scores: z.array(
    z.object({ name: z.string(), value: z.number().min(0).max(1) }),
  ),
});

export async function readSyntheticScore(config: OpikConfig, id: string) {
  try {
    const response = await opikFetch(config, 3000)(`experiments/${id}`, "GET");
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const parsed = experimentResult.safeParse(await response.json());
    if (parsed.success && parsed.data.name === `openbot-synthetic-${id}`)
      return parsed.data.feedback_scores.find(
        (score) => score.name === scoreName,
      )?.value;
  } catch {
    // Ingestion is asynchronous and Opik can be temporarily unavailable.
  }
  return undefined;
}

async function publishSynthetic(config: OpikConfig, id: string) {
  const send = opikWriter(config);
  const name = `openbot-synthetic-${id}`;
  const items = syntheticCases.map((sample) => ({
    ...sample,
    id: Bun.randomUUIDv7(),
  }));
  await send("datasets/items", "PUT", {
    dataset_name: name,
    project_name: config.project,
    items: items.map(({ id, input, expected }) => ({
      id,
      data: { input, expected },
      source: "manual",
    })),
  });
  await send("experiments/items/bulk", "PUT", {
    dataset_name: name,
    experiment_name: name,
    experiment_id: id,
    project_name: config.project,
    items: items.map(({ id, output, score }) => ({
      dataset_item_id: id,
      evaluate_task_result: { output },
      feedback_scores: [{ name: scoreName, value: score, source: "sdk" }],
    })),
  });
}

export type EvaluationTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

export async function withinBudget(
  tx: EvaluationTransaction,
  cases: number,
  dailyCaseLimit: number,
) {
  const [usage] = await tx
    .select({ cases: sum(opikEvaluations.cases) })
    .from(opikEvaluations)
    .where(
      sql`${opikEvaluations.createdAt} >= date_trunc('day', now(), 'UTC')`,
    );
  return Number(usage?.cases ?? 0) + cases <= dailyCaseLimit;
}

export const lockPlatformBudget = (tx: EvaluationTransaction) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('openbot.opik-evaluation-budget'))`,
  );

export async function runSynthetic(
  database: Database,
  config: OpikEvaluationConfig,
  operatorId: string,
  requestId: string,
) {
  const reservation = await database.transaction(async (tx) => {
    await lockPlatformBudget(tx);
    const [existing] = await tx
      .select()
      .from(opikEvaluations)
      .where(
        and(
          eq(opikEvaluations.kind, "synthetic"),
          eq(opikEvaluations.requestId, requestId),
        ),
      );
    if (existing)
      return existing.operatorId === operatorId
        ? { kind: "existing" as const, evaluation: existing }
        : { kind: "conflict" as const };
    if (!(await withinBudget(tx, syntheticCases.length, config.dailyCaseLimit)))
      return { kind: "exhausted" as const };
    const [evaluation] = await tx
      .insert(opikEvaluations)
      .values({
        id: Bun.randomUUIDv7(),
        requestId,
        operatorId,
        project: config.synthetic.project,
        cases: syntheticCases.length,
      })
      .returning();
    if (!evaluation) throw new Error("Evaluation reservation failed");
    return { kind: "reserved" as const, evaluation };
  });
  if (reservation.kind !== "reserved") return reservation;

  const { evaluation } = reservation;
  let status: "completed" | "failed";
  try {
    await publishSynthetic(config.synthetic, evaluation.id);
    status = "completed";
  } catch (error) {
    console.warn(
      JSON.stringify({
        type: "opik_synthetic_evaluation_failed",
        evaluationId: evaluation.id,
        error: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    status = "failed";
  }
  await database
    .update(opikEvaluations)
    .set({ status })
    .where(eq(opikEvaluations.id, evaluation.id));
  return { kind: "existing" as const, evaluation: { ...evaluation, status } };
}
