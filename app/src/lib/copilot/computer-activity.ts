/**
 * Browser-activity epochs and announcements, used by surfaces that auto-open the live screen once
 * per run and close it again when the call that opened it turns out to have been refused.
 *
 * An `epoch` groups a Bot's actions into runs: quiet for ten seconds, or a different Bot, and the
 * next action is a new run. It is a heuristic about silence, not a server run id — nothing here
 * has spoken to the server about runs.
 *
 * An `announcement` is one call's claim on the screen. It exists so a refusal can take back
 * exactly the pane its own call opened, and no other.
 */

const QUIET_GAP_MS = 10_000;

export type Activity = { botId: string; epoch: number; announcement: number };

export type Withdrawal = { botId: string; announcement: number };

let epoch = 0;
let lastAt = 0;
let lastBot: string | null = null;
let announcement = 0;
const listeners = new Set<(activity: Activity) => void>();
const withdrawalListeners = new Set<(withdrawal: Withdrawal) => void>();

/** Called wherever a Bot's computer is reached, so auto-open surfaces share one activity source. */
export function reportComputerActivity(botId: string): number {
  const now = Date.now();
  // A different Bot is always a new run, however recently the last one acted.
  if (botId !== lastBot || now - lastAt > QUIET_GAP_MS) epoch += 1;
  lastAt = now;
  lastBot = botId;
  announcement += 1;
  const activity = { botId, epoch, announcement };
  for (const listener of listeners) listener(activity);
  return announcement;
}

/**
 * Take an announcement back: the call that made it was refused before the browser was touched, so
 * the pane it opened is pointing at something that never happened. Callers name the announcement
 * they hold, and each surface decides whether that announcement is the one its pane opened for.
 */
export function withdrawComputerActivity(
  botId: string,
  announcement: number,
): void {
  const withdrawal = { botId, announcement };
  for (const listener of withdrawalListeners) listener(withdrawal);
}

export function onComputerActivity(
  listener: (activity: Activity) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function onComputerActivityWithdrawn(
  listener: (withdrawal: Withdrawal) => void,
): () => void {
  withdrawalListeners.add(listener);
  return () => {
    withdrawalListeners.delete(listener);
  };
}
