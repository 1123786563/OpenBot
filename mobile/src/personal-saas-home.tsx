import { useCallback, useEffect, useRef, useState } from "react";
import { Button, ScrollView, Text, View } from "react-native";
import {
  openPersonalWorkspace,
  PersonalSaasActionError,
  signInPersonalSaas,
  signOutPersonalSaas,
} from "./personal-saas";

type Screen =
  | { kind: "loading" | "preparing" | "signed-out" }
  | {
      kind: "ready";
      workspace: NonNullable<Awaited<ReturnType<typeof openPersonalWorkspace>>>;
    }
  | { kind: "workspace-error" };

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
      {screen.kind === "signed-out" && (
        <Button
          disabled={busy}
          title="Continue with Casdoor"
          onPress={() => {
            void act(async () => {
              await signInPersonalSaas();
              await load();
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
      {screen.kind === "ready" && (
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
