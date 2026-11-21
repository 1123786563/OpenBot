import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { mobileBotRuns } from "./personal-saas";
import { BotRunActionError, type BotRunStatus } from "./personal-saas-bot-runs";
import type { TestCreditQuoteRef } from "./personal-saas-contract";

export function PersonalSaasBotRun({
  workspaceId,
  botId,
  canStart,
  quote,
  initialRunId,
  onAccept,
}: {
  workspaceId: string;
  botId: string;
  canStart: boolean;
  quote?: TestCreditQuoteRef | null;
  initialRunId: string | null;
  onAccept: (runId: string) => void;
}) {
  const runs = mobileBotRuns;
  const [instruction, setInstruction] = useState("");
  const [pending, setPending] = useState<{
    requestId: string;
    quote: TestCreditQuoteRef;
  } | null>(null);
  const [rejectedQuote, setRejectedQuote] = useState<TestCreditQuoteRef | null>(
    null,
  );
  const [runId, setRunId] = useState(initialRunId);
  const [status, setStatus] = useState<BotRunStatus | null>(null);
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
  }, [runId, refresh]);

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
        requestId: randomUUID(),
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
        failure instanceof BotRunActionError
          ? failure.message
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
    <View>
      <Text>Instruction</Text>
      <TextInput
        accessibilityLabel="Instruction"
        editable={pending === null}
        value={instruction}
        onChangeText={setInstruction}
        multiline
        maxLength={20_000}
      />
      <Button
        disabled={
          busy ||
          !instruction.trim() ||
          Boolean(runId && !terminal) ||
          (!availableQuote && !pending)
        }
        onPress={() => void start()}
        title={pending && !busy ? "Retry submission" : "Run with Test Credits"}
      />
      {pending && !busy && (
        <Button
          title="Clear instruction"
          onPress={() => {
            setPending(null);
            setInstruction("");
            setError(null);
          }}
        />
      )}
      {error && <Text accessibilityRole="alert">{error}</Text>}
      {runId && (
        <View>
          <Text accessibilityLiveRegion="polite">
            Run status: {status?.state ?? "queued"}
          </Text>
          {status?.output && <Text selectable>{status.output}</Text>}
          {receipt ? (
            <Text>
              Test Credit receipt for {receipt.model}: {receipt.state}. Held{" "}
              {receipt.heldMicrocredits} microcredits.
              {receipt.chargedMicrocredits !== null &&
                ` Charged ${receipt.chargedMicrocredits} microcredits.`}
              {receipt.releasedMicrocredits !== null &&
                ` Released ${receipt.releasedMicrocredits} microcredits.`}
            </Text>
          ) : terminal ? (
            <Text>No Test Credit receipt is available for this run.</Text>
          ) : null}
          {statusError && (
            <Text accessibilityRole="alert">Could not check run status.</Text>
          )}
          {(!terminal || statusError || !receipt) && (
            <Button
              title="Refresh run status"
              onPress={() => setRefresh((count) => count + 1)}
            />
          )}
          {!terminal && (
            <Button
              title="Stop run"
              disabled={busy}
              onPress={() => void stop()}
            />
          )}
        </View>
      )}
    </View>
  );
}
