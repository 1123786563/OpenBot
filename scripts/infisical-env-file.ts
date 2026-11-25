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

/** `scripts/start.sh` mints these on a first run and writes them to .env: the machine identity is read-only, so they cannot go to Infisical from there. */
export const START_SH_KEYS = ["AGENT_TOOL_TOKEN", "MANAGED_AGENT_TOKEN"];

/**
 * What a rewrite of .env is to hold: Infisical's values, then the ones only .env has that start.sh
 * wrote. `localOnly` are the other filled-in values a rewrite would lose, which is refused.
 */
export function mergeEnv(
  infisical: Record<string, string>,
  current: Record<string, string>,
): { values: Record<string, string>; kept: string[]; localOnly: string[] } {
  const carried: Record<string, string> = {};
  const kept: string[] = [];
  const localOnly: string[] = [];
  for (const [key, value] of Object.entries(current)) {
    if (!value || key in infisical) continue;
    if (START_SH_KEYS.includes(key)) {
      carried[key] = value;
      kept.push(key);
    } else localOnly.push(key);
  }
  return { values: { ...infisical, ...carried }, kept, localOnly };
}
