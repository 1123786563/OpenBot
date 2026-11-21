import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState } from "react";
import { Button, Text, TextInput, View } from "react-native";
import { mobileBotRuns } from "./personal-saas";
import { BotRunActionError, type BotRunStatus } from "./personal-saas-bot-runs";

export function PersonalSaasBotRun({
  workspaceId,
  botId,
  canStart,
  initialRunId,
  onAccept,
}: {
  workspaceId: string;
  botId: string;
  canStart: boolean;
  initialRunId: string | null;
  onAccept: (runId: string) => void;
}) {
  const runs = mobileBotRuns;
  const [instruction, setInstruction] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [runId, setRunId] = useState(initialRunId);
  const [status, setStatus] = useState<BotRunStatus | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
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
    if (
      working.current ||
      !instruction.trim() ||
      (runId && !terminal) ||
      (!requestId && !canStart)
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      const id = requestId ?? randomUUID();
      setRequestId(id);
      const accepted = await runs.start({
        workspaceId,
        botId,
        instruction: instruction.trim(),
        requestId: id,
      });
      onAccept(accepted.runId);
      setRunId(accepted.runId);
      setStatus(null);
      setStatusError(false);
      setInstruction("");
      setRequestId(null);
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
        editable={requestId === null}
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
          (!canStart && !requestId)
        }
        onPress={() => void start()}
        title={
          requestId && !busy ? "Retry submission" : "Run with Test Credits"
        }
      />
      {requestId && !busy && (
        <Button
          title="Clear instruction"
          onPress={() => {
            setRequestId(null);
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
