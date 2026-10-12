import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { openbotCallbackTarget, openbotEndpoint, openbotUrl } from "./config";

/**
 * Better Auth 客户端（对齐 OpenBot 自带移动端 mobile/src/auth.ts 的用法，
 * 版本 better-auth 1.7.1 + @better-auth/expo 1.7.1）。
 *
 * - web：会话走浏览器 cookie（credentials: include），存储回落 localStorage；
 * - native：无 cookie jar，会话由 expo 插件经 SecureStore 持久化，请求时
 *   以 Cookie 头显式携带（见 client.ts）。
 */

const tokenStorage =
  Platform.OS === "web"
    ? {
        getItem: (key: string) => localStorage.getItem(key),
        setItem: (key: string, value: string) => localStorage.setItem(key, value),
        getItemAsync: (key: string) => Promise.resolve(localStorage.getItem(key)),
        setItemAsync: (key: string, value: string) =>
          Promise.resolve(localStorage.setItem(key, value)),
        deleteItemAsync: (key: string) => Promise.resolve(localStorage.removeItem(key)),
      }
    : SecureStore;

export const authClient = createAuthClient({
  baseURL: openbotUrl,
  plugins: [
    expoClient({
      scheme: "openmuse",
      storagePrefix: `openmuse-openbot-${openbotEndpoint.host.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      storage: tokenStorage,
    }),
  ],
});

export { openbotUrl, openbotCallbackTarget };

/** 供 native fetch 手工携带的会话 cookie；web 返回 null（浏览器自动带）。 */
export async function sessionCookie(): Promise<string | null> {
  if (Platform.OS === "web") return null;
  try {
    return await authClient.getCookie();
  } catch {
    return null;
  }
}

export type OpenBotProviderId = "casdoor" | "google" | "microsoft" | "okta";

/** 社交登录：跳到 OpenBot 的 OAuth 页，完成后回跳 callbackTarget。 */
export async function signInSocial(provider: OpenBotProviderId): Promise<void> {
  const result = await authClient.signIn.social({
    // better-auth 1.7 的 social 联合类型不含 casdoor（generic OAuth provider），
    // 运行时按字符串透传；google/microsoft/okta 走原生类型。
    provider: provider as "google",
    callbackURL: openbotCallbackTarget,
  });
  if (result.error) throw new Error(result.error.message ?? "登录失败。");
}

/**
 * 邮箱 + 密码登录（Better Auth emailAndPassword）。
 * 面向无 OAuth 浏览器的场景；部署需 OPENBOT_EMAIL_PASSWORD=true。
 * 返回服务端原始 error 供表单分层提示（凭据错误 / 未启用 / SSO 强制）。
 */
export async function signInWithEmail(
  email: string,
  password: string,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const { data, error } = await authClient.signIn.email({ email, password });
  if (error)
    return {
      ok: false,
      reason:
        error.code === "INVALID_EMAIL_OR_PASSWORD"
          ? "邮箱或密码不正确。"
          : error.code === "EMAIL_PASSWORD_DISABLED" ||
              /not enabled/i.test(error.message ?? "")
            ? "此部署未开放邮箱密码登录，请使用下方的第三方登录。"
            : error.code === "sso_required"
              ? "此部署要求通过企业登录（SSO）。"
              : error.message?.slice(0, 120) || "登录失败，请稍后重试。",
    };
  if (!data?.user?.id) return { ok: false, reason: "登录响应异常，请重试。" };
  return { ok: true, userId: data.user.id };
}

/** 注册（邮箱 + 密码）。密码规则与 server 一致：≥8 位。 */
export async function signUpWithEmail(
  email: string,
  password: string,
  name: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { error } = await authClient.signUp.email({ email, password, name });
  if (error)
    return {
      ok: false,
      reason:
        error.code === "USER_ALREADY_EXISTS"
          ? "该邮箱已注册，请直接登录。"
          : error.code === "INVALID_PASSWORD" ||
              /at least/i.test(error.message ?? "")
            ? "密码至少 8 位。"
            : error.message?.slice(0, 120) || "注册失败，请稍后重试。",
    };
  return { ok: true };
}

/** 当前会话；未登录返回 null（不抛错，由调用方决定去向）。 */
export async function currentSession(): Promise<{ userId: string } | null> {
  const { data, error } = await authClient.getSession();
  if (error || !data?.user?.id) return null;
  return { userId: data.user.id };
}

export async function signOut(): Promise<void> {
  await authClient.signOut().catch(() => undefined);
}
