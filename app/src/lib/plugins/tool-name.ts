import {
  researchRoleOfTool,
  type ResearchRole,
} from "../../../../shared/research";

/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 *
 * Research is the one exception where the server is dropped entirely: `web_search_exa` would read
 * "Web search exa", which tells the person which vendor this deployment buys search from and
 * nothing about their answer. Which provider is granted is an administrator's fact, on the Bot's
 * access page.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
  /**
   * The key in the `channels` locale a translator renders this label from, for a research tool.
   * Absent for everything else — those labels are the reader's own words already.
   */
  labelKey?: ResearchLabelKey;
};

/**
 * The channels.json keys a research role's label renders from.
 *
 * A key and not a string, because `readToolName` answers without a translator: its `label` for a
 * research tool is the English phrase, and anything drawing the line in the reader's language goes
 * through this key instead.
 */
export type ResearchLabelKey = "tools.researchSearch" | "tools.researchFetch";

/**
 * The label a research call carries when no translation happens.
 *
 * These must stay the same strings `app/src/locales/en/channels.json` renders for the keys above —
 * the fallback and the translation are the same surface in two languages, and
 * `app/tests/tool-name.test.ts` pins the equality so they cannot drift apart.
 */
const RESEARCH_ROLE_FALLBACKS: Readonly<Record<ResearchRole, string>> =
  Object.freeze({ search: "Search the web", fetch: "Read web pages" });

const RESEARCH_LABEL_KEYS: Readonly<Record<ResearchRole, ResearchLabelKey>> =
  Object.freeze({
    search: "tools.researchSearch",
    fetch: "tools.researchFetch",
  });

/**
 * The two role refs a skill can declare, in picker order.
 *
 * `shared/research.ts` exports the parser and not the prefix constant (an R01 decision, kept: the
 * shared module's surface does not grow for a consumer that can spell two strings), so the refs are
 * spelled here. What keeps that honest is `app/tests/tool-name.test.ts`, which feeds every ref back
 * through `researchRoleOf` and fails the suite if the shared parser stops recognising it — before
 * the picker can offer a declaration the server would refuse to save.
 */
export const RESEARCH_ROLES: readonly {
  role: ResearchRole;
  ref: string;
}[] = [
  { role: "search", ref: "@research/search" },
  { role: "fetch", ref: "@research/fetch" },
] as const satisfies readonly { role: ResearchRole; ref: string }[];

export function readToolName(name: string): ToolName {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return { label: name };

  const [, server, ...rest] = parts;
  const tool = rest.join("__");
  /*
   * Research is named for what it did, not for who did it, so the role label replaces both the
   * humanised name and the server: there is no "exa" left to mute beside it.
   */
  const role = researchRoleOfTool(server ?? "", tool);
  if (role)
    return {
      label: RESEARCH_ROLE_FALLBACKS[role],
      labelKey: RESEARCH_LABEL_KEYS[role],
    };
  const label = humanise(tool);

  /*
   * The server is dropped when the action already names it as the thing acted upon. Vendors name a
   * tool after the thing it acts on, so `mcp__notes__search_notes` would otherwise read "Search
   * notes notes" and `mcp__routines__create_routine` "Create routine routines", both of which look
   * like a bug rather than a label. A server key can itself be more than one word — `google-drive`,
   * `google_drive` — so it is split into words the same way `humanise` splits the tool name, each
   * singularised, and looked for as a contiguous run inside the label's words. Whole words in an
   * unbroken sequence, never a substring test: that is what let "Create routine routines" through in
   * the first place.
   *
   * `humanise` always puts the verb first, and that leading word is excluded from the search:
   * `mcp__posts__post_message` singularises its server to "post", which is also the tool's own verb,
   * so without this exclusion "Post message" would lose its "posts" attribution over a coincidence
   * with the verb rather than a naming of the server. Same shape for `mcp__lists__list_files`
   * against "List". Only the words after the verb describe what the action was taken on, so only
   * those are eligible to match the server.
   *
   * This does not, and cannot, catch every collision: `mcp__news__get_new_items` singularises "news"
   * to "new", which genuinely is the second word of "Get new items", so the server is still dropped
   * there. English plural heuristics cannot tell that "new" apart from the "new" in "news" — that is
   * a known limit of this rule, not a bug to chase with a word list.
   */
  const labelWords = label.toLowerCase().split(" ").map(singular);
  const wordsActedOn = labelWords.slice(1);
  const serverWords = wordsOf(server ?? "").map(singular);
  const named = containsPhrase(wordsActedOn, serverWords);
  return named ? { label } : { label, detail: server };
}

/**
 * `routines` and `routine` are the same word for this purpose.
 *
 * A vendor names the server for the collection and the tool for the one item —
 * `mcp__routines__create_routine` — so the exact-substring test that stops "Search notes notes" lets
 * "Create routine routines" straight through, and it reads as a typo rather than as a label.
 *
 * Dropping one trailing `s` from each side before comparing is the whole of the difference between
 * those two cases. This is not a stemmer and must not grow into one: the only thing it has to catch
 * is one vendor writing the same noun twice, once plural and once not.
 */
function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
function humanise(tool: string): string {
  const words = wordsOf(tool).join(" ");
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `google-drive`, `google_drive` and `googleDrive` all split to the same `["google", "drive"]`.
 *
 * The same splitting `humanise` does for a tool name, pulled out so a server key can be broken into
 * words too rather than compared as one opaque token.
 */
function wordsOf(text: string): string[] {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * Whether `needle` occurs in `haystack` as a run of whole words, in order and unbroken.
 *
 * This is the whole-word alternative to a substring test: `["routine"]` must line up with a word
 * in `["create", "routine"]`, not merely appear inside one of its letters.
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word))
      return true;
  }
  return false;
}
