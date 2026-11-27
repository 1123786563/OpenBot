import { Link, Redirect, router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { Alert, Button, Switch, Text, View } from "react-native";
import { everyPage, ORGANIZATION_ID, type Routine } from "../src/api";
import {
  deleteRoutine,
  listRoutineRuns,
  listRoutines,
  pauseRoutine,
  resumeRoutine,
  runRoutine,
} from "../src/api/generated/routines/routines";
import type { RoutineRun } from "../src/api/generated/model";
import { authClient } from "../src/auth";
import { isLocalMobilePreview, previewRoutines } from "../src/home-preview";
import { runColor, runLabel, when } from "../src/routines";
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

/** One routine: Active, schedule, next run, instruction, Run now, and its run history. */
export default function RoutineScreen() {
  const { routineId = "", preview } = useLocalSearchParams();
  const id = typeof routineId === "string" ? routineId : "";
  if (isLocalMobilePreview("/routine", preview)) {
    const sample = previewRoutines.find((routine) => routine.id === id);
    if (!sample)
      return (
        <Redirect href={{ pathname: "/bots", params: { preview: "1" } }} />
      );
    return <RoutineDetail routineId={id} sample={sample} />;
  }
  return <ConnectedRoutine routineId={id} />;
}

function ConnectedRoutine({ routineId }: { routineId: string }) {
  const { data: session, isPending } = authClient.useSession();
  return (
    <RoutineDetail
      routineId={routineId}
      session={session}
      isPending={isPending}
    />
  );
}

const exampleRuns: RoutineRun[] = [
  {
    id: "sample-run",
    status: "succeeded",
    startedAt: "2026-11-23T01:00:00Z",
    finishedAt: "2026-11-23T01:00:42Z",
    source: "schedule",
    error: null,
  },
];

function RoutineDetail({
  routineId,
  sample,
  session,
  isPending = false,
}: {
  routineId: string;
  sample?: Routine;
  session?: ReturnType<typeof authClient.useSession>["data"];
  isPending?: boolean;
}) {
  const action = useAction();
  const loadRoutines = useCallback(
    () =>
      everyPage(
        (page) => listRoutines(ORGANIZATION_ID, page),
        (page) => page.routines,
      ),
    [],
  );
  const routines = useLoad(loadRoutines, Boolean(session));
  const loadRuns = useCallback(
    () =>
      everyPage(
        (page) => listRoutineRuns(ORGANIZATION_ID, routineId, page),
        (page) => page.runs,
      ),
    [routineId],
  );
  const runs = useLoad(loadRuns, Boolean(session && routineId));
  if (!sample && !session && !isPending) return <Redirect href="/" />;
  const routine =
    sample ?? routines.data?.find((item) => item.id === routineId);
  const runHistory = sample ? exampleRuns : runs.data;
  const running = runHistory?.some((run) => run.status === "running");

  async function setActive(enabled: boolean) {
    await action.run("active", async () => {
      await (enabled ? resumeRoutine : pauseRoutine)(
        ORGANIZATION_ID,
        routineId,
      );
      await routines.refresh();
    });
  }
  async function runNow() {
    await action.run("run", async () => {
      await runRoutine(ORGANIZATION_ID, routineId);
      await runs.refresh();
    });
  }
  async function remove() {
    const removed = await action.run("delete", () =>
      deleteRoutine(ORGANIZATION_ID, routineId),
    );
    if (removed) router.back();
  }

  return (
    <Screen
      refreshing={routines.pending || runs.pending}
      onRefresh={
        sample
          ? undefined
          : () => {
              void routines.refresh();
              void runs.refresh();
            }
      }
    >
      {sample && (
        <Link
          href={{
            pathname: "/bot",
            params: { botId: sample.botId, preview: "1" },
          }}
        >
          Back to preview Bot
        </Link>
      )}
      <Text style={heading}>Routine</Text>
      <Problem message={action.error || routines.error || runs.error} />
      {routines.data && !routine && <Text>This routine no longer exists.</Text>}
      {routine && (
        <>
          <View
            style={[
              card,
              {
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              },
            ]}
          >
            <Text style={{ fontWeight: "600" }}>Active</Text>
            <Switch
              accessibilityLabel="Active"
              value={routine.enabled}
              disabled={Boolean(sample || action.busy)}
              onValueChange={(enabled) => {
                void setActive(enabled);
              }}
            />
          </View>
          <View style={card}>
            <Text style={muted}>Schedule</Text>
            <Text>
              {routine.schedule} ({routine.timezone})
            </Text>
            <Text style={muted}>Next run</Text>
            <Text>{routine.enabled ? when(routine.nextRunAt) : "Paused"}</Text>
            <Text style={muted}>Instruction</Text>
            <Text>{routine.instruction}</Text>
            <Text style={muted}>Reports in</Text>
            <Text>
              {routine.conversation.gone
                ? "A deleted conversation. Change it from chat."
                : (routine.conversation.name ?? "A conversation")}
            </Text>
          </View>
          <Button
            title={running ? "Running…" : "Run now"}
            disabled={
              !routine.enabled || Boolean(sample || action.busy) || running
            }
            onPress={() => {
              void runNow();
            }}
          />
          {!routine.enabled && (
            <Text style={muted}>Turn on Active to run it.</Text>
          )}
          <Section title="Run history">
            {runHistory?.length === 0 && <Text style={muted}>No runs yet</Text>}
            {runHistory?.map((run) => (
              <View key={run.id} style={card}>
                {runLabel(run.status) ? (
                  <Text
                    style={{ fontWeight: "600", color: runColor(run.status) }}
                  >
                    {runLabel(run.status)}
                  </Text>
                ) : null}
                <Text style={muted}>
                  Started {when(run.startedAt)}
                  {run.finishedAt ? ` · finished ${when(run.finishedAt)}` : ""}
                </Text>
                {run.error ? (
                  <Text style={{ color: colors.error }}>{run.error}</Text>
                ) : null}
              </View>
            ))}
          </Section>
          <Button
            title="Delete routine"
            color={colors.error}
            disabled={Boolean(sample || action.busy)}
            onPress={() =>
              Alert.alert(
                "Delete this routine?",
                "It stops running and its history is removed.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Delete",
                    style: "destructive",
                    onPress: () => {
                      void remove();
                    },
                  },
                ],
              )
            }
          />
        </>
      )}
    </Screen>
  );
}
