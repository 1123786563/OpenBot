/**
 * The stages a Bot run can be in, named one way wherever a conversation is drawn.
 *
 * `/bot`, a conversation with one Bot and a conversation with several each worded the same stored
 * run their own way: the first said "The run is waiting for approval." and "The run was stopped.",
 * the last "Waiting for your approval." and "Run ended", and a Bot waiting its turn in a group was
 * "Waiting to reply" where a conversation said "Queued". The same fields feed both
 * (`StoredRun` in `lib/copilot/thread-messages.ts`, `GroupBackgroundRun` in `lib/groups.ts`), so the
 * words live here and each surface draws them.
 */

/** The name of each stage, as a person reads it under a Bot's line. */
export const RUN_STAGE = {
  queued: "Queued",
  running: "Thinking",
  waitingForApproval: "Waiting for your approval",
  /** A run of its own in a group conversation that ended well, and one that did not. */
  completed: "Run completed",
  ended: "Run ended",
} as const;

/** What is said where the answer would have been, when the person stopped the run. */
export const RUN_WAS_STOPPED = "The run was stopped.";

/** What the history store knows about how a run ended. */
export type RunOutcome = {
  status: "running" | "completed" | "failed";
  waitingForApproval?: boolean;
  externalOutcome?:
    | "dispatching"
    | "unknown"
    | "executed"
    | "not_dispatched"
    | null;
  stopReason?: "stopped" | "access_revoked" | "context_revoked" | null;
};

/**
 * What became of a run that is waiting on the person or ended short of its answer, in one sentence.
 *
 * Null for a run that ended as it should: its reply is on screen, and a sentence about it would say
 * nothing. The server writes every run it stopped or lost as `failed`, so that is where each short
 * ending is read; a completed run that dispatched an action has nothing to explain. An outcome nobody
 * can vouch for is said first, whatever else is true of the run, because repeating an action that
 * may already have happened is the one mistake here.
 */
export function runOutcomeWords(run: RunOutcome): string | null {
  if (run.waitingForApproval) return `${RUN_STAGE.waitingForApproval}.`;
  if (run.externalOutcome === "unknown")
    return "The previous run’s external outcome is unknown. Check the outcome before sending again.";
  if (run.status !== "failed") return null;
  if (run.stopReason === "context_revoked")
    return "The run paused because Memory or Learned skill access changed.";
  if (run.externalOutcome === "not_dispatched")
    return "The action was not dispatched. Send your request again to retry.";
  if (run.externalOutcome === "executed")
    return "The outcome was verified and added to the conversation.";
  if (run.stopReason === "stopped") return RUN_WAS_STOPPED;
  if (run.stopReason === "access_revoked")
    return "The run ended when access was revoked.";
  return null;
}
