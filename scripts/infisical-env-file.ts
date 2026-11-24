// The two readers of this file disagree: `bun --env-file` and Compose's env_file both expand "$",
// even inside single quotes, and read backslashes inside quotes differently. A bare value comes
// back as written unless it holds one of these; a quoted one cannot carry a backslash at all.
const NEEDS_QUOTES = /[$#\r\n]/;

export function renderEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (!NEEDS_QUOTES.test(value)) return `${key}=${value}`;
      if (value.includes("\\")) {
        throw new Error(
          `${key} holds a backslash and "$", "#" or a line break, which no .env spelling survives`,
        );
      }
      const quoted = value
        .replaceAll("$", "\\$")
        .replaceAll('"', '\\"')
        .replaceAll("\n", "\\n");
      return `${key}="${quoted}"`;
    })
    .join("\n");
}
