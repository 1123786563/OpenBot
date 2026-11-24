import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ScrollView, Text, TextInput, View } from "react-native";
import { type Conversation, streamApi } from "./api";
import {
  type ConversationSnapshot,
  DirectConversationError,
  directConversation,
  type PendingTurn,
} from "./direct-conversation";

export function DirectConversationScreen({
  conversation,
  agentId,
  draft,
}: {
  conversation: Conversation;
  agentId: string;
  draft?: string;
}) {
  const client = useMemo(
    () =>
      directConversation(streamApi, {
        threadId: conversation.threadId,
        agentId,
      }),
    [conversation.threadId, agentId],
  );
  const [text, setText] = useState(draft ?? "");
  const [history, setHistory] = useState<ConversationSnapshot>();
  const [accessLost, setAccessLost] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const pending = useRef<PendingTurn | undefined>(undefined);
  const action = useRef<AbortController | undefined>(undefined);
  const active = history?.runs.find(({ status }) => status === "running");
  const unknown = history?.runs.find(
    ({ externalOutcome }) => externalOutcome === "unknown",
  );

  useEffect(() => () => action.current?.abort(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry restarts the snapshot and stream after a control action
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      const next = await client.history(signal);
      if (signal.aborted) return next;
      if (
        pending.current &&
        next.runs.some(
          (run) => run.userMessageId === pending.current?.messageId,
        )
      ) {
        pending.current = undefined;
        setText("");
        setActionError("");
      }
      setHistory(next);
      setAccessLost(false);
      setConnectionError("");
      return next;
    }
    async function sync() {
      try {
        const snapshot = await refresh();
        const run = snapshot.runs.find(({ status }) => status === "running");
        if (run && !signal.aborted) {
          await client.follow(
            run.id,
            async () => {
              await refresh();
            },
            signal,
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DirectConversationError && error.accessLost) {
          setHistory(undefined);
          setAccessLost(true);
          pending.current = undefined;
          action.current?.abort();
          setText("");
          setBusy(false);
          setActionError("");
          return;
        }
        setConnectionError("Connection interrupted. Reconnecting…");
      }
      if (!signal.aborted)
        timer = setTimeout(() => {
          void sync();
        }, 2_000);
    }
    void sync();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, retry]);

  async function perform(operation: (signal: AbortSignal) => Promise<void>) {
    if (action.current && !action.current.signal.aborted) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(true);
    setActionError("");
    try {
      await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not complete the action.",
      );
    } finally {
      if (action.current === controller) action.current = undefined;
      if (!controller.signal.aborted) {
        setBusy(false);
        setRetry((version) => version + 1);
      }
    }
  }

  function submit() {
    const prompt = text.trim();
    if (!prompt) return;
    void perform(async (signal) => {
      const turn = pending.current ?? {
        messageId: Crypto.randomUUID(),
        runId: Crypto.randomUUID(),
        text: prompt,
      };
      pending.current = turn;
      try {
        await client.submit(turn, signal);
      } catch (error) {
        if (
          error instanceof DirectConversationError &&
          error.status < 500 &&
          error.status !== 429
        )
          pending.current = undefined;
        throw error;
      }
      if (signal.aborted) return;
      pending.current = undefined;
      setText("");
    });
  }

  if (accessLost)
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <Text accessibilityRole="alert">Conversation access ended.</Text>
        <Button
          title="Check access"
          onPress={() => setRetry((version) => version + 1)}
        />
      </View>
    );

  const usable = Boolean(history && !connectionError);
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text
        accessibilityRole="header"
        style={{ fontSize: 22, fontWeight: "600" }}
      >
        {conversation.name}
      </Text>
      {connectionError || actionError ? (
        <Text accessibilityRole="alert">{connectionError || actionError}</Text>
      ) : null}
      {!history && !connectionError ? <Text>Loading conversation…</Text> : null}
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 12 }}>
        {history?.messages.map((message) => {
          const run = history.runs.find(
            ({ userMessageId }) => userMessageId === message.id,
          );
          return (
            <View
              key={message.id}
              style={{
                gap: 4,
                padding: 12,
                backgroundColor: "#f3f4f6",
                borderRadius: 8,
              }}
            >
              <Text style={{ fontWeight: "600" }}>
                {message.role === "user" ? "You" : "Bot"}
              </Text>
              <Text>{message.content}</Text>
              {run ? (
                <Text>
                  {run.externalOutcome === "unknown"
                    ? "Action outcome unknown"
                    : run.stopReason === "context_revoked"
                      ? "Paused because Memory or Learned skill access changed"
                      : run.stopReason === "stopped"
                        ? "Stopped"
                        : run.stopReason === "access_revoked"
                          ? "Access revoked"
                          : run.pendingApprovals?.length
                            ? "Waiting for approval"
                            : run.status === "running"
                              ? "Running"
                              : run.status === "completed"
                                ? "Completed"
                                : "Failed"}
                </Text>
              ) : null}
            </View>
          );
        })}
        {history?.approvals.map(({ id, action: approval }) => (
          <View key={id} style={{ gap: 8 }}>
            <Text>{approval.toolRef} requests approval</Text>
            <Text>{approval.scope}</Text>
            <Text>{JSON.stringify(approval.args, null, 2)}</Text>
            <Button
              title="Allow once"
              disabled={!usable || busy}
              onPress={() => {
                void perform((signal) =>
                  client.decide(id, "allow_once", signal),
                );
              }}
            />
            <Button
              title="Deny"
              disabled={!usable || busy}
              onPress={() => {
                void perform((signal) => client.decide(id, "deny", signal));
              }}
            />
          </View>
        ))}
      </ScrollView>
      {active ? (
        <Button
          title="Stop Run"
          disabled={!usable || busy}
          onPress={() => {
            void perform((signal) => client.stop(active.id, signal));
          }}
        />
      ) : null}
      {unknown && conversation.active ? (
        <Button
          title="Check outcome"
          disabled={!usable || busy}
          onPress={() => {
            void perform((signal) => client.reconcile(unknown.id, signal));
          }}
        />
      ) : null}
      <TextInput
        accessibilityLabel="Message"
        multiline
        value={text}
        onChangeText={setText}
        editable={usable && conversation.active && !busy && !pending.current}
        placeholder="Message this Bot"
        style={{
          borderWidth: 1,
          borderColor: "#9ca3af",
          borderRadius: 8,
          padding: 12,
          maxHeight: 140,
        }}
      />
      <Button
        title={pending.current ? "Retry send" : "Send"}
        disabled={
          !usable ||
          !conversation.active ||
          busy ||
          !text.trim() ||
          Boolean(active || unknown)
        }
        onPress={submit}
      />
    </View>
  );
}
