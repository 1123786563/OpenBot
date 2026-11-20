import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Button, ScrollView, Text, View } from "react-native";
import {
  openPersonalWorkspace,
  PersonalSaasActionError,
  signInPersonalSaas,
  signOutPersonalSaas,
} from "./personal-saas";

import type { PausedWorkspace } from "./personal-saas-contract";

type Screen =
  | { kind: "loading" | "preparing" | "signed-out" }
  | {
      kind: "ready";
      workspace: NonNullable<Awaited<ReturnType<typeof openPersonalWorkspace>>>;
    }
  | { kind: "workspace-error" }
  | { kind: "paused"; status: PausedWorkspace };

export function PersonalSaasHome() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const working = useRef(false);

  const load = useCallback(async () => {
    setScreen({ kind: "loading" });
    try {
      const workspace = await openPersonalWorkspace(() =>
        setScreen({ kind: "preparing" }),
      );
      setScreen(
        workspace ? { kind: "ready", workspace } : { kind: "signed-out" },
      );
    } catch {
      setScreen({ kind: "workspace-error" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (busy || screen.kind !== "ready") return;
    let current = true;
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    const expiry = setTimeout(() => {
      current = false;
      setScreen({ kind: "workspace-error" });
    }, 45_000);
    const refresh = setTimeout(async () => {
      try {
        const workspace = await openPersonalWorkspace(() => {});
        if (current)
          setScreen(
            workspace ? { kind: "ready", workspace } : { kind: "signed-out" },
          );
      } catch {
        if (current) setScreen({ kind: "workspace-error" });
      }
    }, 5_000);
    return () => {
      current = false;
      foreground.remove();
      clearTimeout(expiry);
      clearTimeout(refresh);
    };
  }, [busy, load, screen]);

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
      {(screen.kind === "signed-out" || screen.kind === "paused") && (
        <Button
          disabled={busy}
          title={
            screen.kind === "paused" ? "Sign in again" : "Continue with Casdoor"
          }
          onPress={() => {
            void act(async () => {
              const status = await signInPersonalSaas();
              if (status) setScreen({ kind: "paused", status });
              else await load();
            });
          }}
        />
      )}
      {screen.kind === "workspace-error" && (
        <>
          <Text accessibilityRole="alert">
            Could not open your Personal Workspace.
          </Text>
          <Button
            disabled={busy}
            title="Retry"
            onPress={() => {
              void act(load);
            }}
          />
        </>
      )}
      {!busy && screen.kind === "ready" && (
        <>
          <Text>Workspace ID {screen.workspace.id}</Text>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 20, fontWeight: "600" }}
          >
            {screen.workspace.personalAssistant.name}
          </Text>
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
      {(screen.kind === "ready" || screen.kind === "workspace-error") && (
        <Button
          disabled={busy}
          title="Sign out"
          onPress={() => {
            void act(async () => {
              await signOutPersonalSaas();
              setScreen({ kind: "signed-out" });
            });
          }}
        />
      )}
    </ScrollView>
  );
}
