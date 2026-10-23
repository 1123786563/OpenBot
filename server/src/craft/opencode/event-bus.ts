/**
 * Per-sandbox opencode-serve event bus — ported from onyx `event_bus.py`.
 *
 * One long-lived `GET /event` SSE subscription per (sandbox, directory), fanned out to
 * per-session subscriber queues. opencode-serve does not support `Last-Event-ID`
 * (sst/opencode#25657), so subscribers reconcile gaps via the cumulative `part.text`
 * field on `message.part.updated` — the translator's gap-fill logic.
 *
 * Threading in the original becomes a single async reader task here: Bun has no threads, and
 * the reader is I/O-bound anyway. The reconnect ladder (1s → 30s exponential, give up after 20
 * consecutive failures and self-close) is preserved exactly.
 */

import { getLogger } from "../../../../shared/logger";
import type { CraftConfig } from "../config";

type Json = Record<string, unknown>;

/** Sentinel pushed to every subscriber when the bus closes (explicitly or by giving up). */
export const POD_EVENT_BUS_CLOSED = Symbol("pod-event-bus-closed");

export type BusItem = Json | typeof POD_EVENT_BUS_CLOSED;

/**
 * One subscriber's handoff queue. Bounded (500) like onyx's `queue.Queue(maxsize=500)`; when
 * full, the bus drops the event and counts it (a slow consumer must never block the reader).
 *
 * `shift` resolves undefined on timeout — the caller's loop treats that as idle time (keepalive
 * windows, interrupt checks), exactly like the Python `queue.get(timeout=…)` + Empty pattern.
 */
