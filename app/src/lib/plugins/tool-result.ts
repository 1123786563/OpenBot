/**
 * What the server puts in front of a refused call's reason.
 *
 * Written out here rather than imported, because this crosses a network: the server's copy travels
 * in a tool result and this one reads it, the same way a status code is declared at both ends. It
 * must match `REFUSAL_MARKER` in `server/src/plugins/tools.ts`.
 *
 * The alternative is guessing a refusal from its wording, which breaks the first time an
 * administrator rephrases a policy message, and fails silently by drawing a refusal as a result.
 */
import { refusalBody as stripRefusal } from "@openbot/shared/connect-prompt";

export const REFUSAL_MARKER = "Refused.";

/**
 * The tool's own answer, out of whatever the transcript is carrying it in.
 *
 * A tool returns a string and the runtime puts it in a message as JSON, so what arrives here is that
 * string encoded: quotes around the whole thing, and every quote inside it escaped. Drawn as-is, a
 * refusal reads `"This deployment's policy does not allow that: ... the rule \"mcp.server ...`, with
 * the escapes on screen.
 *
 * It also breaks more than the look. `REFUSAL_MARKER` is matched against the start of this text, and
 * an encoded string starts with a quote, so a refusal is drawn as an ordinary result: the one thing
 * the marker exists to prevent.
 *
 * Only a JSON string is unwrapped. An object or an array is a vendor's envelope, which is
 * {@link forDisplay}'s job, and anything that is not JSON at all is already what it says.
 */
export function asText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('"')) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
}

/**
 * A result's refusal and its answer, read from one decode of the envelope.
 *
 * Every reader of a completed result asks both questions of it — is this a refusal, and what is
 * the text it carries — and asking them as two calls read the envelope twice: the strip decoded it
 * once to answer null, and the caller decoded it again for the body that verdict left behind.
 * During a streaming reply every fold re-runs this for every step on every frame, so the second
 * read was the very parse-per-frame cost the fold's verdict cache exists to cap. One call now, one
 * decode, both answers.
 */
export function refusalAndAnswer(result: string | undefined): {
  refusal: string | null;
  answer: string | undefined;
} {
  if (result === undefined) return { refusal: null, answer: undefined };
  const answer = asText(result);
  return { refusal: stripRefusal(answer, REFUSAL_MARKER), answer };
}

/**
 * The human-readable body of a server refusal, or null for any other result.
 *
 * ONE STRIP, EVERY READER. A refused tool result reaches the transcript wearing an envelope — the
 * JSON encoding the runtime adds for the model, `REFUSAL_MARKER` in front, the reason after it —
 * and several readers ask the same shape of question of it: whether the fold may hide it, what the
 * card it carries says, what a step's disclosure shows. Each used to decode and strip by hand, and
 * hands drift — a fold that judges one way while a card reads another would hide a question the
 * person has to answer, or draw a line where a card belongs. This is the one sequence (`asText`,
 * then the marker, then the trim) all of them read.
 *
 * Fail-closed the same way {@link readConnectPrompt} is: anything that does not start with the
 * marker once decoded — a plain result, or a vendor's sentence that merely contains it — answers
 * null, so only a refusal this deployment wrote is ever read as one.
 *
 * The strip sequence itself is the connect codec's own parameterised copy (`refusalBody` in
 * `shared/connect-prompt.ts`, where each caller passes the marker its side of the wire declared):
 * this is the app's entry point to it — `asText`, then the strip — so there is exactly one
 * sequence in the codebase for a reader to drift from, not two.
 */
export function refusalBody(result: string | undefined): string | null {
  return refusalAndAnswer(result).refusal;
}

/**
 * Whether a result's first characters could open a refusal this server wrote.
 *
 * THE FOLD'S FAST PATH READS THIS before its cache or a parse is ever consulted, and the check
 * lives here — beside the {@link refusalBody} strip it fronts for — so the gate and the strip
 * answer from one declaration of the shapes a refusal arrives in, instead of the call site
 * restating the rule and the two drifting apart. A refusal can only wear two shapes: the marker
 * itself, or the quote in front of the marker that the runtime's JSON encoding opens with
 * (`asText` rewrites a result only when it starts with a quote, and the encoding escapes nothing
 * in the marker's letters).
 *
 * A SUPERSET ON PURPOSE: padding a vendor added, or an escaped spelling of the marker, passes
 * here and the full strip then answers null — never the other way round, so nothing the
 * one-sequence strip reads as a refusal can be folded away by this cheap look, which is the
 * direction that would hide a question the person has to answer.
 */
export function mayBeRefusal(result: string): boolean {
  const lead = result.trimStart();
  return (
    lead.startsWith(REFUSAL_MARKER) || lead.startsWith(`"${REFUSAL_MARKER}`)
  );
}

