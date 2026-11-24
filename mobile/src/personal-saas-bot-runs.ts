import { z } from "zod";
import type { TestCreditQuoteRef } from "./personal-saas-contract";

const basePath = "/api/workspace/bot-runs";
const runId = z.string().regex(/^[a-f0-9]{64}$/);
const accepted = z.object({ runId });
const status = z.object({
  state: z.enum(["queued", "running", "waiting", "stopped", "completed"]),
  output: z.string().nullable(),
  testCredit: z
    .object({
      model: z.string(),
      state: z.enum(["reserved", "pending", "settled", "released"]),
      heldMicrocredits: z.string(),
      chargedMicrocredits: z.string().nullable(),
      releasedMicrocredits: z.string().nullable(),
    })
    .optional(),
});

export type BotRunStatus = z.infer<typeof status>;

export class BotRunActionError extends Error {}

export function personalBotRuns(
  request: (
    path: string,
    init: {
      method: "GET" | "POST";
      headers?: Record<string, string>;
      body?: string;
    },
  ) => Promise<Pick<Response, "json" | "status">>,
) {
  return {
    async start({
      workspaceId,
      botId,
      instruction,
      requestId,
      quote,
    }: {
      workspaceId: string;
      botId: string;
      instruction: string;
      requestId: string;
      quote: TestCreditQuoteRef;
    }) {
      const reply = await request(basePath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({
          workspaceId,
          botId,
          instruction,
          execution: "test-credit",
          quote,
        }),
      });
      if (reply.status === 409) {
        const conflict = z.object({
          error: z.literal("test_credit_quote_changed"),
        });
        const changed = conflict.safeParse(
          await reply.json().catch(() => null),
        );
        if (changed.success) return changed.data;
      }
      if (reply.status === 402)
        throw new BotRunActionError(
          "There are not enough Test Credits for this run.",
        );
      if (reply.status === 429)
        throw new BotRunActionError(
          "Your workspace has reached its Bot run limit.",
        );
      if (reply.status !== 202)
        throw new BotRunActionError(
          "Could not submit the run. Retry this request.",
        );
      return accepted.parse(await reply.json());
    },
    async status(id: string) {
      const reply = await request(`${basePath}/${runId.parse(id)}`, {
        method: "GET",
      });
      if (reply.status !== 200)
        throw new BotRunActionError("Could not check run status.");
      return status.parse(await reply.json());
    },
    async stop(id: string) {
      const reply = await request(`${basePath}/${runId.parse(id)}/stop`, {
        method: "POST",
      });
      if (reply.status !== 202)
        throw new BotRunActionError("Could not stop the run.");
    },
  };
}
