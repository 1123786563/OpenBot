import { expoClient } from "@better-auth/expo/client";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

// expo-secure-store has no web implementation; localStorage offers the same
// key/value semantics for the browser bundle.
const tokenStorage =
  Platform.OS === "web"
    ? {
        getItem: (key: string) => localStorage.getItem(key),
        setItem: (key: string, value: string) =>
          localStorage.setItem(key, value),
        getItemAsync: (key: string) =>
          Promise.resolve(localStorage.getItem(key)),
        setItemAsync: (key: string, value: string) =>
          Promise.resolve(localStorage.setItem(key, value)),
        deleteItemAsync: (key: string) =>
          Promise.resolve(localStorage.removeItem(key)),
      }
    : SecureStore;

const configured = process.env.EXPO_PUBLIC_SERVER_URL;
if (!configured)
  throw new Error(
    "Set EXPO_PUBLIC_SERVER_URL to your OpenBot deployment before building the native app.",
  );
const endpoint = new URL(configured);
// The server registers its OAuth callback on localhost, and browser cookies are
// per-hostname: a page talking to 127.0.0.1 would lose the callback's session
// state (state_mismatch). Browsers treat both loopback names as this machine,
// so the web build normalises to match the callback domain.
if (Platform.OS === "web" && endpoint.hostname === "127.0.0.1")
  endpoint.hostname = "localhost";
if (
  endpoint.protocol !== "https:" &&
  !(__DEV__ && endpoint.protocol === "http:")
)
  throw new Error("OpenBot native sign-in requires HTTPS.");
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error(
    "Use the public deployment URL without credentials or query parameters.",
  );
export const serverUrl = endpoint.origin;
export const authClient = createAuthClient({
  baseURL: serverUrl,
  plugins: [
    expoClient({
      scheme: "openbotmobile",
      storagePrefix: `openbot-${endpoint.host.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      storage: tokenStorage,
    }),
    ssoClient(),
  ],
});
// The native app returns through its URL scheme; the browser must return to
// this origin, which the server already trusts via TRUSTED_ORIGINS.
const callbackTarget =
  Platform.OS === "web" ? window.location.origin : "openbotmobile://";
export async function signIn(provider: "google" | "microsoft" | "okta") {
  const result = await authClient.signIn.social({
    provider: provider as "google",
    callbackURL: callbackTarget,
  });
  if (result.error)
    throw new Error(result.error.message ?? "Could not sign in.");
}
export async function signInEnterprise(email: string) {
  const result = await authClient.signIn.sso({
    email,
    callbackURL: callbackTarget,
  });
  if (result.error)
    throw new Error(
      result.error.message ?? "Could not sign in to your organization.",
    );
}
