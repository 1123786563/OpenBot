import { describe, expect, test } from "bun:test";
import {
  RUN_STAGE,
  RUN_WAS_STOPPED,
  runOutcomeWords,
} from "@/components/channels/run-stage";

/*
 * One vocabulary for the stages a Bot run can be in. `/bot`, a conversation with one Bot and a
 * conversation with several used to name the same stored run three ways ("The run is waiting for
 * approval.", "Waiting for your approval.", "Waiting for your response."), so the same silence read
 * differently depending on which screen the person was on. The words come from here, and every
 * surface draws them.
 */

describe("the stage words", () => {
  test("a run still going, one queued and one waiting on the person", () => {
    expect(RUN_STAGE).toEqual({
      queued: "Queued",
      running: "Thinking",
      waitingForApproval: "Waiting for your approval",
      completed: "Run completed",
      ended: "Run ended",
    });
    expect(RUN_WAS_STOPPED).toBe("The run was stopped.");
  });
});

describe("what became of a stored run, in one sentence", () => {
  const base = { status: "completed" } as const;

  test("a run waiting on the person's approval says so", () => {
    expect(
      runOutcomeWords({
        status: "running",
        waitingForApproval: true,
      }),
    ).toBe("Waiting for your approval.");
  });

  test("an ordinary run has nothing to add to what is on screen", () => {
    expect(runOutcomeWords({ status: "running" })).toBeNull();
    expect(runOutcomeWords(base)).toBeNull();
    expect(runOutcomeWords({ status: "failed" })).toBeNull();
    expect(
      runOutcomeWords({ ...base, externalOutcome: "dispatching" }),
    ).toBeNull();
  });

  test("each way a run ended short of its answer is explained, with what to do", () => {
    const failed = { status: "failed" } as const;
    expect(runOutcomeWords({ ...failed, stopReason: "stopped" })).toBe(
      RUN_WAS_STOPPED,
    );
    expect(runOutcomeWords({ ...failed, stopReason: "access_revoked" })).toBe(
      "The run ended when access was revoked.",
    );
    expect(runOutcomeWords({ ...failed, stopReason: "context_revoked" })).toBe(
      "The run paused because Memory or Learned skill access changed.",
    );
    expect(
      runOutcomeWords({ ...failed, externalOutcome: "not_dispatched" }),
    ).toBe("The action was not dispatched. Send your request again to retry.");
    expect(runOutcomeWords({ ...failed, externalOutcome: "executed" })).toBe(
      "The outcome was verified and added to the conversation.",
    );
    expect(runOutcomeWords({ ...failed, externalOutcome: "unknown" })).toBe(
      "The previous run’s external outcome is unknown. Check the outcome before sending again.",
    );
  });

  test("a run that completed says nothing, whatever it dispatched", () => {
    expect(
      runOutcomeWords({ ...base, externalOutcome: "executed" }),
    ).toBeNull();
    expect(runOutcomeWords({ ...base, stopReason: "stopped" })).toBeNull();
  });

  test("an outcome nobody can vouch for is said over every other ending", () => {
    expect(
      runOutcomeWords({
        status: "failed",
        externalOutcome: "unknown",
        stopReason: "stopped",
      }),
    ).toBe(
      "The previous run’s external outcome is unknown. Check the outcome before sending again.",
    );
  });
});
