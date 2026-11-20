import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkItem, WorkQueue } from "./queue";

type ExecutionQueue = Pick<WorkQueue, "executionExpiry"> &
  Partial<
    Pick<
      ReturnType<typeof import("./queue").createWorkQueue>,
      "checkpoint" | "endInterrupted"
    >
  >;

type Grant = NonNullable<WorkItem["authorization"]>;
const active = new AsyncLocalStorage<Grant & { signal: AbortSignal }>();

export function currentWorkGrant() {
  return active.getStore();
}

export async function runAuthorizedWork<T>(
  queue: ExecutionQueue,
  item: WorkItem,
  owner: string,
  run: (guard?: {
    signal: AbortSignal;
    beforeDispatch: () => Promise<void>;
    onText: (text: string) => void;
  }) => Promise<T>,
  options?: { signal?: AbortSignal; safeFailure?: (error: unknown) => boolean },
): Promise<T> {
  const grant = item.authorization;
  if (!grant) return run();
  const held = { kind: item.kind, key: item.key, owner };
  const controller = new AbortController();
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const reason = new Error("Bot work authorization ended.");
  let expiresAt = grant.expiresAt;
  let cutoff: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let lastCheck: Promise<void> | undefined;
  let text: string | undefined;
  let saving: Promise<void> | undefined;

  function expire() {
    cutoff = expiresAt;
    controller.abort(reason);
  }

  function deadline() {
    clearTimeout(timer);
    if (Date.now() >= expiresAt) expire();
    else timer = setTimeout(expire, expiresAt - Date.now());
  }

  function beforeDispatch() {
    lastCheck ??= check().finally(() => {
      lastCheck = undefined;
    });
    return lastCheck;
  }

  async function check() {
    if (Date.now() >= expiresAt) expire();
    signal.throwIfAborted();
    const next = await queue.executionExpiry?.(held);
    if (ended) return;
    if (Date.now() >= expiresAt) expire();
    if (next === undefined) controller.abort(reason);
    signal.throwIfAborted();
    if (next !== undefined) expiresAt = next;
    if (!ended) deadline();
    signal.throwIfAborted();
  }

  async function poll() {
    try {
      await beforeDispatch();
    } catch {
      controller.abort(reason);
    }
    if (!ended && !signal.aborted) polling = setTimeout(poll, 500);
  }

  function onText(output: string) {
    text = output;
    saving ??= (async () => {
      while (text !== undefined) {
        const snapshot = text;
        text = undefined;
        await queue.checkpoint?.(held, snapshot);
      }
    })()
      .catch(() => controller.abort(reason))
      .finally(() => {
        saving = undefined;
      });
  }

  deadline();
  polling = setTimeout(poll, 500);
  try {
    await beforeDispatch();
    const result = await active.run({ ...grant, signal }, () =>
      run({ signal, beforeDispatch, onText }),
    );
    ended = true;
    await saving;
    if (Date.now() >= expiresAt) expire();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    ended = true;
    const endedAt = Date.now();
    await saving;
    if (signal.aborted || !options?.safeFailure?.(error))
      await queue.endInterrupted?.(held, endedAt, cutoff);
    signal.throwIfAborted();
    throw error;
  } finally {
    ended = true;
    clearTimeout(timer);
    clearTimeout(polling);
  }
}
