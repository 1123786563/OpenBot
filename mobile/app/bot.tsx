import { Link, Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Button, Pressable, Switch, Text, View } from "react-native";
import { everyPage, ORGANIZATION_ID, type Routine } from "../src/api";
import {
  getBot,
  getBotLifecycle,
  pauseBot,
  resumeBot,
} from "../src/api/generated/bots/bots";
import { listCheckInItems } from "../src/api/generated/check-ins/check-ins";
import { listConversations } from "../src/api/generated/conversations/conversations";
import {
  listRoutines,
  pauseRoutine,
  resumeRoutine,
} from "../src/api/generated/routines/routines";
import { authClient } from "../src/auth";
import { hideItem, ItemCard, startItem } from "../src/check-ins";
import {
  isLocalMobilePreview,
  previewBots,
  previewRoutines,
} from "../src/home-preview";
import {
  ADD_ROUTINE_DRAFT,
  lastRunLine,
  runColor,
  when,
} from "../src/routines";
import {
  card,
  colors,
  heading,
  muted,
  Problem,
  Screen,
  Section,
  useAction,
} from "../src/ui";
import { useLoad } from "../src/use-load";

/**
 * The Bot profile: what its check-ins found for the person, pause, its computer, its routines, and
 * what customizes it.
 */
export default function BotScreen() {
  const { botId = "", preview } = useLocalSearchParams<{
    botId: string;
    preview?: string;
  }>();
  if (isLocalMobilePreview("/bot", preview)) {
    const sample = previewBots.find((bot) => bot.id === botId);
    if (!sample)
      return (
        <Redirect href={{ pathname: "/bots", params: { preview: "1" } }} />
      );
    return <BotProfile botId={botId} sample={sample} />;
  }
  return <ConnectedBot botId={botId} />;
}

function ConnectedBot({ botId }: { botId: string }) {
  const { data: session, isPending } = authClient.useSession();
  return <BotProfile botId={botId} session={session} isPending={isPending} />;
}

