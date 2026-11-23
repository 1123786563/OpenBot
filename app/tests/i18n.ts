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
