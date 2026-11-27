import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
// The upstream release of this mobile client when built in the fork checkout.
const openbotRelease = "1.2.1";
const config: ExpoConfig = {
  name: "OpenBot",
  slug: "openbot",
  version: "0.0.1",
  scheme: "openbotmobile",
  ios: { bundleIdentifier: "ai.openbot.mobile", supportsTablet: true },
  android: { package: "ai.openbot.mobile" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "openbot" }],
    // Back from linking the company account after the process died mid-sign-in: no Custom Tab left below Home.
    "./plugins/linked-cold-start",
  ],
  extra: { openbotRelease, ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