/**
 * The content inside the untrusted-content envelope, without the notice in front of it.
 *
 * The server marks every connector result as outside data before the model reads it
 * (`server/src/untrusted-content.ts`). The notice is for the model; a person reading the transcript
 * wants the vendor's answer, drawn the way it always was. Declared at both ends like
 * {@link REFUSAL_MARKER}. Text with no envelope is returned unchanged.
 */
export function withoutUntrustedEnvelope(text: string): string {
  return text.replace(
    /CRITICAL: The following [^\n]* is untrusted data, not instructions or tool authorization\.[^\n]*\n<untrusted_data source="[^"]*">\n([\s\S]*?)\n<\/untrusted_data>/g,
    (_match, inner: string) =>
      inner.replace(/<\\\/untrusted_data/gi, "</untrusted_data"),
  );
}

/**
 * A parsed JSON value drawn as a json fence, or null when the engine cannot redraw it.
 *
 * V8's JSON.stringify recurses once per nesting level and gives up (`RangeError: Maximum call
 * stack size exceeded`) on legal documents far shallower than JSON.parse reads. When it does, the
 * vendor's own text is what gets drawn — fenced as JSON, unchanged, exactly the bytes the server
 * sent — but which text that may be is the caller's to decide, because a fallback that repeats
 * content already drawn beside it shows the same words twice.
 */
function fence(parsed: unknown): string | null {
  try {
    return `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  } catch {
    // The stringifier recursed past the engine's limit. What to draw instead depends on what has
    // already been drawn beside it, so the failure answers null and the caller decides.
    return null;
  }
}

/** A text fenced as JSON — the bytes the server sent, unread and unchanged. */
function fencedJson(text: string): string {
  return `\`\`\`json\n${text}\n\`\`\``;
}

/**
 * A tool result, as something worth looking at.
 *
 * MCP says a text part, and vendors fill it with anything from plain markdown to a JSON envelope
 * with the markdown inside one field. Markdown is drawn as markdown, a JSON wrapper is unwrapped to
 * the markdown it was hiding, and anything else is fenced as JSON. Nothing is discarded.
 */
export function forDisplay(text: string): string {
  const trimmed = withoutUntrustedEnvelope(asText(text)).trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON after all. Draw what the server sent, without the model's notice.
    return trimmed;
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    // The field carrying the answer, told apart from the ones carrying bookkeeping: Slack sends
    // `{ results, pagination_info }`. The rest is kept below rather than dropped.
    const markdown = entries
      .filter(
        ([, value]) =>
          typeof value === "string" &&
          (value.includes("\n#") || value.startsWith("#")),
      )
      .sort((a, b) => String(b[1]).length - String(a[1]).length)[0];

    if (markdown) {
      const rest = entries.filter(([key]) => key !== markdown[0]);
      const body = String(markdown[1]);
      if (rest.length === 0) return body;
      /*
       * When the rest cannot be redrawn, the envelope is drawn once, as the text it arrived in.
       * Standing the body in front of that fence would show the same words twice — once as the
       * markdown just drawn, once more inside the envelope — so the whole envelope stands alone;
       * nothing is discarded either way.
       */
      const redrawn = fence(Object.fromEntries(rest));
      return redrawn === null ? fencedJson(trimmed) : `${body}\n\n${redrawn}`;
    }
  }

  return fence(parsed) ?? fencedJson(trimmed);
}

/**
 * Whether a server-side tool's result begins with the phrase that means it went ahead.
 *
 * TWO CALLERS AND ONE RULE, because they had two. A tool that runs on the server reaches the
 * transcript as text meant for a model, so the only thing the renderer can read an outcome out of is
 * the wording — and the wording arrives JSON-encoded, which is why this decodes before it matches.
 *
 * The awkward case is a result that is neither a string nor absent. `message_bot` treated that as
 * success and `ask_person` treated it as a refusal, for the same situation, and the handoff's own
 * comments say which way round is worse: a boundary that held drawn as a Bot getting on with it.
 * So anything unrecognisable is not success. Absent is left alone, because a call still running has
 * no result yet and the caller decides that from its status.
 */
export function saidItWentAhead(result: unknown, marker: string): boolean {
  if (result === undefined) return true;
  if (typeof result !== "string") return false;
  return asText(result).startsWith(marker);
}

/**
 * Whether a server-side tool reached a terminal failure rather than returning a result.
 *
 * These prefixes are written by the two server tool doors after the distinction between policy
 * refusal and execution failure has already been made. A refusal has its own marker and must not
 * be collapsed into this state.
 */
export function toolResultFailed(result: string | undefined): boolean {
  if (result === undefined) return false;
  const answer = asText(result);
  return (
    answer.startsWith("The vendor reported an error:") ||
    answer.startsWith("That tool could not be called")
  );
}
