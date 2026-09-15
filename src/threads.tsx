import { useThreads } from "@copilotkit/react-native/headless";
import {
  Archive,
  CalendarDays,
  FileText,
  MessageCircle,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react-native";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Button, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function newThreadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
type Selection = { id: string; existing: boolean };
const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  select: (selection: Selection) => void;
  start: () => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { workspace, navigate } = useWorkspace();
  const handledPrompt = useRef(0);
  const [selection, setSelection] = useState<Selection>(() => ({
    id: newThreadId(),
    existing: false,
  }));
  function select(next: Selection) {
    setSelection(next);
    navigate("chat");
  }
  return (
    <ThreadContext.Provider
      value={{
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        enabled: workspace.runtime.richThreads === true,
        selection,
        select,
        start: () => select({ id: newThreadId(), existing: false }),
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}
export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("Threads provider is unavailable");
  return context;
}
export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const { enabled, selection, select, start } = useMuseThread();
  const { workspace, open, navigate, refresh } = useWorkspace();
  const threads = useThreads({ agentId: "default", enabled, includeArchived: true, limit: 20 });
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);
  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function go(section: "calendar" | "files" | "apps") {
    onClose();
    navigate(section);
  }
  return (
    <Sheet
      title="OpenMuse"
      subtitle={workspace.mode === "sample" ? "Your workspace" : workspace.profile.name}
      onClose={onClose}
    >
      <View style={{ gap: 14 }}>
        {enabled ? (
          <>
            <Button
              primary
              icon={Plus}
              onPress={() => {
                start();
                onClose();
              }}
            >
              New conversation
            </Button>
            <View style={[s.between, { marginTop: 12 }]}>
              <Text style={s.heading}>Conversations</Text>
              <Button small onPress={() => setArchived(!archived)}>
                {archived ? "Show active" : "Archived"}
              </Button>
            </View>
            {threads.isLoading && <ActivityIndicator color={colors.blueDark} />}
            <ErrorNotice error={error || threads.error?.message} />
            {threads.error && (
              <Button small onPress={threads.refetchThreads}>
                Retry conversations
              </Button>
            )}
            {threads.threads
              .filter((thread) => thread.archived === archived)
              .map((thread) => (
                <View
                  key={thread.id}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                    gap: 10,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open conversation: ${thread.name || "Untitled conversation"}`}
                    accessibilityState={{ selected: selection.id === thread.id }}
                    onPress={() => {
                      select({ id: thread.id, existing: true });
                      onClose();
                    }}
                    style={[s.row, { gap: 10 }]}
                  >
                    <MessageCircle size={19} color={colors.text} />
                    <Text style={[s.text, { flex: 1 }]}>
                      {thread.name || "Untitled conversation"}
                    </Text>
                  </Pressable>
                  {editing === thread.id && (
                    <Field label="Conversation name" value={name} onChangeText={setName} />
                  )}
                  <View style={[s.row, { gap: 8 }]}>
                    <Button
                      small
                      disabled={threads.isMutating || (editing === thread.id && !name.trim())}
                      onPress={() => {
                        if (editing === thread.id)
                          void mutate(() => threads.renameThread(thread.id, name.trim()));
                        else {
                          setEditing(thread.id);
                          setName(thread.name || "");
                        }
                      }}
                    >
                      {editing === thread.id ? "Save name" : "Rename"}
                    </Button>
                    <Button
                      small
                      icon={Archive}
                      disabled={threads.isMutating}
                      onPress={() =>
                        void mutate(() =>
                          thread.archived
                            ? threads.unarchiveThread(thread.id)
                            : threads.archiveThread(thread.id),
                        )
                      }
                    >
                      {thread.archived ? "Restore" : "Archive"}
                    </Button>
                  </View>
                </View>
              ))}
            {!threads.isLoading &&
              !threads.error &&
              !threads.threads.some((thread) => thread.archived === archived) && (
                <Text style={s.muted}>
                  {archived
                    ? "No archived conversations."
                    : "Your conversations will appear after your first message."}
                </Text>
              )}
            <ErrorNotice error={threads.fetchMoreError?.message} />
            {threads.hasMoreThreads && (
              <Button small busy={threads.isFetchingMoreThreads} onPress={threads.fetchMoreThreads}>
                Load more conversations
              </Button>
            )}
            <Text style={s.small}>
              Rich Threads by CopilotKit · conversation, tool activity and state saved together.
            </Text>
          </>
        ) : (
          <>
            <LinkRow
              icon={MessageCircle}
              title="Your conversation"
              detail="Saved in this workspace"
              onPress={() => {
                navigate("chat");
                onClose();
              }}
            />
            <Text style={s.muted}>
              Your conversation is saved in this workspace. You can manage connections in Apps.
            </Text>
          </>
        )}
        <View style={s.divider} />
        <LinkRow
          icon={Plus}
          title="Delegate task"
          detail="A plan, document, or spending summary"
          onPress={() => {
            onClose();
            open({ type: "delegate" });
          }}
        />
        <LinkRow
          icon={Monitor}
          title="Agent computer"
          detail="Browser, sessions and documents"
          onPress={() => {
            onClose();
            open({ type: "computer" });
          }}
        />
        <LinkRow icon={CalendarDays} title="Calendar" onPress={() => go("calendar")} />
        <LinkRow icon={FileText} title="Files" onPress={() => go("files")} />
        <LinkRow icon={Settings2} title="Apps & settings" onPress={() => go("apps")} />
        <Button small icon={RefreshCw} onPress={() => void mutate(refresh)}>
          Refresh workspace
        </Button>
      </View>
    </Sheet>
  );
}
