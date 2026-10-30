import { ExternalLink } from "./ExternalLink";

/**
 * A failure, in both registers, wherever one happens.
 *
 * ONE IMPLEMENTATION, because there is one rule and every screen owes it: the sentence is the
 * headline and the real output lives behind a disclosure. A second copy is how one screen ends up
 * showing an engine dump as its title, and how another ends up rendering `[object Object]` because
 * it stringified a failure that was never a string.
 */
export type Problem = {
  said: string;
  detail?: string | null;
  connection?: "model" | "intelligence" | "organization" | null;
  database_reset?: string | null;
};

/** Anything thrown, as a problem. A bare string keeps working and reads as it always did. */
export function asProblem(thrown: unknown): Problem {
  if (thrown && typeof thrown === "object" && "said" in thrown) {
    return thrown as Problem;
  }
  return { said: String(thrown) };
}

function SetupHelp() {
  // Whitelabel builds can choose their own support page. Never prefill it with error data.
  //
  // `import.meta.env` is inlined by Vite and absent under Bun/Node; `process.env`
  // is the other spelling the same setting arrives in. Either read is optional.
  const viteEnv = (import.meta as { env?: Record<string, string | undefined> })
    .env;
  const runtimeEnv = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const url =
    (
      viteEnv?.VITE_OPENBOT_SUPPORT_URL ?? runtimeEnv?.VITE_OPENBOT_SUPPORT_URL
    )?.trim() || "https://github.com/CopilotKit/OpenBot/issues/new/choose";
  return (
    <ExternalLink className="setup-help" href={url}>
      Get setup help
    </ExternalLink>
  );
}

export function Failure({ problem }: { problem: Problem }) {
  return (
    <div className="blocker" role="alert">
      <h2>That did not finish</h2>
      <p>{problem.said}</p>
      {/* The real output, kept but not the headline. Whoever is debugging opens this; the person
          reading the sentence above never has to. */}
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <SetupHelp />
    </div>
  );
}

/**
 * The same two registers where a whole panel would be too much.
 *
 * Used inside the provider rows, which are small and already have a heading. The sentence reads as
 * a caution and the output is still one click away, so a sign-in that fails inside a card is no
 * less diagnosable than one that fails on its own screen.
 */
export function InlineFailure({ problem }: { problem: Problem }) {
  return (
    <div role="alert">
      <p className="caution">{problem.said}</p>
      {problem.detail && (
        <details className="detail-of">
          <summary>Technical details</summary>
          <pre>{problem.detail}</pre>
        </details>
      )}
      <SetupHelp />
    </div>
  );
}
