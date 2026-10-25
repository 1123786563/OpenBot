import type { Message } from "@ag-ui/core";

/**
 * The answer's own basis, as an answer carries it (FIX-W14, FR3-1 of #387).
 *
 * The server composes a run's answer and its basis from ONE read of the person's confirmed
 * memory: the {id, kind} pointers of the block injected into the run's prompt ride the run's
 * assistant messages in the AG-UI event metadata, which is the channel the client already
 * rebuilds messages from — live and on reconnect alike. This module is the one reader of that
 * shape on the browser side; the ids it hands on are expanded by the evidence seam, which
 * re-decides current authorization per id at expansion time (a basis the person can no longer
 * see answers unavailable, never content).
 */

/** Which half of the person's memory an answer drew on. The server's own vocabulary. */
export type AnswerMemoryKind =
  | "general-preference"
  | "source-bound"
  | "derived-judgment";

/** One record the answer cited: the id the evidence seam expands, and which half it came from. */
export type AnswerMemoryBasisPointer = {
  id: string;
  kind: AnswerMemoryKind;
};

const KINDS: readonly AnswerMemoryKind[] = [
  "general-preference",
  "source-bound",
  "derived-judgment",
];

/** The metadata key the server stamps the set under — server-composed, never a client field. */
const OPENBOT_METADATA_KEY = "openbot";
const BASIS_METADATA_KEY = "personalMemoryBasis";

/**
 * The answer's basis, checked rather than cast — or null when this message carries none.
 *
 * A LIVE message is whatever the run put in the array the agent hands back, and a replayed one
 * is the persisted event's own metadata; neither is validated on its way here. So every step
 * is checked: a non-object metadata, a set that is not an array, an entry without a non-empty
 * string id or with a kind this app does not know, all answer null. THAT IS THE FAIL-CLOSED
 * HALF: a basis this reader cannot vouch for is not drawn at all, because a partial set under
 * an answer would claim less (or other) than the answer used. An empty set is null too — an
 * answer with no memory behind it shows no basis rather than an empty one.
 */
export function answerMemoryBasisOf(
  message: Readonly<Message>,
): readonly AnswerMemoryBasisPointer[] | null {
  const metadata = (message as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const openbot = (metadata as Record<string, unknown>)[OPENBOT_METADATA_KEY];
  if (typeof openbot !== "object" || openbot === null) return null;
  const raw = (openbot as Record<string, unknown>)[BASIS_METADATA_KEY];
  if (!Array.isArray(raw)) return null;
  const pointers: AnswerMemoryBasisPointer[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { id, kind } = entry as { id?: unknown; kind?: unknown };
    if (typeof id !== "string" || id.length === 0) return null;
    if (!KINDS.includes(kind as AnswerMemoryKind)) return null;
    pointers.push({ id, kind: kind as AnswerMemoryKind });
  }
  return pointers.length > 0 ? pointers : null;
}
