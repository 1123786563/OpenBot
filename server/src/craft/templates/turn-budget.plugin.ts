// Steers the agent to wrap up when a turn exceeds its soft time budget: past
// the deadlines stamped by the backend at turn start (`stampTurnDeadline` in
// ./turn-budget.ts), tool results carry a converge notice, escalating to
// finish-now near the hard cap. Nothing in flight is killed — the executor's
// hard cap does the aborting. Missing/unreadable/stale stamp → inert.
//
// Ported verbatim from onyx `sandbox/image/opencode-plugins/turn-budget.ts`.
// Two mechanical deviations, both forced by this file's home inside the server
// tree (it is shipped as TEXT — written into each session workspace by
// setupSessionWorkspace / regenerateSessionConfig, then loaded by the sandbox
// side's opencode):
//   1. `import type { Plugin } from "@opencode-ai/plugin"` + `satisfies Plugin`
//      dropped — the package is not a server dependency, and the type sugar
//      carries no runtime behavior.
//   2. `Bun.file(...).json()` → `node:fs/promises` readFile + JSON.parse —
//      identical under the Bun runtime the sandbox actually runs, and typed in
//      this workspace.
// The notice texts and the 60s throttle are byte-for-byte onyx's.

import { readFile } from "node:fs/promises";

const BUDGET_FILE = ".onyx-turn-budget.json";

const NOTICE_INTERVAL_MS = 60_000;

function convergeNotice(minutesLeft: number): string {
  return (
    `[Onyx turn budget] About ${minutesLeft} minute(s) of turn budget left. ` +
    "Stop opening new research or subagent work; converge on the final " +
    "deliverable with what you already have."
  );
}

const FINISH_NOW_NOTICE =
  "[Onyx turn budget] Finish now: write any pending outputs to disk and " +
  "reply immediately with what was delivered and what remains. Do not report " +
  "work as complete if it is not — separate what is done from what remains. " +
  "If you are a subagent, return your findings immediately.";

interface TurnDeadlineStamp {
  soft_deadline_epoch_ms?: unknown;
  final_deadline_epoch_ms?: unknown;
  stale_after_epoch_ms?: unknown;
}

export default (async ({ directory }) => {
  const stampPath = `${directory}/${BUDGET_FILE}`;
  let lastNoticeAtMs = 0;

  async function currentNotice(): Promise<string | null> {
    let stamp: TurnDeadlineStamp;
    try {
      stamp = JSON.parse(
        await readFile(stampPath, "utf8"),
      ) as TurnDeadlineStamp;
    } catch {
      return null;
    }
    const soft = stamp.soft_deadline_epoch_ms;
    const final = stamp.final_deadline_epoch_ms;
    const stale = stamp.stale_after_epoch_ms;
    if (
      typeof soft !== "number" ||
      typeof final !== "number" ||
      typeof stale !== "number"
    ) {
      return null;
    }
    // An incoherent stamp (soft past stale, or final outside [soft, stale]) means a
    // mis-written budget, not a schedule: refuse to nag rather than guess.
    if (soft > stale || final < soft || final > stale) return null;
    const now = Date.now();
    // A stamp past stale_after is from an already-capped turn whose restamp
    // failed — never nag a fresh turn off it.
    if (now <= soft || now >= stale) return null;
    if (now >= final) return FINISH_NOW_NOTICE;
    return convergeNotice(Math.max(1, Math.ceil((stale - now) / 60_000)));
  }

  return {
    "tool.execute.after": async (_input, output) => {
      // undefined on a failed task subtask (opencode Effect.catchCause path).
      if (!output) return;
      const notice = await currentNotice();
      if (notice === null) return;
      const now = Date.now();
      if (now - lastNoticeAtMs < NOTICE_INTERVAL_MS) return;
      lastNoticeAtMs = now;
      // Built-in tools render `.output`; MCP results are rebuilt from
      // `.content` after this hook, so cover both.
      output.output = `${output.output ?? ""}\n\n${notice}`;
      const content = (output as { content?: unknown }).content;
      if (Array.isArray(content)) {
        content.push({ type: "text", text: notice });
      }
    },
  };
}) as (input: { directory: string }) => Promise<{
  "tool.execute.after": (
    input: unknown,
    output: ({ output?: string } & { content?: unknown }) | undefined | null,
  ) => Promise<void>;
}>;
