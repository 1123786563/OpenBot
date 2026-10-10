/**
 * Lago metering for code runs, from one source: the `code_runs` row itself.
 *
 * The gateway's onUsage hook hands this the row's dimensions at the settle point; this module
 * turns them into exactly one provider event per run, keyed by the run id — the provider's
 * transaction-id dedup makes a double report a no-op, which is the whole idempotency story.
 *
 * The workshop's `usage` column is a DISPLAY COPY for the browser (F6 renders it); it is never
 * read here and never reported. If `code_runs` and the display ever disagree, `code_runs` wins
 * because it is the only thing this pipeline reads.
 *
 * A deployment without billing (no service) calls nothing and drops nothing: the `code_runs`
 * row is still written by the gateway — metering is a downstream observer, not a participant.
 */
import type { BillingService } from "../billing/types";

export type CodeRunUsageInput = {
  runId: string;
  status: string;
  sessionId: string | null;
  botId: string;
  ownerUserId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
};

/** The provider's metric code for a code run's token usage, one constant so both sides agree. */
export const CODE_RUN_METRIC = "code_run_tokens";

/**
 * Report one run's usage. Never throws (the service's recordUsage already logs and swallows);
 * returns true when a report was attempted, false when there was nothing to report or no
 * billing to report to — both are silent on purpose.
 */
export async function reportCodeRunUsage(
  billing: Pick<BillingService, "recordUsage"> | null | undefined,
  input: CodeRunUsageInput,
): Promise<boolean> {
  if (!billing) return false; // Unconfigured: silent, and the code_runs row already stands.
  if (input.inputTokens <= 0 && input.outputTokens <= 0) return false; // Nothing meterable.
  await billing.recordUsage({
    // The run id IS the idempotency key: the same run reported twice (a retry, a crash-replay)
    // is one event at the provider, because the transaction id deduplicates there.
    transactionId: `code-run:${input.runId}`,
    metricCode: CODE_RUN_METRIC,
    properties: {
      run_id: input.runId,
      bot_id: input.botId,
      owner_user_id: input.ownerUserId,
      session_id: input.sessionId ?? "",
      model: input.modelId,
      status: input.status,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
    },
  });
  return true;
}
