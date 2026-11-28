import * as Crypto from "expo-crypto";
import { Link, Redirect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { ORGANIZATION_ID } from "../src/api";
import {
  getConversation,
  listConversationMessages,
  sendConversationMessage,
} from "../src/api/generated/conversations/conversations";
import type { ConversationMessage } from "../src/api/generated/model";
import { authClient } from "../src/auth";
import {
  isLocalMobilePreview,
  previewConversations,
} from "../src/home-preview";
import { useLoad } from "../src/use-load";
export default function ConversationScreen() {
  const { channelId, preview } = useLocalSearchParams();
  if (isLocalMobilePreview("/conversation", preview)) {
    const sample = previewConversations.find(({ id }) => id === channelId);
    if (!sample)
      return <Redirect href={{ pathname: "/", params: { preview: "1" } }} />;
    return <Conversation sample={sample} />;
  }
  return <ConnectedConversation />;
}

function ConnectedConversation() {
  const { data: session, isPending } = authClient.useSession();
  return <Conversation session={session} isPending={isPending} />;
}

function Conversation({
  session,
  isPending = false,
  sample,
}: {
  session?: ReturnType<typeof authClient.useSession>["data"];
  isPending?: boolean;
  sample?: (typeof previewConversations)[number];
}) {
  const {
    channelId,
    agentId: requestedAgentId,
    draft,
  } = useLocalSearchParams<{
    channelId: string;
    agentId?: string;
    draft?: string;
  }>();
  const [agentId, setAgentId] = useState(sample?.botId ?? "");
  // A Bot profile's "Add routine" arrives with its sentence started for the person to finish.
  const [text, setText] = useState(draft ?? "");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const pendingSend = useRef<{ key: string; id: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload for whoever is signed in now, not the previous person
  const loadChannels = useCallback(
    () => getConversation(ORGANIZATION_ID, channelId ?? ""),
    [channelId, session?.user.id],
  );
  const channels = useLoad(loadChannels, Boolean(session));
  const conversation = sample
    ? { name: sample.name, botIds: [sample.botId], active: false }
    : channels.data?.conversation;
  useEffect(() => {
    if (conversation && !agentId)
      setAgentId(
        requestedAgentId && conversation.botIds.includes(requestedAgentId)
          ? requestedAgentId
          : (conversation.botIds[0] ?? ""),
      );
  }, [conversation, agentId, requestedAgentId]);
  const loadHistory = useCallback(
    () =>
      listConversationMessages(ORGANIZATION_ID, channelId ?? "", {
        botId: agentId,
        limit: 200,
      }),
    [channelId, agentId],
  );
  const history = useLoad(loadHistory, Boolean(session && agentId));
  if (!sample && !session && !isPending) return <Redirect href="/" />;
  // The API answers newest first. The conversation reads oldest first.
  const messages:
    | Pick<ConversationMessage, "id" | "role" | "text" | "toolCalls">[]
    | undefined = sample
    ? [
        { id: "prompt", role: "person", text: sample.prompt },
        { id: "reply", role: "bot", text: sample.reply },
      ]
    : history.data?.messages.slice().reverse();
  async function send() {
    if (sample || !text.trim() || !agentId || sending) return;
    setSending(true);
    setError("");
    const key = JSON.stringify([session?.user.id, channelId, agentId, text]);
    const id =
      pendingSend.current?.key === key
        ? pendingSend.current.id
        : Crypto.randomUUID();
    pendingSend.current = { key, id };
    try {
      await sendConversationMessage(ORGANIZATION_ID, channelId, {
        id,
        text,
        botId: agentId,
      });
      pendingSend.current = null;
      setText("");
      await history.refresh();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not send your message.",
      );
    } finally {
      setSending(false);
    }
  }
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      {sample && (
        <Link href={{ pathname: "/", params: { preview: "1" } }}>
          Back to preview home
        </Link>
      )}
      <Text style={{ fontSize: 22, fontWeight: "600" }}>
        {conversation?.name ?? "Conversation"}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {conversation?.botIds.map((id) => (
          <Button
            key={id}
            title={id === agentId ? `${id} ✓` : id}
            onPress={() => setAgentId(id)}
          />
        ))}
      </View>
      {(error || channels.error || history.error) && (
        <Text accessibilityRole="alert" style={{ color: "#b42318" }}>
          {error || channels.error || history.error}
        </Text>
      )}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={
          sample ? undefined : (
            <RefreshControl
              refreshing={history.pending}
              onRefresh={() => {
                void history.refresh();
              }}
            />
          )
        }
        contentContainerStyle={{ gap: 12 }}
      >
        {messages?.map((message) => (
          <View
            key={message.id}
            style={{
              padding: 12,
              backgroundColor:
                message.role === "person" ? "#eff6ff" : "#f3f4f6",
              borderRadius: 8,
            }}
          >
            <Text style={{ fontWeight: "600" }}>
              {message.role === "person" ? "You" : agentId}
            </Text>
            <Text>
              {message.text ||
                (message.toolCalls ? "The Bot is using a tool." : "")}
            </Text>
          </View>
        ))}
      </ScrollView>
      <TextInput
        accessibilityLabel="Message"
        multiline
        autoFocus={Boolean(draft)}
        value={text}
        onChangeText={setText}
        editable={conversation?.active && !sending}
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
        title={sending ? "Sending…" : "Send"}
        disabled={!conversation?.active || !agentId || !text.trim() || sending}
        onPress={() => {
          void send();
        }}
      />
    </View>
  );
}