export class SubscriberQueue {
  private readonly items: BusItem[] = [];
  private readonly waiters = new Set<{
    resolve: (item: BusItem | undefined) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  droppedCount = 0;

  constructor(readonly maxSize: number) {}

  push(item: BusItem): boolean {
    if (this.items.length >= this.maxSize) {
      this.droppedCount += 1;
      return false;
    }
    this.items.push(item);
    this.drainWaiters();
    return true;
  }

  private drainWaiters(): void {
    for (const waiter of this.waiters) {
      const item = this.items.shift();
      if (item === undefined) return;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(item);
    }
  }

  /** Next item, or undefined after `timeoutMs` — the "Empty" answer of the port. */
  shift(options: { timeoutMs?: number } = {}): Promise<BusItem | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter = {
        resolve: (value: BusItem | undefined) => {
          this.waiters.delete(waiter);
          resolve(value);
        },
        timer: setTimeout(() => waiter.resolve(undefined), timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }
}

export type PodSubscription = {
  readonly sessionId: string;
  readonly queue: SubscriberQueue;
};

export type PodEventBusOptions = {
  baseUrl: string;
  config: CraftConfig;
  /** opencode-serve scopes /event per ?directory=; omitting it sees only the default Instance. */
  directory?: string | null;
  token?: string | null;
  botId?: string | null;
  fetchImpl?: typeof fetch;
};

const RECONNECT_BACKOFF_INITIAL_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
// Give up after this many consecutive failed reconnects — the sandbox is almost
// certainly gone, and continuing to retry leaks a reader + connection per orphan.
const RECONNECT_MAX_CONSECUTIVE_FAILURES = 20;
const SUBSCRIBER_QUEUE_MAXSIZE = 500;

export class PodEventBus {
  private readonly base: string;
  private readonly config: CraftConfig;
  private readonly directory: string | null;
  private readonly token: string | null;
  private readonly botId: string | null;
  private readonly doFetch: typeof fetch;

  private stopped = false;
  private closedFlag = false;
  private readerStarted = false;
  private readerDone: Promise<void> | null = null;

  private readonly subscribers = new Map<string, PodSubscription[]>();
  /**
   * list (not set): `listChildren` returns spawn order, which frontends use for
   * next/previous subagent navigation.
   */
  private readonly parentToChildren = new Map<string, string[]>();
  private readonly childToParent = new Map<string, string>();

  /** Set once the /event stream is connected and cleared on every disconnect. */
  streamReady = false;

  constructor(options: PodEventBusOptions) {
    this.base = options.baseUrl.replace(/\/$/, "");
    this.config = options.config;
    this.directory = options.directory ?? null;
    this.token = options.token ?? null;
    this.botId = options.botId ?? null;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /**
   * True once the bus has been explicitly closed or self-closed after exhausting its reconnect
   * budget. Callers that cache buses should check this before reusing one — a closed bus only
   * ever delivers POD_EVENT_BUS_CLOSED.
   */
  get closed(): boolean {
    return this.closedFlag;
  }

  /** Same answer as {@link closed}, in the method shape the client's loops read. */
  isClosed(): boolean {
    return this.closedFlag;
  }

  subscribe(sessionId: string): PodSubscription {
    const sub: PodSubscription = {
      sessionId,
      queue: new SubscriberQueue(SUBSCRIBER_QUEUE_MAXSIZE),
    };
    if (this.closedFlag) {
      sub.queue.push(POD_EVENT_BUS_CLOSED);
      return sub;
    }
    const subs = this.subscribers.get(sessionId) ?? [];
    subs.push(sub);
    this.subscribers.set(sessionId, subs);
    this.ensureReaderStarted();
    return sub;
  }

  unsubscribe(sub: PodSubscription): void {
    const subs = this.subscribers.get(sub.sessionId);
    if (!subs) return;
    const index = subs.indexOf(sub);
    if (index >= 0) subs.splice(index, 1);
    if (subs.length === 0) this.subscribers.delete(sub.sessionId);
  }

  /** Child sessionIds in spawn order. */
  listChildren(parentSessionId: string): string[] {
    return [...(this.parentToChildren.get(parentSessionId) ?? [])];
  }

  parentOf(childSessionId: string): string | null {
    return this.childToParent.get(childSessionId) ?? null;
  }

  /** Stop the reader and signal subscribers. Idempotent. */
  close(): void {
    if (this.stopped && this.closedFlag) return;
    this.stopped = true;
    this.signalSubscribersClosed();
  }

  /** Resolves when the reader task has fully exited (for tests / shutdown hooks). */
  readerSettled(): Promise<void> {
    return this.readerDone ?? Promise.resolve();
  }

  private signalSubscribersClosed(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const all = [...this.subscribers.values()].flat();
    this.subscribers.clear();
    for (const sub of all) {
      // Drop head to make room if full — slow consumers must not block close.
      sub.queue.push(POD_EVENT_BUS_CLOSED);
    }
  }

  private ensureReaderStarted(): void {
    if (this.readerStarted || this.closedFlag) return;
    this.readerStarted = true;
    this.readerDone = this.readerLoop();
  }

  private async readerLoop(): Promise<void> {
    let backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
    let consecutiveFailures = 0;
    while (!this.stopped) {
      let hadSuccessfulRead = false;
      try {
        await this.readOneStream();
        hadSuccessfulRead = this.streamReady;
      } catch {
        // Stream error — reconnect below (with backoff).
      } finally {
        this.streamReady = false;
      }

      if (hadSuccessfulRead) {
        consecutiveFailures = 0;
        backoffMs = RECONNECT_BACKOFF_INITIAL_MS;
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= RECONNECT_MAX_CONSECUTIVE_FAILURES) {
          this.stopped = true;
          this.signalSubscribersClosed();
          return;
        }
      }

      if (this.stopped) return;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
    }
  }

  private async readOneStream(): Promise<void> {
    // Configurable path: opencode's own "/event" (onyx pods) or the agent-sandbox gateway's
    // "/events" — a filtered, keepalive-labelled re-exposition of the same stream (see
    // config.opencodeEventPath and docs/plans/craft/port/README.md 差异点).
    const path = this.config.opencodeEventPath.startsWith("/")
      ? this.config.opencodeEventPath
      : `/${this.config.opencodeEventPath}`;
    const url = new URL(`${this.base}${path}`);
    if (this.directory) url.searchParams.set("directory", this.directory);
    const headers: Record<string, string> = {
      accept: "text/event-stream",
    };
    if (this.token) headers["x-sandbox-token"] = this.token;
    if (this.botId) headers["x-openbot-bot-id"] = this.botId;

    const response = await this.doFetch(url.toString(), {
      headers,
      // The read timeout bounds how long a silent connection is tolerated before
      // this fetch rejects and the loop reconnects.
      signal: AbortSignal.timeout(
        this.config.opencodeServeEventReadTimeoutSeconds * 1000,
      ),
    });
    if (!response.ok) {
      throw new Error(`/event answered HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("/event carried no body");
    }
    this.streamReady = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        if (this.stopped) return;
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex >= 0) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const event = parseSseBlock(block);
          if (event !== null) this.dispatch(event);
          separatorIndex = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private dispatch(event: Json): void {
    const eventType = event.type;
    const props =
      event.properties instanceof Object ? (event.properties as Json) : null;
    let sessionCreatedParentId: string | null = null;

    if (eventType === "session.created" && props) {
      const info = props.info;
      if (info instanceof Object) {
        const childId = (info as Json).id;
        const parentId = (info as Json).parentID;
        if (
          typeof childId === "string" &&
          typeof parentId === "string" &&
          childId &&
          parentId
        ) {
          sessionCreatedParentId = parentId;
          if (!this.childToParent.has(childId)) {
            this.childToParent.set(childId, parentId);
            const siblings = this.parentToChildren.get(parentId) ?? [];
            siblings.push(childId);
            this.parentToChildren.set(parentId, siblings);
          }
        }
      }
    }

    let sessionId = extractSessionId(event);
    if (sessionId === null) sessionId = sessionCreatedParentId;
    const logSessionId = sessionId ?? "<unscoped>";

    // Deliver to the session's own subscribers AND every ancestor's, so a turn
    // subscribed only to the parent also sees descendant (subagent) events.
    // Walk childToParent to the root, deduping so no subscriber sees doubles.
    const targets: PodSubscription[] = [];
    const seen = new Set<PodSubscription>();
    let groups: PodSubscription[][];
    if (sessionId === null) {
      if (!isUnscopedTerminalEvent(event)) return;
      // Some opencode terminal events publish without a sessionID. The bus is
      // directory-scoped, so active subscribers are the only possible consumers.
      groups = [...this.subscribers.values()];
    } else {
      const targetSessionIds = [sessionId];
      const seenSessionIds = new Set([sessionId]);
      let ancestor = this.childToParent.get(sessionId) ?? null;
      while (ancestor !== null && !seenSessionIds.has(ancestor)) {
        targetSessionIds.push(ancestor);
        seenSessionIds.add(ancestor);
        ancestor = this.childToParent.get(ancestor) ?? null;
      }
      groups = targetSessionIds
        .map((id) => this.subscribers.get(id) ?? [])
        .filter((subs) => subs.length > 0);
    }
    for (const subscribers of groups) {
      for (const subscription of subscribers) {
        if (!seen.has(subscription)) {
          seen.add(subscription);
          targets.push(subscription);
        }
      }
    }

    for (const subscription of targets) {
      const pushed = subscription.queue.push(event);
      if (!pushed) {
        // First drop and every 50th get a warning (onyx cadence).
        if (
          subscription.queue.droppedCount === 1 ||
          subscription.queue.droppedCount % 50 === 0
        ) {
          getLogger("server").warn(
            `[craft] PodEventBus dropped event for session ${logSessionId} ` +
              `(queue full; total dropped=${subscription.queue.droppedCount})`,
          );
        }
      }
    }
  }
}

/**
 * opencode events expose sessionID at `properties.sessionID` for most types, but composite
 * payloads (Message, PermissionRequest) carry it on the inner object — try both.
 */
function extractSessionId(event: Json): string | null {
  const props = event.properties;
  if (!(props instanceof Object)) return null;
  const json = props as Json;
  const sid = json.sessionID;
  if (typeof sid === "string" && sid) return sid;
  const info = json.info;
  if (info instanceof Object) {
    const nested = (info as Json).sessionID;
    if (typeof nested === "string" && nested) return nested;
  }
  return null;
}

function isUnscopedTerminalEvent(event: Json): boolean {
  const eventType = event.type;
  if (eventType === "session.error" || eventType === "session.idle")
    return true;
  if (eventType !== "session.status") return false;
  const props = event.properties;
  if (!(props instanceof Object)) return false;
  const status = (props as Json).status;
  return status instanceof Object && (status as Json).type === "idle";
}

function parseSseBlock(block: string): Json | null {
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    else if (line.startsWith("data:")) dataLines.push(line.slice(5));
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  try {
    const parsed = JSON.parse(payload);
    return parsed instanceof Object && parsed !== null
      ? (parsed as Json)
      : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
