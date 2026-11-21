import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

export type TestCreditQuoteRef = { route: string; priceVersion: string };

type StartRun = {
  workspaceId: string;
  botId: string;
  instruction: string;
  requestId: string;
  quote: TestCreditQuoteRef;
};

type RunStatus = {
  state: "queued" | "running" | "waiting" | "stopped" | "completed";
  output: string | null;
  testCredit?: {
    model: string;
    state: "reserved" | "pending" | "settled" | "released";
    heldMicrocredits: string;
    chargedMicrocredits: string | null;
    releasedMicrocredits: string | null;
  } | null;
};

export const cloudBotRuns = {
  start: (input: StartRun) =>
    invoke<{ runId: string } | { error: "test_credit_quote_changed" }>(
      "personal_cloud_start_bot_run",
      { input },
    ),
  status: (runId: string) =>
    invoke<RunStatus>("personal_cloud_bot_run", { runId, stop: false }),
  stop: (runId: string) =>
    invoke<void>("personal_cloud_bot_run", { runId, stop: true }),
};

export function PersonalCloudBotRun({
  workspaceId,
  botId,
  canStart,
  quote,
  initialRunId,
  onAccept,
  runs,
}: {
  workspaceId: string;
  botId: string;
  canStart: boolean;
  quote?: TestCreditQuoteRef | null;
  initialRunId: string | null;
  onAccept: (runId: string) => void;
  runs: typeof cloudBotRuns;
}) {
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<{
    requestId: string;
    quote: TestCreditQuoteRef;
  } | null>(null);
  const [rejectedQuote, setRejectedQuote] = useState<TestCreditQuoteRef | null>(
    null,
  );
  const [runId, setRunId] = useState(initialRunId);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const availableQuote =
    canStart &&
    quote &&
    (quote.route !== rejectedQuote?.route ||
      quote.priceVersion !== rejectedQuote?.priceVersion)
      ? quote
      : null;
  const terminal = status?.state === "completed" || status?.state === "stopped";

  // biome-ignore lint/correctness/useExhaustiveDependencies: A manual refresh or stop restarts the poll immediately.
  useEffect(() => {
    if (!runId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read(id: string) {
      try {
        const next = await runs.status(id);
        if (!active) return;
        setStatus(next);
        setStatusError(false);
        const finished = next.state === "completed" || next.state === "stopped";
        const settling =
          next.testCredit?.state === "reserved" ||
          next.testCredit?.state === "pending";
        if (!finished || settling)
          timer = setTimeout(() => void read(id), 2000);
      } catch {
        if (active) setStatusError(true);
      }
    }
    void read(runId);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [runId, runs, refresh]);

  async function start() {
    const frozenQuote = pending?.quote ?? availableQuote;
    if (
      working.current ||
      !instruction.trim() ||
      (runId && !terminal) ||
      !frozenQuote
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const submission = pending ?? {
        requestId: crypto.randomUUID(),
        quote: {
          route: frozenQuote.route,
          priceVersion: frozenQuote.priceVersion,
        },
      };
      setPending(submission);
      const accepted = await runs.start({
        workspaceId,
        botId,
        instruction: instruction.trim(),
        ...submission,
      });
      if ("error" in accepted) {
        setPending(null);
        setRejectedQuote(submission.quote);
        setError(
          "Test Credit pricing changed. Review the updated quote before submitting again.",
        );
        return;
      }
      onAccept(accepted.runId);
      setRunId(accepted.runId);
      setStatus(null);
      setStatusError(false);
      setInstruction("");
      setPending(null);
    } catch (failure) {
      setError(
        typeof failure === "string"
          ? failure
          : "Could not submit the run. Retry this request.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function stop() {
    if (!runId || terminal || working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await runs.stop(runId);
      setRefresh((count) => count + 1);
    } catch {
      setError("Could not stop the run. Check its status and try again.");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const receipt = status?.testCredit;
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <p>
          <label htmlFor="managed-instruction">Instruction</label>
        </p>
        <textarea
          id="managed-instruction"
          rows={3}
          value={instruction}
          maxLength={20_000}
          readOnly={pending !== null}
          onChange={(event) => setInstruction(event.currentTarget.value)}
        />
        <p>
          <button
            type="submit"
            disabled={
              busy ||
              !instruction.trim() ||
              Boolean(runId && !terminal) ||
              (!availableQuote && !pending)
            }
          >
            {pending && !busy ? "Retry submission" : "Run with Test Credits"}
          </button>
          {pending && !busy && (
            <button
              type="button"
              onClick={() => {
                setPending(null);
                setInstruction("");
                setError(null);
              }}
            >
              Clear instruction
            </button>
          )}
        </p>
      </form>
      {error && <p role="alert">{error}</p>}
      {runId && (
        <section aria-label="Bot run">
          <p role="status">Run status: {status?.state ?? "queued"}</p>
          {status?.output && <pre>{status.output}</pre>}
          {receipt ? (
            <p>
              Test Credit receipt for {receipt.model}: {receipt.state}. Held{" "}
              {receipt.heldMicrocredits} microcredits.
              {receipt.chargedMicrocredits !== null &&
                ` Charged ${receipt.chargedMicrocredits} microcredits.`}
              {receipt.releasedMicrocredits !== null &&
                ` Released ${receipt.releasedMicrocredits} microcredits.`}
            </p>
          ) : terminal ? (
            <p>No Test Credit receipt is available for this run.</p>
          ) : null}
          {statusError && <p role="alert">Could not check run status.</p>}
          {(!terminal || statusError || !receipt) && (
            <button
              type="button"
              onClick={() => setRefresh((count) => count + 1)}
            >
              Refresh run status
            </button>
          )}
          {!terminal && (
            <button type="button" disabled={busy} onClick={() => void stop()}>
              Stop run
            </button>
          )}
        </section>
      )}
    </>
  );
}
