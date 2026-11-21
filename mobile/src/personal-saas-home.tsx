import { addNetworkStateListener } from "expo-network";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Button, ScrollView, Text, View } from "react-native";
import {
  openPersonalWorkspace,
  openWorkspaceClosure,
  openWorkspaceExport,
  readAutomationHistory,
  runWorkspaceAction,
  PersonalSaasActionError,
  recoverPersonalWork,
  signInPersonalSaas,
  signOutPersonalSaas,
  WorkspaceAdmissionsPaused,
} from "./personal-saas";

import type {
  AutomationResource,
  ClosedWorkspace,
  WorkspaceAction,
  PausedWorkspace,
} from "./personal-saas-contract";

type AutomationItem = {
  id: string;
  title: string;
  blockedReason: string | null;
  enabled: boolean;
  resource: AutomationResource;
};

type Screen =
  | { kind: "loading" | "preparing" | "signed-out" }
  | {
      kind: "ready";
      workspace: NonNullable<Awaited<ReturnType<typeof openPersonalWorkspace>>>;
    }
  | { kind: "workspace-error" | "admissions-paused" }
  | { kind: "paused"; status: PausedWorkspace }
  | { kind: "closed"; status: ClosedWorkspace };

export function PersonalSaasHome() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [history, setHistory] = useState<{
    workspaceId: string;
    key: string;
    runs: Awaited<ReturnType<typeof readAutomationHistory>>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const working = useRef(false);
  const active = useRef(AppState.currentState === "active");
  const generation = useRef(0);
  const access = useRef<(() => number) | null>(null);

  const withdraw = useCallback(
    (kind: "loading" | "workspace-error" | "admissions-paused") => {
      generation.current++;
      access.current = null;
      setHistory(null);
      setScreen({ kind });
    },
    [],
  );

  const load = useCallback(
    async (refresh = false) => {
      if (!active.current) return;
      if (!refresh) withdraw("loading");
      const current = generation.current;
      const started = performance.now();
      const wallStarted = Date.now();
      try {
        const workspace = await openPersonalWorkspace(() => {
          if (!refresh && current === generation.current)
            setScreen({ kind: "preparing" });
        });
        if (current !== generation.current) return;
        if (!workspace) {
          access.current = null;
          setHistory(null);
          setScreen({ kind: "signed-out" });
          return;
        }
        const remaining = () =>
          workspace.accessMs -
          Math.max(performance.now() - started, Date.now() - wallStarted);
        if (remaining() <= 0 || (access.current && access.current() <= 0)) {
          withdraw("workspace-error");
          return;
        }
        access.current = remaining;
        setScreen({ kind: "ready", workspace });
      } catch (error) {
        if (current === generation.current)
          withdraw(
            error instanceof WorkspaceAdmissionsPaused
              ? "admissions-paused"
              : "workspace-error",
          );
      }
    },
    [withdraw],
  );

  useEffect(() => {
    function setActive(next: boolean) {
      if (next === active.current) return;
      active.current = next;
      if (!next) {
        generation.current++;
        access.current = null;
        setHistory(null);
        setScreen((previous) =>
          previous.kind === "ready" ? { kind: "loading" } : previous,
        );
      } else if (!working.current) {
        void load();
      }
    }

    const appState = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    const blur = AppState.addEventListener("blur", () => setActive(false));
    const focus = AppState.addEventListener("focus", () => {
      setActive(AppState.currentState === "active");
    });
    let wasOffline = false;
    const network = addNetworkStateListener((state) => {
      const offline =
        state.isConnected === false || state.isInternetReachable === false;
      const reconnected = wasOffline && !offline && state.isConnected;
      wasOffline = offline;
      if (!active.current) return;
      if (offline) {
        generation.current++;
        access.current = null;
        setHistory(null);
        setScreen((previous) =>
          previous.kind === "ready" ||
          previous.kind === "preparing" ||
          previous.kind === "loading"
            ? { kind: "workspace-error" }
            : previous,
        );
      } else if (reconnected) {
        void load();
      }
    });
    void load();
    return () => {
      generation.current++;
      appState.remove();
      blur.remove();
      focus.remove();
      network.remove();
    };
  }, [load]);

  useEffect(() => {
    if (screen.kind !== "ready" || !access.current) return;
    const delay = access.current();
    const expiry = setTimeout(
      () => withdraw("workspace-error"),
      Math.max(0, delay),
    );
    const refresh = setTimeout(
      () => void load(true),
      Math.min(5_000, Math.max(1_000, delay / 2)),
    );
    return () => {
      clearTimeout(expiry);
      clearTimeout(refresh);
    };
  }, [load, screen, withdraw]);

  async function act(work: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setAuthError("");
    try {
      await work();
    } catch (failure) {
      setAuthError(
        failure instanceof PersonalSaasActionError
          ? failure.message
          : "Could not complete this action. Try again.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function updateWorkspace(work: () => Promise<void>) {
    if (!active.current || !access.current || access.current() <= 0) return;
    const current = generation.current;
    void act(async () => {
      await work();
      if (current === generation.current) await load(true);
    });
  }

  function resolve(
    key: string,
    action: "cancel" | "retry",
    acknowledged = false,
  ) {
    updateWorkspace(() => recoverPersonalWork(key, action, acknowledged));
  }

  function showHistory(resource: AutomationResource, id: string) {
    if (
      screen.kind !== "ready" ||
      !active.current ||
      !access.current ||
      access.current() <= 0
    )
      return;
    const workspaceId = screen.workspace.id;
    const current = generation.current;
    void act(async () => {
      const runs = await readAutomationHistory(resource, id);
      if (
        current === generation.current &&
        access.current &&
        access.current() > 0
      )
        setHistory({ workspaceId, key: `${resource}/${id}`, runs });
    });
  }

  const workspace =
    screen.kind === "ready" && access.current && access.current() > 0
      ? screen.workspace
      : null;
  const stoppedWork = workspace
    ? [
        ...workspace.recovery.map(({ instruction, ...item }) => ({
          ...item,
          label: instruction,
          summary: undefined,
          canRetry: workspace.recoveryCanRetry,
          retryText: item.outcomeUnknown ? "Retry as a new run" : "Requeue",
          retryResult: "Queued as a new run",
        })),
        ...workspace.interruptedBackgroundWork.map((item) => ({
          ...item,
          canRetry: item.recoveryCanRetry,
          retryText: "Start fresh work",
          retryResult: "Started as fresh work",
        })),
      ]
    : [];
  const automation = workspace?.automation;
  const automations = automation
    ? [
        ...automation.routines.map<AutomationItem>(
          ({ id, title, blockedReason, enabled }) => ({
            id,
            title: title ?? "Routine",
            blockedReason,
            enabled,
            resource: "routines",
          }),
        ),
        ...automation.bindings.map<AutomationItem>(
          ({ id, transport, blockedReason }) => ({
            id,
            title: transport,
            blockedReason,
            enabled: true,
            resource: "bindings",
          }),
        ),
      ]
    : [];
  const computer = workspace?.computer;
  const computerAction: WorkspaceAction = {
    kind: "computer",
    action: computer?.status === "running" ? "stop" : "start",
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
      <Text
        accessibilityRole="header"
        style={{ fontSize: 24, fontWeight: "600" }}
      >
        {screen.kind === "signed-out"
          ? "Sign in to OpenBot"
          : screen.kind === "paused"
            ? "Personal Workspace paused"
            : screen.kind === "closed"
              ? "Workspace closure progress"
              : "Personal Workspace"}
      </Text>
      {screen.kind === "loading" && (
        <Text accessibilityLiveRegion="polite">Checking your workspace…</Text>
      )}
      {screen.kind === "preparing" && (
        <Text accessibilityLiveRegion="polite">
          Preparing your Personal Workspace…
        </Text>
      )}
      {authError !== "" && <Text accessibilityRole="alert">{authError}</Text>}
      {screen.kind === "paused" && (
        <>
          {screen.status.reason && <Text>{screen.status.reason}</Text>}
          <Text>Operation ID {screen.status.operationId}</Text>
          {screen.status.supportEmail && (
            <Text>Contact support at {screen.status.supportEmail}.</Text>
          )}
        </>
      )}
      {screen.kind === "closed" && (
        <>
          <Text>Operation ID {screen.status.operationId}</Text>
          <Text>Application sessions revoked</Text>
          <Text>Work cutoff · {screen.status.executionCutoff.work}</Text>
          <Text>Computer exit · {screen.status.executionCutoff.computer}</Text>
          <Text>Online data cleanup · {screen.status.onlineCleanup}</Text>
          <Text>Third-party revocation · {screen.status.remoteRevocation}</Text>
          <Text>Backup expiration · {screen.status.backups}</Text>
        </>
      )}
      {(screen.kind === "paused" ||
        screen.kind === "ready" ||
        screen.kind === "closed") && (
        <Button
          disabled={busy}
          title={
            screen.kind === "closed"
              ? "Check progress in browser"
              : "Close workspace in browser"
          }
          onPress={() => {
            void act(openWorkspaceClosure);
          }}
        />
      )}
      {(screen.kind === "signed-out" ||
        screen.kind === "paused" ||
        screen.kind === "closed") && (
        <Button
          disabled={busy}
          title={
            screen.kind === "signed-out"
              ? "Continue with Casdoor"
              : "Sign in again"
          }
          onPress={() => {
            void act(async () => {
              const status = await signInPersonalSaas();
              if (status?.status === "paused")
                setScreen({ kind: "paused", status });
              else if (status?.status === "closed")
                setScreen({ kind: "closed", status });
              else await load();
            });
          }}
        />
      )}
      {(screen.kind === "workspace-error" ||
        screen.kind === "admissions-paused") && (
        <>
          <Text accessibilityRole="alert">
            {screen.kind === "admissions-paused"
              ? "New workspace openings are temporarily paused."
              : "Could not open your Personal Workspace."}
          </Text>
          <Button
            disabled={busy}
            title="Retry"
            onPress={() => {
              void act(() => load());
            }}
          />
        </>
      )}
      {!busy &&
        screen.kind === "ready" &&
        access.current &&
        access.current() > 0 && (
          <>
            <Text>Workspace ID {screen.workspace.id}</Text>
            <Text
              accessibilityRole="header"
              style={{ fontSize: 20, fontWeight: "600" }}
            >
              {screen.workspace.personalAssistant.name}
            </Text>
            {screen.workspace.quotas && (
              <View>
                <Text accessibilityRole="header">Workspace usage</Text>
                <Text>
                  Bot runs: {screen.workspace.quotas.bot.used} /{" "}
                  {screen.workspace.quotas.bot.limit}
                </Text>
                <Text>
                  Computers:{" "}
                  {screen.workspace.quotas.computer.used ?? "Unavailable"} /{" "}
                  {screen.workspace.quotas.computer.limit}
                </Text>
                <Text>
                  Workspace storage:{" "}
                  {screen.workspace.quotas.storage.used ?? "Unavailable"} /{" "}
                  {screen.workspace.quotas.storage.limit} bytes
                </Text>
                <Text>
                  Automation triggers: {screen.workspace.quotas.automation.used}{" "}
                  / {screen.workspace.quotas.automation.limit} per minute
                </Text>
              </View>
            )}
            <Text
              accessibilityRole="header"
              style={{ fontSize: 20, fontWeight: "600" }}
            >
              Recent conversations
            </Text>
            {screen.workspace.conversations.length === 0 && (
              <Text>No conversations yet.</Text>
            )}
            {screen.workspace.conversations.map(({ id, title, preview }) => (
              <View key={id}>
                <Text style={{ fontWeight: "600" }}>{title}</Text>
                {preview ? <Text>{preview}</Text> : null}
              </View>
            ))}
          </>
        )}
      {stoppedWork.length > 0 && (
        <View style={{ gap: 12 }}>
          <Text accessibilityRole="header">Stopped work</Text>
          {stoppedWork.map((item) => (
            <View key={item.key} style={{ gap: 6 }}>
              <Text>{item.label}</Text>
              {item.summary && <Text>{item.summary}</Text>}
              {item.recordedAt && (
                <Text>{new Date(item.recordedAt).toLocaleString()}</Text>
              )}
              <Text>{item.reasonMessage}</Text>
              {item.output ? (
                <Text>Output before interruption: {item.output}</Text>
              ) : null}
              {item.outcomeUnknown && (
                <Text>
                  Check any external actions before retrying. Their outcome is
                  unknown.
                </Text>
              )}
              {item.recovery ? (
                <Text>
                  {item.recovery.action === "retry"
                    ? item.retryResult
                    : "Cancelled"}
                </Text>
              ) : (
                <>
                  {item.canRetry && (
                    <Button
                      title={item.retryText}
                      disabled={busy}
                      onPress={() => {
                        if (!item.outcomeUnknown)
                          return resolve(item.key, "retry");
                        Alert.alert(
                          "Check external actions",
                          "Confirm you checked the external actions before retrying.",
                          [
                            { text: "Back", style: "cancel" },
                            {
                              text: "I checked",
                              onPress: () => resolve(item.key, "retry", true),
                            },
                          ],
                        );
                      }}
                    />
                  )}
                  <Button
                    title="Cancel item"
                    disabled={busy}
                    onPress={() => resolve(item.key, "cancel")}
                  />
                </>
              )}
            </View>
          ))}
        </View>
      )}
      {workspace?.computer !== undefined && (
        <View>
          <Text accessibilityRole="header">Computer</Text>
          <Text>
            {computer
              ? {
                  not_started: "Ready to set up",
                  starting: "Starting",
                  running: "Running",
                  stopping: "Stopping",
                  restart_required:
                    "Stopped. Your saved files and settings are kept.",
                }[computer.status]
              : "Computer status unavailable"}
          </Text>
          {computer?.cutoff === "failed" && (
            <Text>
              Computer exit could not be confirmed by the authorization
              deadline.
            </Text>
          )}
          {computer &&
            computer.status !== "starting" &&
            computer.status !== "stopping" && (
              <Button
                title={
                  computerAction.action === "start"
                    ? "Start Computer"
                    : "Stop Computer"
                }
                disabled={busy}
                onPress={() =>
                  updateWorkspace(() => runWorkspaceAction(computerAction))
                }
              />
            )}
        </View>
      )}
      {automations.length > 0 && (
        <View style={{ gap: 12 }}>
          <Text accessibilityRole="header">Routines and inbound bindings</Text>
          {automations.map(
            ({ id, title, resource, blockedReason, enabled }) => (
              <View key={`${resource}/${id}`}>
                <Text>
                  {resource === "routines" ? "Routine" : "Inbound binding"} ·{" "}
                  {title}
                </Text>
                {blockedReason === "manual_resume_required" ? (
                  <Text>Resume this item to accept new work.</Text>
                ) : blockedReason ? (
                  <Text>Execution paused ({blockedReason}).</Text>
                ) : (
                  !enabled && <Text>Switched off</Text>
                )}
                {blockedReason === "manual_resume_required" && (
                  <Button
                    title="Resume"
                    disabled={busy}
                    onPress={() =>
                      updateWorkspace(() =>
                        runWorkspaceAction({ kind: "resume", resource, id }),
                      )
                    }
                  />
                )}
                <Button
                  title="View history"
                  disabled={busy}
                  onPress={() => showHistory(resource, id)}
                />
                {history?.workspaceId === workspace?.id &&
                  history?.key === `${resource}/${id}` &&
                  (history.runs.length > 0 ? (
                    history.runs.map((run) => (
                      <Text key={run.id}>
                        {new Date(run.timestamp).toLocaleString()} ·{" "}
                        {run.outcome}
                        {run.reason ? ` · ${run.reason}` : ""}
                      </Text>
                    ))
                  ) : (
                    <Text>No history yet.</Text>
                  ))}
              </View>
            ),
          )}
        </View>
      )}
      {workspace && workspace.invalidatedApprovals.length > 0 && (
        <View>
          <Text accessibilityRole="header">Invalidated approvals</Text>
          {workspace.invalidatedApprovals.map((item) => (
            <Text key={item.id}>{item.tool} · Invalidated</Text>
          ))}
        </View>
      )}
      {workspace && (
        <Button
          title="Export workspace data in browser"
          disabled={busy}
          onPress={() => void act(openWorkspaceExport)}
        />
      )}
      {(screen.kind === "ready" ||
        screen.kind === "workspace-error" ||
        screen.kind === "admissions-paused") && (
        <Button
          disabled={busy}
          title="Sign out"
          onPress={() => {
            void act(async () => {
              withdraw("loading");
              try {
                await signOutPersonalSaas();
                setScreen({ kind: "signed-out" });
              } catch (error) {
                withdraw("workspace-error");
                throw error;
              }
            });
          }}
        />
      )}
    </ScrollView>
  );
}
