import { fromByteArray } from "base64-js";
import { fetch } from "expo/fetch";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { openAuthSessionAsync } from "expo-web-browser";
import { Linking, Platform } from "react-native";
import { serverUrl } from "./auth";
import {
  nativeExchange,
  parsePersonalSaasCallback,
  personalConversationHistory,
  personalSaasCallbackUrl,
  personalWorkspace,
  workspaceAccessMs,
} from "./personal-saas-contract";

const sessionKey = `openbot-personal-${Array.from(serverUrl, (char) => char.charCodeAt(0).toString(16)).join("")}`;
const keyOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export class PersonalSaasActionError extends Error {}

function base64url(base64: string) {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function request(path: string, init?: Parameters<typeof fetch>[1]) {
  if (!serverUrl.startsWith("https://"))
    throw new PersonalSaasActionError(
      "Personal SaaS requires an HTTPS deployment URL.",
    );
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-cache, no-store");
  return fetch(new URL(path, serverUrl), {
    ...init,
    credentials: "omit",
    headers,
    redirect: "error",
  });
}

export async function openWorkspaceClosure() {
  if (!serverUrl.startsWith("https://"))
    throw new PersonalSaasActionError(
      "Personal SaaS requires an HTTPS deployment URL.",
    );
  await Linking.openURL(new URL("/auth/closure/start", serverUrl).href);
}

export async function signInPersonalSaas() {
  const client = Platform.OS;
  if (client !== "ios" && client !== "android")
    throw new PersonalSaasActionError(
      "Personal SaaS mobile sign-in requires iOS or Android.",
    );
  if (!serverUrl.startsWith("https://"))
    throw new PersonalSaasActionError(
      "Personal SaaS requires an HTTPS deployment URL.",
    );
  const verifier = base64url(
    fromByteArray(await Crypto.getRandomBytesAsync(32)),
  );
  const state = base64url(fromByteArray(await Crypto.getRandomBytesAsync(32)));
  const challenge = base64url(
    await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      verifier,
      {
        encoding: Crypto.CryptoEncoding.BASE64,
      },
    ),
  );
  const url = new URL("/auth/native/start", serverUrl);
  url.search = new URLSearchParams({
    client,
    state,
    code_challenge: challenge,
  }).toString();
  const handoff = await openAuthSessionAsync(url.href, personalSaasCallbackUrl);
  if (handoff.type !== "success")
    throw new PersonalSaasActionError("Sign-in did not finish. Try again.");
  const result = parsePersonalSaasCallback(handoff.url, state);
  if (result.kind === "error") {
    switch (result.error) {
      case "email_unverified":
        throw new PersonalSaasActionError(
          "Verify your email in Casdoor, then try again.",
        );
      case "account_unavailable":
        throw new PersonalSaasActionError(
          "Casdoor could not confirm that your account is active.",
        );
      case "sign_in_incomplete":
        throw new PersonalSaasActionError("Sign-in did not finish. Try again.");
    }
  }
  if (result.kind !== "code")
    throw new PersonalSaasActionError(
      "Could not confirm the sign-in callback. Try again.",
    );
  const reply = await request("/api/auth/native/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client,
      state,
      code: result.code,
      code_verifier: verifier,
    }),
  });
  if (!reply.ok)
    throw new PersonalSaasActionError("Sign-in did not finish. Try again.");
  const session = nativeExchange.parse(await reply.json());
  if ("status" in session) {
    await clearSession();
    return session;
  }
  await SecureStore.setItemAsync(sessionKey, session.token, keyOptions);
}

async function clearSession(expected?: string) {
  if (
    expected &&
    (await SecureStore.getItemAsync(sessionKey, keyOptions)) !== expected
  )
    return;
  await SecureStore.deleteItemAsync(sessionKey, keyOptions);
}

export async function openPersonalWorkspace(onPreparing: () => void) {
  const token = await SecureStore.getItemAsync(sessionKey, keyOptions);
  if (!token) return null;
  const headers = { authorization: `Bearer ${token}` };
  let reply = await request("/api/workspace", { headers });
  if (reply.status === 202) {
    onPreparing();
    reply = await request("/workspace/prepare", { method: "POST", headers });
    if (reply.status === 204)
      reply = await request("/api/workspace", { headers });
  }
  if (reply.status === 401) {
    await clearSession(token);
    return null;
  }
  if (reply.status !== 200)
    throw new PersonalSaasActionError(
      "Could not open your Personal Workspace. Try again.",
    );
  const workspace = personalWorkspace.parse(await reply.json());
  const workspaceAccess = workspaceAccessMs.parse(
    reply.headers.get("OpenBot-Access-Ms"),
  );
  const history = await request("/api/workspace/conversations", { headers });
  if (history.status === 401) {
    await clearSession(token);
    return null;
  }
  if (history.status !== 200)
    throw new PersonalSaasActionError(
      "Could not load your conversation history. Try again.",
    );
  return {
    ...workspace,
    ...personalConversationHistory.parse(await history.json()),
    accessMs: Math.min(
      workspaceAccess,
      workspaceAccessMs.parse(history.headers.get("OpenBot-Access-Ms")),
    ),
  };
}

export async function signOutPersonalSaas() {
  const token = await SecureStore.getItemAsync(sessionKey, keyOptions);
  if (token) {
    const reply = await request("/auth/sign-out", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (reply.status !== 204)
      throw new PersonalSaasActionError("Could not sign out. Try again.");
  }
  await clearSession();
}

export async function recoverPersonalWork(
  key: string,
  action: "cancel" | "retry",
  acknowledged = false,
) {
  const token = await SecureStore.getItemAsync(sessionKey, keyOptions);
  if (!token)
    throw new PersonalSaasActionError("Sign in to manage stopped work.");
  const reply = await request(
    `/api/workspace/recovery/${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action, acknowledged }),
    },
  );
  if (reply.status === 429)
    throw new PersonalSaasActionError(
      "Your workspace has reached its Bot run limit.",
    );
  if (!reply.ok)
    throw new PersonalSaasActionError(
      "Could not update stopped work. Try again.",
    );
}
