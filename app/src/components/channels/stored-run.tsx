import { Banner } from "@astryxdesign/core/Banner";
import { Button as RecoveryButton } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useMutation } from "@tanstack/react-query";
import {
  controlThreadRun,
  readThreadMessages,
  type StoredRun,
} from "@/lib/copilot/thread-messages";
import { runOutcomeWords } from "./run-stage";

/** What a person reads when the server would not stop a run they asked to stop. */
export const STOP_REFUSED = "The Bot couldn't be stopped. Try again.";

/** What a Stop came to. */
export type StopOutcome = "stopped" | "ended" | "refused";

/**
 * Stop the run the person is watching, on the server: read the thread, then stop the run the read
 * names. `/bot` and a conversation with one Bot both stop through here.
 *
 * THE READ COMES FIRST, because a list kept from an earlier read decides nothing. `/bot` read its
 * thread when it opened and, on Stop, posted the id of whichever run that read had found going: a
 * run that had ended since was "stopped" while the one actually going went on working, and a tab
 * whose opening read had named no run posted nothing at all and aborted only its own copy.
 *
 * Only the server's own word is a `stopped`. A run that was already over is `ended`, and nothing was
 * stopped: the caller must not say it was. A thread that could not be read, or a stop the server
 * failed, is `refused`.
 */
export async function stopStoredRun(
  threadId: string,
  agentId: string,
): Promise<StopOutcome> {
  const thread = await readThreadMessages(threadId, agentId);
  // A read the server refused names no run this person can reach. One that failed is not proof there is none.
  if (thread.availability !== "ready")
    return thread.accessDenied ? "ended" : "refused";
  const running = thread.runs?.find((run) => run.status === "running");
  if (!running) return "ended";
  try {
    const { stopped } = await controlThreadRun({
      threadId,
      agentId,
      runId: running.id,
      action: "stop",
    });
    return stopped ? "stopped" : "ended";
  } catch {
    return "refused";
  }
}

/**
 * What the thread's stored runs say, wherever a conversation explains a run it is not streaming
 * itself: `/bot` and a conversation with one Bot, from the same words.
 *
 * The run explained is the one whose outcome nobody can vouch for, wherever it sits in the thread;
 * else the one waiting on the person; else the newest, when it ended short of its answer. On a
 * deployment with a managed model, a run the person stopped can leave such an outcome, and the next
 * send is refused until somebody checks it: so "Check outcome" is offered wherever that sentence is,
 * and asks the server here.
 */
export function StoredRunNotice({
  threadId,
  agentId,
  runs,
  canCheck = true,
  failure,
  onChecked,
}: {
  threadId: string;
  agentId: string;
  /** The thread's stored runs, as its last read named them. */
  runs: StoredRun[] | undefined;
  /** Whether this person can ask the server about an outcome here: only a Bot that still exists can check. */
  canCheck?: boolean;
  /** Why a Stop of this thread's run could not be made, when one could not. */
  failure?: string | null;
  /** The server has answered a Check outcome, or refused it, so the thread is read again. */
  onChecked: (refused: boolean) => void;
}) {
  const unresolved = runs?.find((run) => run.externalOutcome === "unknown");
  const active = runs?.find((run) => run.status === "running");
  const explained =
    unresolved ??
    (active?.waitingForApproval ? active : undefined) ??
    runs?.at(-1);
  const words = explained ? runOutcomeWords(explained) : null;
  const check = useMutation({
    mutationFn: (runId: string) =>
      controlThreadRun({ threadId, agentId, runId, action: "reconcile" }),
    onSettled: (_answer, error) => onChecked(error !== null),
  });
  const error = check.error?.message ?? failure ?? null;
  if (!words && !error) return null;
  return (
    <>
      {words ? (
        <HStack wrap="wrap" align="center" gap={2} paddingBlockEnd={2}>
          <Text as="p" role="status" type="supporting">
            {words}
          </Text>
          {unresolved && canCheck ? (
            <RecoveryButton
              isDisabled={check.isPending}
              label={check.isPending ? "Checking…" : "Check outcome"}
              onClick={() => check.mutate(unresolved.id)}
              size="sm"
              variant="secondary"
            />
          ) : null}
        </HStack>
      ) : null}
      {error ? (
        <Banner collapsible={false} role="alert" status="error" title={error} />
      ) : null}
    </>
  );
}
