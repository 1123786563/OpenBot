/**
 * Auto-generation of human-readable craft-session names — ported from onyx
 * `session/naming.py`.
 *
 * Given a session, pull its first user message and ask the configured LLM to condense it into
 * a short label. Falls back deterministically ("Craft Session <prefix>") when anything goes
 * wrong. The LLM call is injected (`generateName`): onyx reaches for the platform default LLM;
 * here the caller wires whatever one-shot generate the deployment already has (Intelligence),
 * or omits it entirely to always take the fallback.
 */

import type { Database } from "../db/client";
import type { CraftStore } from "./store";

export const MAX_NAME_LENGTH = 50;
const MAX_PROMPT_INPUT_CHARS = 500;

const NAMING_SYSTEM_PROMPT =
  "Given the user's build request, provide a SHORT name for the build " +
  "session. Focus on the main task or goal the user wants to accomplish.\n" +
  "\n" +
  "IMPORTANT: DO NOT OUTPUT ANYTHING ASIDE FROM THE NAME. MAKE IT AS " +
  "CONCISE AS POSSIBLE. NEVER USE MORE THAN 5 WORDS, LESS IS FINE.";

const NAMING_USER_PROMPT =
  "User's request: {user_message}\n\nProvide a short name for this build session.";

const fallbackName = (sessionId: string): string =>
  `Craft Session ${sessionId.slice(0, 8)}`;

/** Pull the user-message text out of a message's metadata packet. */
function extractText(metadata: unknown): string {
  if (!(metadata instanceof Object)) return "";
  const content = (metadata as Record<string, unknown>).content;
  if (content instanceof Object) {
    const text = (content as Record<string, unknown>).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

/** The text of the first USER message, or null when there is none. */
export async function firstUserMessageText(
  _db: Database,
  store: CraftStore,
  sessionId: string,
): Promise<string | null> {
  const messages = await store.getMessages(sessionId);
  const firstUser = messages.find((message) => message.type === "user");
  if (!firstUser) return null;
  const text = extractText(firstUser.messageMetadata);
  return text || null;
}

export type NamingDeps = {
  db: Database;
  store: CraftStore;
  /**
   * One-shot generation (system + user → text). Omit to always take the deterministic
   * fallback — the naming path must never break a session.
   */
  generateName?: (system: string, user: string) => Promise<string>;
};

/**
 * Ask the LLM for a concise label based on the first user message. Always resolves a
 * non-empty string. Fallback order: LLM name (≤50 chars) → first-message text (≤40 chars) →
 * "Craft Session <prefix>".
 */
export async function generateSessionName(
  deps: NamingDeps,
  sessionId: string,
): Promise<string> {
  // The naming path must never break a session: a failed message read (a store error,
  // a database hiccup) takes the fallback exactly like an empty thread would.
  const userMessage = await firstUserMessageText(
    deps.db,
    deps.store,
    sessionId,
  ).catch(() => null);
  if (!userMessage) return fallbackName(sessionId);

  if (deps.generateName) {
    try {
      const generated = (
        await deps.generateName(
          NAMING_SYSTEM_PROMPT,
          // The replacer function keeps `$&`/`$'` in the user's words literal.
          NAMING_USER_PROMPT.replace(
            "{user_message}",
            () => userMessage.slice(0, MAX_PROMPT_INPUT_CHARS),
          ),
        )
      )
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^"|"$/g, "");
      if (!generated) return fallbackName(sessionId);
      if (generated.length > MAX_NAME_LENGTH) {
        return `${generated.slice(0, MAX_NAME_LENGTH - 3)}...`;
      }
      return generated;
    } catch {
      // Fall through to the deterministic fallbacks.
    }
  }

  const truncated = userMessage.slice(0, 40).trim();
  return truncated + (userMessage.length > 40 ? "..." : "");
}
