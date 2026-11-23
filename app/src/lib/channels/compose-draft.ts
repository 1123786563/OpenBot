import { z } from "zod";

export const draftSegments = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({
      type: z.literal("chip"),
      trigger: z.string(),
      value: z.string(),
      displayText: z.string(),
      autoResolved: z.boolean().optional(),
    }),
  ]),
);

// Storage can be denied while the app is running. Keep the latest draft for
// in-app navigation, including deletions that the browser couldn't save.
const temporaryDrafts = new Map<string, unknown>();

export function composeDraftKey(
  owner: string | undefined,
  entry: string,
  field: "message" | "recipients" | "model" | "submission",
) {
  return (
    owner && `openbot:compose:${encodeURIComponent(owner)}:${entry}:${field}`
  );
}

export function readComposeDraft<T>(
  key: string | undefined,
  schema: z.ZodType<T>,
) {
  if (!key) return undefined;
  if (temporaryDrafts.has(key)) {
    const parsed = schema.safeParse(temporaryDrafts.get(key));
    return parsed.success ? parsed.data : undefined;
  }
  try {
    const saved = sessionStorage.getItem(key);
    if (saved === null) return undefined;
    const parsed = schema.safeParse(JSON.parse(saved));
    if (parsed.success) return parsed.data;
  } catch {
    // A damaged record or unavailable storage leaves the editor usable.
  }
}

export function writeComposeDraft(key: string | undefined, value?: unknown) {
  if (!key) return false;
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
    temporaryDrafts.delete(key);
    return true;
  } catch {
    temporaryDrafts.set(key, value);
    return false;
  }
}
