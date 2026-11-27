/**
 * The OpenBot release this app was built from, and the header that names it on every request to OpenBot.
 *
 * The build records the repository version through app.config.ts in `extra.openbotRelease`. Expo's own app
 * version is the store version.
 */
import Constants from "expo-constants";
import { CLIENT_HEADER, clientToken, isVersion } from "./client-version";

const built = (Constants.expoConfig?.extra as { openbotRelease?: unknown })
  ?.openbotRelease;

/** Undefined only for a build whose config was not read from this repository; such a build names no release. */
export const RELEASE: string | undefined = isVersion(built) ? built : undefined;

/** `OpenBot-Client: mobile/<release>`, for every request this app sends to OpenBot. */
export function clientHeaders(): Record<string, string> {
  return RELEASE ? { [CLIENT_HEADER]: clientToken("mobile", RELEASE) } : {};
}
