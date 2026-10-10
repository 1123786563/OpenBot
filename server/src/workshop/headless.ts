/**
 * The workshop's headless door: a turn a Bot runs on a person's behalf, with no browser.
 *
 * The interactive workshop streams through SSE (B9); an agent calling this tool has no
 * connection to stream on and no UI to show one to. So this path is deliberately dumber and
 * more robust: enqueue with the headless marker, await the turn's terminal state by polling
 * the store (the database is the truth — a lost bus ping costs latency, never correctness),
 * and answer with the turn's id, outcome and artifact list.
 *
 * NO SUBSCRIPTION is ever opened: the bus carries nothing for this path, which is also why
 * the test asserts the bus stayed subscriber-free — a headless turn that opened one would be
 * a leak of the interactive shape into the machine shape.
 */
import type { TurnOrchestrator } from "./orchestrator";
import type { WorkshopStore } from "./store";

export type RunWorkshopTurnInput = {
  botId: string;
  channelId: string;
  prompt: string;
  /** Wall-clock budget for the WHOLE wait, in ms; default 10 minutes. */
  timeoutMs?: number;
};

export type RunWorkshopTurnResult = {
  turnId: string;
  status: "succeeded" | "failed" | "cancelled" | "timeout";
  error: string | null;
  artifacts: Array<{ id: string; name: string; type: string }>;
};

/** Poll cadence: the store is local; a fast poll costs nothing and answers snappily. */
const POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_MS = 10 * 60 * 1000;

export class WorkshopTurnTimeoutError extends Error {
  constructor(turnId: string, waitedMs: number) {
    super(`Workshop turn ${turnId} did not settle within ${waitedMs}ms.`);
    this.name = "WorkshopTurnTimeoutError";
  }
}

export type HeadlessWorkshopTools = {
  /** The run_workshop_turn tool's handler, mountable by any server-side agent loop. */
  runWorkshopTurn(input: RunWorkshopTurnInput): Promise<RunWorkshopTurnResult | string>;
};

export function createHeadlessWorkshopTools(options: {
  store: WorkshopStore;
  orchestrator: TurnOrchestrator;
  /** Who the turn is attributed to; the agent loop supplies its caller's id. */
  actorUserId: string;
  /** Injection for tests; default is the global setTimeout pair. */
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}): HeadlessWorkshopTools {
  const { store, orchestrator } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowMs = options.nowMs ?? Date.now;

  return {
    async runWorkshopTurn(input) {
      if (!input.botId || !input.channelId || !input.prompt) {
        return "run_workshop_turn needs botId, channelId and prompt.";
      }

      const session = await store.getOrCreateSession({
        channelId: input.channelId,
        botId: input.botId,
        ownerUserId: options.actorUserId,
      });

      const { turnId } = await orchestrator.enqueue({
        sessionId: session.id,
        prompt: input.prompt,
        actorUserId: options.actorUserId,
        botId: input.botId,
        ownerUserId: session.ownerUserId,
        // The headless marker: the trail distinguishes a person's ask from a Bot's ask on a
        // person's behalf — the handoff shape is exactly "another agent, acting in a run".
        initiator: { kind: "handoff", id: input.botId },
      });

      const deadline = nowMs() + (input.timeoutMs ?? DEFAULT_WAIT_MS);
      for (;;) {
        const turn = await store.getTurn(turnId);
        const status = turn?.status;
        if (status === "succeeded" || status === "failed" || status === "cancelled") {
          const artifacts = await store.listArtifacts(session.id);
          return {
            turnId,
            status,
            error: turn?.error ?? null,
            artifacts: artifacts.map((artifact) => ({
              id: artifact.id,
              name: artifact.name,
              type: artifact.type,
            })),
          };
        }
        if (nowMs() >= deadline) {
          // Settle what can be settled (a cancel the orchestrator honours) and answer timeout.
          await orchestrator.cancel(turnId).catch(() => undefined);
          throw new WorkshopTurnTimeoutError(turnId, input.timeoutMs ?? DEFAULT_WAIT_MS);
        }
        await sleep(POLL_INTERVAL_MS);
      }
    },
  };
}
