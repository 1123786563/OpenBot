import { FileText, FolderOpen, Globe2, Monitor, Plus, RefreshCw } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Image, Pressable, Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/domain/src";
import { Button, Card, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ComputerEntry() {
  const { workspace, open } = useWorkspace();
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  const active = workspace.browsers.filter((b) => b.status === "active").length;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open agent computer"
      onPress={() => open({ type: "computer" })}
      style={[
        s.row,
        {
          alignSelf: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 20,
          backgroundColor: "#F1F3F4",
        },
      ]}
    >
      <Monitor size={13} color={colors.muted} />
      <Text style={{ fontSize: 11, color: colors.muted }}>
        Computer
        {active
          ? ` · ${active} ${active === 1 ? "session" : "sessions"}`
          : available
            ? " · ready"
            : " · offline"}
      </Text>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: available ? "#57AD85" : "#ACB0B5",
        }}
      />
    </Pressable>
  );
}
export function BrowserThreadCard({ browser }: { browser: BrowserSession }) {
  const { open } = useWorkspace();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 9 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>Browser</Text>
          <Text numberOfLines={1} style={s.small}>
            {browser.status === "closed"
              ? "Session saved"
              : browser.status === "error"
                ? "Needs attention"
                : browser.title}
          </Text>
        </View>
      </View>
      {browser.previewUrl && browser.status === "active" && !failed ? (
        <Image
          accessibilityLabel={`Browser preview: ${browser.title}`}
          source={{ uri: browser.previewUrl }}
          style={{ width: "100%", aspectRatio: 1.6, borderRadius: 11, backgroundColor: "#FFF" }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: "#FFF",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Globe2 size={30} color={colors.muted} />
          <Text numberOfLines={2} style={[s.muted, { textAlign: "center" }]}>
            {failed ? "Preview unavailable. Open the browser to reconnect." : browser.url}
          </Text>
        </View>
      )}
      <Button onPress={() => open({ type: "browser", browser })}>Open browser</Button>
    </Card>
  );
}
export function ComputerSheet() {
  const { workspace, api, refresh, close, open, navigate } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"Browser" | "Files">("Browser");
  const available = workspace.connections.some(
    (c) => c.id === "browser" && c.status === "connected",
  );
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void refresh().catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", { url: url.trim() });
      await refresh();
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Agent computer"
      subtitle="A browser and files that stay with your agent."
      onClose={close}
    >
      <View style={{ gap: 20 }}>
        <View
          style={[s.row, { gap: 12, padding: 18, borderRadius: 20, backgroundColor: colors.sky }]}
        >
          <Monitor size={28} color={colors.blueDark} />
          <View style={{ flex: 1 }}>
            <Text style={s.heading}>{available ? "Computer connected" : "Computer offline"}</Text>
            <Text style={s.muted}>
              {available
                ? "Persistent Chromium sessions · shared with your agent"
                : "Start the browser worker to connect this computer."}
            </Text>
          </View>
        </View>
        <View style={[s.row, { gap: 8 }]}>
          {(["Browser", "Files"] as const).map((item) => (
            <Button
              key={item}
              primary={tab === item}
              icon={item === "Browser" ? Globe2 : FolderOpen}
              onPress={() => setTab(item)}
            >
              {item}
            </Button>
          ))}
        </View>
        <ErrorNotice error={error} />
        {tab === "Browser" ? (
          <>
            <View>
              <Field
                label="Website address"
                value={url}
                onChangeText={setUrl}
                placeholder="https://example.com"
                autoCapitalize="none"
                keyboardType="url"
                onSubmitEditing={() => void create()}
              />
              <Button
                primary
                icon={Plus}
                busy={busy}
                disabled={!available || !url.trim()}
                onPress={() => void create()}
              >
                Open a browser session
              </Button>
            </View>
            {[...workspace.browsers]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((browser) => (
                <BrowserThreadCard key={browser.id} browser={browser} />
              ))}
            {!workspace.browsers.length && (
              <Text style={s.muted}>
                Open a page here or ask your agent to research something. Its browsing sessions will
                appear here.
              </Text>
            )}
            <Text style={s.small}>
              The agent can read public pages and collect documents. Open a session to interact with
              the page yourself. This worker is a browser environment, not a full desktop virtual
              machine.
            </Text>
          </>
        ) : (
          <>
            {workspace.files.map((file) => (
              <LinkRow
                key={file.id}
                icon={FileText}
                title={file.name}
                detail={`${file.pageCount} pages · PDF`}
                onPress={() => open({ type: "file", file })}
              />
            ))}
            <Button
              icon={Plus}
              onPress={() => {
                close();
                navigate("files");
              }}
            >
              Import a document
            </Button>
          </>
        )}
        <Button
          small
          icon={RefreshCw}
          onPress={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(String(e)))
          }
        >
          Refresh computer
        </Button>
      </View>
    </Sheet>
  );
}
