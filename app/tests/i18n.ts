import { act } from "react";
import { setLocalePreference, type LocalePreference } from "@/i18n";

/**
 * Switches the interface language for the rest of the test and waits for the redraw.
 *
 * Every test file in a run shares one translation instance, so a file that switches away from
 * English puts it back in `afterEach`; a file that never mentions a language gets English.
 */
export function pinLocale(preference: LocalePreference): Promise<void> {
  return act(async () => {
    await setLocalePreference(preference);
  });
}

/**
 * Stands `replacement` where the browser's storage was while `body` runs, and puts the storage back
 * however `body` ends. (Happy DOM binds each storage method to its instance at first use, so replacing
 * the prototype's methods would not reach it.)
 */
export async function withStorage(
  replacement: unknown,
  body: () => void | Promise<void>,
): Promise<void> {
  const browserStorage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: replacement,
  });
  try {
    await body();
  } finally {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => browserStorage,
    });
  }
}