function BotProfile({
  botId,
  sample,
  session,
  isPending = false,
}: {
  botId: string;
  sample?: (typeof previewBots)[number];
  session?: ReturnType<typeof authClient.useSession>["data"];
  isPending?: boolean;
}) {
  const action = useAction();
  const loadBot = useCallback(() => getBot(ORGANIZATION_ID, botId), [botId]);
  const bot = useLoad(loadBot, Boolean(session && botId));
  const loadLifecycle = useCallback(
    () => getBotLifecycle(ORGANIZATION_ID, botId),
    [botId],
  );
  const lifecycle = useLoad(loadLifecycle, Boolean(session && botId));
  const loadRoutines = useCallback(
    () =>
      everyPage(
        (page) => listRoutines(ORGANIZATION_ID, page),
        (page) => page.routines,
      ),
    [],
  );
  const routines = useLoad(loadRoutines, Boolean(session));
  const loadItems = useCallback(
    () =>
      everyPage(
        (page) => listCheckInItems(ORGANIZATION_ID, page),
        (page) => page.checkInItems,
      ),
    [],
  );
  const items = useLoad(loadItems, Boolean(session));
  if (!sample && !session && !isPending) return <Redirect href="/" />;
  const mine = (sample ? previewRoutines : routines.data)?.filter(
    (routine) => routine.botId === botId,
  );
  const found = items.data?.filter((item) => item.botId === botId);
  const paused = sample ? sample.id === "research" : lifecycle.data?.paused;
  const profile = sample ?? bot.data?.bot;
  const name = profile?.name ?? "This Bot";

  async function setPaused(next: boolean) {
    await action.run("pause", async () => {
      await (next ? pauseBot : resumeBot)(ORGANIZATION_ID, botId);
      await lifecycle.refresh();
    });
  }
  async function setActive(routine: Routine, enabled: boolean) {
    await action.run(routine.id, async () => {
      await (enabled ? resumeRoutine : pauseRoutine)(
        ORGANIZATION_ID,
        routine.id,
      );
      await routines.refresh();
    });
  }
  async function addRoutine() {
    await action.run("add", async () => {
      const page = await listConversations(ORGANIZATION_ID, { limit: 100 });
      const conversation = page.conversations.find(
        (item) => item.active && item.botIds.includes(botId),
      );
      if (!conversation)
        throw new Error(
          `Start a conversation with ${name} first, then add a routine from it.`,
        );
      router.push({
        pathname: "/conversation",
        params: {
          channelId: conversation.id,
          agentId: botId,
          draft: ADD_ROUTINE_DRAFT,
        },
      });
    });
  }

  return (
    <Screen
      refreshing={
        bot.pending || lifecycle.pending || routines.pending || items.pending
      }
      onRefresh={
        sample
          ? undefined
          : () => {
              void bot.refresh();
              void lifecycle.refresh();
              void routines.refresh();
              void items.refresh();
            }
      }
    >
      {sample && (
        <Link href={{ pathname: "/bots", params: { preview: "1" } }}>
          Back to preview Bots
        </Link>
      )}
      <Text style={heading}>{name}</Text>
      {profile?.title ? <Text style={muted}>{profile.title}</Text> : null}
      <Problem
        message={
          action.error ||
          bot.error ||
          lifecycle.error ||
          routines.error ||
          items.error
        }
      />
      {found?.length ? (
        <Section title="Needs you">
          {found.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              botName={name}
              busy={action.busy}
              onStart={() => {
                void action.run(`start:${item.id}`, async () => {
                  await startItem(item);
                  void items.refresh();
                });
              }}
              onHide={() => {
                void action.run(`hide:${item.id}`, async () => {
                  await hideItem(item);
                  await items.refresh();
                });
              }}
            />
          ))}
        </Section>
      ) : null}
      <View style={card}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontWeight: "600" }}>
              {paused === undefined
                ? "Checking…"
                : paused
                  ? "Paused"
                  : "Active"}
            </Text>
            <Text style={muted}>
              {paused
                ? "It does no work for you, including routines, until you resume it."
                : "Pausing stops its running work for you and skips routines."}
            </Text>
          </View>
          <Switch
            accessibilityLabel={`${name} is active`}
            value={paused === false}
            disabled={Boolean(sample || action.busy) || paused === undefined}
            onValueChange={(active) => {
              void setPaused(!active);
            }}
          />
        </View>
      </View>
      <Button
        title="Open computer"
        onPress={() =>
          router.push({
            pathname: "/computer",
            params: { botId, ...(sample ? { preview: "1" } : {}) },
          })
        }
      />
      <Section title="Routines">
        {mine?.map((routine) => (
          <Pressable
            key={routine.id}
            accessibilityRole="link"
            accessibilityLabel={`Routine: ${routine.instruction}`}
            onPress={() =>
              router.push({
                pathname: "/routine",
                params: {
                  routineId: routine.id,
                  ...(sample ? { preview: "1" } : {}),
                },
              })
            }
            style={card}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={2} style={{ fontWeight: "600" }}>
                  {routine.instruction}
                </Text>
                <Text style={muted}>
                  {routine.schedule} · {routine.timezone}
                </Text>
                <Text style={muted}>
                  {routine.enabled
                    ? `Next run ${when(routine.nextRunAt)}`
                    : "Paused"}
                </Text>
                {routine.lastRun && lastRunLine(routine.lastRun.status) ? (
                  <Text style={{ color: runColor(routine.lastRun.status) }}>
                    {lastRunLine(routine.lastRun.status)}
                  </Text>
                ) : null}
              </View>
              <Switch
                accessibilityLabel="Active"
                value={routine.enabled}
                disabled={Boolean(sample || action.busy)}
                onValueChange={(enabled) => {
                  void setActive(routine, enabled);
                }}
              />
            </View>
          </Pressable>
        ))}
        {mine?.length === 0 && <Text style={muted}>No routines yet.</Text>}
        <Button
          title="Add routine"
          disabled={Boolean(sample || action.busy)}
          onPress={() => {
            void addRoutine();
          }}
        />
      </Section>
      <Section title="Customize">
        {[
          {
            label: "Plugins",
            go: () =>
              router.push({
                pathname: "/plugins",
                params: { botId, ...(sample ? { preview: "1" } : {}) },
              }),
          },
          {
            label: "Memory",
            go: () =>
              router.push(
                sample
                  ? { pathname: "/memory", params: { botId, preview: "1" } }
                  : "/memory",
              ),
          },
          {
            label: "Custom rules",
            go: () =>
              router.push({
                pathname: "/rules",
                params: { botId, ...(sample ? { preview: "1" } : {}) },
              }),
          },
        ].map((item) => (
          <Pressable
            key={item.label}
            accessibilityRole="link"
            onPress={item.go}
            style={card}
          >
            <Text style={{ color: colors.link, fontSize: 16 }}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </Section>
    </Screen>
  );
}
