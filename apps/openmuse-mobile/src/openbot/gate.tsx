import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fetchMe, fetchWorkspace } from "./api";
import { authClient, currentSession, sessionCookie, signInSocial, signOut } from "./auth";
import { openbotUrl } from "./config";
import { isAuthFailure, OpenBotError } from "./errors";
import type { OpenBotWorkspace } from "./types";
import { Button, Card, colors, ErrorNotice, Mascot, s } from "../ui";
import { EmailSignInForm } from "./email-signin";

export type OpenBotProviderId = "casdoor" | "google" | "microsoft" | "okta";

const providerLabels: Record<OpenBotProviderId, string> = {
  casdoor: "使用 Casdoor 账号继续",
  google: "使用 Google 继续",
  microsoft: "使用 Microsoft 继续",
  okta: "使用 Okta（企业邮箱）继续",
};

/** 部署实际启用的 provider（EXPO_PUBLIC_OPENBOT_PROVIDERS 覆盖，默认 casdoor）。 */
const providers = (
  process.env.EXPO_PUBLIC_OPENBOT_PROVIDERS?.trim() || "casdoor"
)
  .split(",")
  .map((item: string) => item.trim())
  .filter(Boolean) as OpenBotProviderId[];

/**
 * OpenBot 登录门 + 工作区加载（设计文档 §5.2 新登录链）：
 *
 *   检查 Better Auth 会话 → /api/me 验证 → /api/mobile/workspace 冷启动
 *
 * 未登录时展示社交登录（Google/Microsoft/Okta，经 OpenBot OAuth）；
 * 会话存在则直接进入。401 一律回到登录页（清除本地会话）。
 * 完成后把 OpenBotWorkspace 交给 children——由 App.tsx 适配为现有
 * WorkspaceContext 数据源。
 */
export function OpenBotGate({
  onReady,
}: {
  onReady: (workspace: OpenBotWorkspace) => void;
}) {
  const [phase, setPhase] = useState<"checking" | "signin" | "loading">("checking");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setPhase("checking");
    setError("");
    try {
      const session = await currentSession();
      if (!session) {
        setPhase("signin");
        return;
      }
      // me 是会话真实性的最终裁决：本地有会话记录但服务端 401 时清空重登。
      await fetchMe();
      setPhase("loading");
      const workspace = await fetchWorkspace();
      onReady(workspace);
    } catch (e) {
      if (isAuthFailure(e)) {
        await signOut();
        setPhase("signin");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase("signin");
    }
  }, [onReady]);

  useEffect(() => {
    void load();
  }, [load]);

  if (phase === "checking" || phase === "loading") {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: colors.canvas,
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
        }}
      >
        <Mascot size={64} />
        <ActivityIndicator color={colors.blueDark} />
        <Text style={s.muted}>
          {phase === "checking" ? "正在检查登录状态…" : "正在打开你的 OpenBot 工作区…"}
        </Text>
        <ErrorNotice error={error} />
        {!!error && (
          <Button small onPress={() => void load()}>
            重试
          </Button>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: colors.canvas,
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
      }}
    >
      <View style={{ width: "100%", maxWidth: 420, gap: 20, alignItems: "center" }}>
        <Mascot size={72} />
        <Text style={{ fontSize: 30, color: colors.text, letterSpacing: -1, fontWeight: "500" }}>
          欢迎使用 OpenMuse。
        </Text>
        <Text style={[s.muted, { textAlign: "center" }]}>
          由 OpenBot 驱动。请使用你的 OpenBot 账号登录。
        </Text>
        <EmailSignInForm onSignedIn={() => void load()} />
        {providers.length > 0 && (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", width: "100%", gap: 10 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
              <Text style={s.small}>或</Text>
              <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
            </View>
            <Card style={{ width: "100%", gap: 10 }}>
              <ErrorNotice error={error} />
              {providers.map((provider) => (
                <Button
                  key={provider}
                  onPress={() =>
                    void signInSocial(provider).catch((e) =>
                      setError(e instanceof Error ? e.message : String(e)),
                    )
                  }
                >
                  {providerLabels[provider]}
                </Button>
              ))}
              <Text style={[s.small, { marginTop: 6 }]}>
                登录将跳转至 {openbotUrl} 完成认证，随后自动返回。
              </Text>
            </Card>
          </>
        )}
        <Pressable onPress={() => void load()}>
          <Text style={[s.small, { color: colors.blueDark }]}>我已在外部完成登录，刷新会话</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/**
 * 把 OpenBotWorkspace 适配为现有 UI 期望的最小 Workspace 形状。
 * OpenBot 没有的域（邮件/日历/文件）以空集呈现，界面自然显示空态文案，
 * 不伪造数据。后续按能力开关逐步接通。
 */
export function toMuseWorkspace(snapshot: OpenBotWorkspace, selfId: string): WorkspaceShim {
  return {
    mode: "live" as const,
    profile: { name: "OpenBot", email: "" },
    runtime: { richThreads: false, configured: true },
    connections: snapshot.agents.map((agent) => ({
      id: agent.id,
      label: agent.name,
      status: "available" as const,
      href: "",
    })),
    agents: snapshot.agents,
    channels: snapshot.channels,
    selfId,
  };
}

/** 最小形状声明：只声明本 App 实际读取的字段，避免复制整份 domain 类型。 */
export interface WorkspaceShim {
  mode: "live";
  profile: { name: string; email: string };
  runtime: { richThreads: false; configured: true };
  connections: { id: string; label: string; status: "available"; href: string }[];
  agents: OpenBotWorkspace["agents"];
  channels: OpenBotWorkspace["channels"];
  selfId: string;
}

/** 供 Runtime 请求手工带 cookie 的辅助（native 下 CopilotKit headers）。 */
export async function runtimeHeaders(): Promise<Record<string, string>> {
  const cookie = await sessionCookie();
  return cookie ? { Cookie: cookie } : {};
}

export { OpenBotError };
