/**
 * The refusal a person can act on: an app this call needed, that they have not connected.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the same reason `./handoff-markers.ts` sets out. A tool
 * that runs on the server reaches the transcript as text meant for a model, so a renderer can only
 * tell this refusal from the others by its wording — and a wording that lives in two files is a
 * contract that drifts. The server builds the sentence here and the transcript reads it here.
 *
 * WHY IT IS WORTH TELLING APART AT ALL. "Connect it in Settings and ask again" is a correct sentence
 * and a bad one to end on: it describes a screen somewhere else, in the middle of a conversation the
 * person is having now, about an app the Bot was holding a tool for all along. What they need is the
 * thing itself, where they are reading — which is what the marker lets the transcript put there.
 *
 * WHAT THE CODEC DOES NOT DO. It produces display data and nothing else. Its answer is never a
 * permission, an authorization or a navigation instruction: only a refusal the server itself wrote
 * parses back, and the connect endpoint re-checks who is asking and what they may connect however
 * the card got drawn. A tool result that merely contains the marker — a vendor's own text can be
 * written to look like anything — is not a refusal this deployment wrote, and answers null.
 */

/** The first characters of the refusal, immediately followed by its JSON. */
export const CONNECT_APP_MARKER = "[connect-app]";

export type ConnectPrompt = {
  /** The plugin server to connect, as `POST /api/plugins/servers/:serverId/connect` names it. */
  serverId: string;
  /** The app's own name, for a card that says what it is asking for. */
  title: string;
  /** What the Bot would have said, kept intact for a reader with no card to draw. */
  message: string;
};

/**
 * The bounds the payload rides inside.
 *
 * A marker refusal travels as tool-result text, into the transcript, the message store and the
 * capped `failure` field of an audit row, so neither side accepts an unbounded one. The reader turns
 * any field past its bound, and any payload past the total cap, into null — a truncated card would
 * name an app nobody finished naming. The writer clamps to the same bounds first, so everything the
 * server emits is something the reader accepts: a refusal that silently drew no card would be the
 * feature failing in exactly the way the bounds exist to make impossible.
 */
const SERVER_ID_MAX = 256;
const TITLE_MAX = 200;
const MESSAGE_MAX = 4_000;
const PAYLOAD_MAX = 8_192;

/**
 * Shortened to `max` code units, never through the middle of a surrogate pair.
 *
 * A string sliced in half by code units can strand half an Astral-plane character, and a lone
 * surrogate survives `JSON.stringify` only as U+FFFD — a title that round-tripped as a different
 * title. Backing off one unit keeps what the reader gets equal to what the writer meant.
 */
function clamped(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  const next = text.charCodeAt(cut.length);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return cut.slice(0, -1);
  }
  return cut;
}

/**
 * The refusal text a `PluginRefusedError` carries for an app the asker has not connected.
 *
 * The sentence stays in the string rather than being rebuilt by the card, because it is also what
 * the MODEL is told, and because a transcript that cannot parse the marker still reads correctly.
 *
 * The fields are clamped before encoding, so the roundtrip below holds for whatever a caller passes:
 * the wire shape is the marker, then the JSON for the two fields a card needs, then the sentence.
 */
export function connectAppRefusal(prompt: ConnectPrompt): string {
  const serverId = clamped(prompt.serverId, SERVER_ID_MAX);
  const title = clamped(prompt.title, TITLE_MAX);
  // Trimmed because the reader trims; anything else would make the roundtrip lose padding.
  const message = prompt.message.trim();
  const json = JSON.stringify({ serverId, title });
  // The payload is everything after the marker: the JSON, one space, the message. The message is
  // the only part with room to give, so it is what shrinks when escape inflation pushes a
  // well-formed payload toward the cap.
  const budget = Math.max(
    0,
    Math.min(MESSAGE_MAX, PAYLOAD_MAX - json.length - 1),
  );
  return `${CONNECT_APP_MARKER}${json} ${clamped(message, budget)}`;
}

/**
 * Where the JSON object ends, or null when nothing on the wire closes it.
 *
 * THE FIRST `}` IS NOT THE END, and taking it was the defect that made a title holding a closing
 * brace swallow its own card: the brace inside a JSON string literal is data, not structure. This
 * walks the payload respecting string literals and their escapes and returns the brace that actually
 * balances the object the payload opens with.
 */
function objectEnd(payload: string): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

/**
 * The prompt inside a refusal, or null for any other text.
 *
 * Fails to null on anything it does not fully recognise — a payload past its cap, JSON that is not
 * an object, a field of the wrong type or past its bound, JSON cut off before it closes. A card
 * drawn from a half-read refusal would offer to connect something nobody named, so every one of
 * those is the same answer as "this is not a connect refusal".
 */
export function readConnectPrompt(
  text: string | undefined | null,
): ConnectPrompt | null {
  if (!text?.startsWith(CONNECT_APP_MARKER)) return null;
  const payload = text.slice(CONNECT_APP_MARKER.length);
  if (payload.length > PAYLOAD_MAX) return null;
  // The writer opens with the object and no whitespace; anything else was not written here.
  if (!payload.startsWith("{")) return null;
  const end = objectEnd(payload);
  if (end === null) return null;
  try {
    const parsed: unknown = JSON.parse(payload.slice(0, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const { serverId, title } = parsed as {
      serverId?: unknown;
      title?: unknown;
    };
    if (typeof serverId !== "string" || typeof title !== "string") return null;
    if (serverId.length < 1 || serverId.length > SERVER_ID_MAX) return null;
    if (title.length < 1 || title.length > TITLE_MAX) return null;
    const message = payload.slice(end + 1).trim();
    if (message.length > MESSAGE_MAX) return null;
    return { serverId, title, message };
  } catch {
    return null;
  }
}
