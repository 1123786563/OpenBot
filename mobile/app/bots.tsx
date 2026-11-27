import { Link, Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Pressable, Text } from "react-native";
import { everyBot } from "../src/api";
import { authClient } from "../src/auth";
import { isLocalMobilePreview, previewBots } from "../src/home-preview";
import { card, colors, heading, muted, Problem, Screen } from "../src/ui";
import { useLoad } from "../src/use-load";

/** Every Bot this person can reach, each opening its profile. */
export default function BotsScreen() {
  const { preview } = useLocalSearchParams();
  if (isLocalMobilePreview("/bots", preview)) {
    return <BotList items={previewBots} preview />;
  }
  return <ConnectedBots />;
}

function ConnectedBots() {
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(() => everyBot(), []);
  const bots = useLoad(load, Boolean(session));
  if (!session && !isPending) return <Redirect href="/" />;
  return (
    <BotList
      items={bots.data}
      error={bots.error}
      refreshing={bots.pending}
      onRefresh={() => void bots.refresh()}
    />
  );
}

function BotList({
  items,
  error,
  refreshing,
  onRefresh,
  preview = false,
}: {
  items?: readonly { id: string; name: string; title?: string | null }[];
  error?: string;
  refreshing?: boolean;
  onRefresh?: () => void;
  preview?: boolean;
}) {
  return (
    <Screen refreshing={refreshing} onRefresh={onRefresh}>
      <Text style={heading}>Bots</Text>
      {preview && (
        <Link href={{ pathname: "/", params: { preview: "1" } }}>
          Back to preview home
        </Link>
      )}
      <Problem message={error} />
      {items?.map((bot) => (
        <Pressable
          key={bot.id}
          accessibilityRole="link"
          accessibilityLabel={`Open ${bot.name}`}
          onPress={() =>
            router.push({
              pathname: "/bot",
              params: { botId: bot.id, ...(preview ? { preview: "1" } : {}) },
            })
          }
          style={card}
        >
          <Text style={{ fontSize: 17, fontWeight: "600", color: colors.link }}>
            {bot.name}
          </Text>
          {bot.title ? <Text style={muted}>{bot.title}</Text> : null}
        </Pressable>
      ))}
      {items?.length === 0 && (
        <Text>No Bots yet. Create one in OpenBot on your computer.</Text>
      )}
    </Screen>
  );
}
