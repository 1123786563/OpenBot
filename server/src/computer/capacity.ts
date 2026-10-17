import type { ComputerControlState } from "../../../shared/computer-control";
import { getLogger } from "../../../shared/logger";
import type { ComputerLocation, ComputerProvider } from "./provider";

/**
 * The §10 capacity bounds for the 1–20 profile, at the seams Task 0 cited.
 *
 * Three numbers, one place:
 *
 *  - at most `maxActive` computers running at once, counted over the provider's own list — the
 *    same `/computers` answer `/fleet` reads — because the contract bounds the installation, not
 *    the user ("one user's work cannot exhaust the installation"): every user's running computers
 *    share one deployment-wide cap, and the 21st start is refused before the provider is reached.
 *  - a computer idle `idleMinutes` without run activity or human control is stopped, keeping its
 *    workspace — which is the provider's own stop semantics (the supervisor stops the container
 *    and keeps the volume; the shared computer keeps its state), so the sweep only ever asks for
 *    a stop.
 *  - a Bot's workspace holds `diskGib` of writes before the next one is refused.
 *
 * The limiter decides; the gateway asks. It sits in `locate`, the one call every action makes and
 * the one that starts the computer (`/ensure` on the supervisor), so a start that would pass the
 * cap is refused before anything is started; a workspace write is charged before it is sent; and
 * a reset starts the disk budget over with the workspace it wipes.
 */

const GIB = 1024 ** 3;
const log = getLogger("server");

/** The deployment's computers are all running, so this start was refused. */
export class ComputerCapacityError extends Error {
  /** Stable, so a surface can tell a capacity refusal from a generic failure without parsing prose. */
  readonly code = "computer_capacity_exceeded" as const;

  constructor(readonly limit: number) {
    super(
      `All ${limit} computers this deployment allows are running. Stop an idle computer or raise OPENMUSE_MAX_ACTIVE_COMPUTERS.`,
    );
    this.name = "ComputerCapacityError";
  }
}

/** A write would take a Bot's workspace past its disk cap. */
export class WorkspaceQuotaError extends Error {
  /** Stable, for the same reason the capacity refusal carries one. */
  readonly code = "workspace_quota_exceeded" as const;

  constructor(
    capGib: number,
    readonly projectedBytes: number,
    readonly capBytes: number,
  ) {
    super(
      `That write needs ${projectedBytes.toLocaleString()} bytes and this Bot's workspace is capped at ${capGib} GiB (${capBytes.toLocaleString()}), so it was refused. Free space in the workspace or raise OPENMUSE_COMPUTER_DISK_GIB.`,
    );
    this.name = "WorkspaceQuotaError";
  }
}

export type ComputerCapacity = {
  /** Admit one Bot's start, or refuse it before the provider starts anything. */
  reserve(botId: string): Promise<void>;
  /** Stop computers idle past the limit without run or human control, and name them. */
  sweepIdle(now?: Date): Promise<string[]>;
  /** Admit one workspace write against the per-Bot disk cap, recording its bytes. */
  chargeWrite(botId: string, bytes: number): void;
  /**
   * Give back a write's charge when the write never landed, so a transient failure cannot eat
   * budget the Bot's workspace never received.
   */
  refundWrite(botId: string, bytes: number): void;
  /** Start a Bot's disk budget over, alongside the workspace a reset wipes. */
  resetUsage(botId: string): void;
  /**
   * A Bot's computer stopped: its run-activity entry goes with it, so the bookkeeping does not
   * outlive the computer it describes. The disk charge stays — the supervisor keeps the
   * workspace volume across stops, so the bytes it counts do too.
   */
  forget(botId: string): void;
};

export type ComputerCapacityOptions = {
  provider: Pick<ComputerProvider, "list" | "stop">;
  /**
   * The control state's holder and last activity, asked of each running computer during a sweep
   * (K03's GET /control seam). Absent, a sweep judges on run activity alone.
   */
  control?: (botId: string) => Promise<ComputerControlState | undefined>;
  maxActive?: number;
  idleMinutes?: number;
  diskGib?: number;
  now?: () => Date;
};

/** One §10 bound: the env if it holds a usable number, the contract's default if not. */
function bound(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The latest moment any candidate names, or undefined when none does.
 *
 * A sweep may stop a computer only on evidence of when it was last used; a bound that cannot say
 * does not get to guess.
 */
function latestOf(
  ...candidates: (string | number | undefined)[]
): number | undefined {
  let best: number | undefined;
  for (const candidate of candidates) {
    let ms: number;
    if (typeof candidate === "number") {
      ms = candidate;
    } else if (candidate === undefined) {
      ms = Number.NaN;
    } else {
      ms = Date.parse(candidate);
    }
    if (Number.isFinite(ms) && (best === undefined || ms > best)) best = ms;
  }
  return best;
}

export function computerCapacity(
  options: ComputerCapacityOptions,
): ComputerCapacity {
  const maxActive =
    options.maxActive ?? bound("OPENMUSE_MAX_ACTIVE_COMPUTERS", 20);
  const idleMinutes =
    options.idleMinutes ?? bound("OPENMUSE_COMPUTER_IDLE_MINUTES", 15);
  const diskGib = options.diskGib ?? bound("OPENMUSE_COMPUTER_DISK_GIB", 2);
  const diskCapBytes = diskGib * GIB;
  const now = options.now ?? (() => new Date());

  /** When each Bot last acted through this gateway. One more action is the run being alive. */
  const lastRunActivity = new Map<string, number>();
  /** What each Bot's workspace has been charged, in bytes. See chargeWrite for the approximation. */
  const charged = new Map<string, number>();

  function touch(botId: string) {
    lastRunActivity.set(botId, now().getTime());
  }

  async function running(): Promise<ComputerLocation[]> {
    // ponytail: one provider.list() per decision, fine at the 1–20 profile this bound is for;
    // cache or throttle if the supervisor ever reads hot.
    return (await options.provider.list()).filter(
      (computer) => computer.status === "running",
    );
  }

  /*
   * How long a just-admitted start answers for. Every action locates, and locating is /ensure on
   * the supervisor, so without this every gesture in a human's input stream re-lists the whole
   * fleet — the read amplification round 3 named. Within the window an action is the same run
   * the moment-old reserve already admitted, not a new start to judge.
   */
  const RESERVE_THROTTLE_MS = 2_000;

  /*
   * How long a freshly admitted start keeps occupying a slot before it lands in the provider's
   * list: /ensure (container create + start) takes seconds, and the provider's status only knows
   * running/stopped, so a starting computer is invisible to the count above. Without this
   * placeholder, every concurrent reserve of a cold-start burst reads its own below-cap answer
   * and they are all admitted — the cap is briefly overshot by however many started at once.
   * The grace is a ceiling, not a lease: a start that never lands holds its slot only this long.
   */
  const START_GRACE_MS = 30_000;

  /*
   * How recently a contention sweep must have started for a newly contended reserve to skip its
   * own: the first sweep is load-bearing (it frees the caller's slot), the Nth retry's is pure
   * repeated cost on the serialized chain every action waits behind.
   */
  const SWEEP_THROTTLE_MS = 10_000;
  let lastSweepStartedAt: number | undefined;

  /**
   * Serialised in-process: reserve is a check-then-act over the provider's list, so two Bots
   * starting at once could both read below the cap and both be admitted. The chain narrows that
   * window to one reserve at a time (multi-replica deployments still count per-replica — the
   * bounds are per-process by design, like the activity map below).
   */
  let reserving: Promise<void> = Promise.resolve();

  /** Whether a sweep is already running, so a nested one stands aside instead of recursing. */
  let sweeping = false;

  async function reserveOnce(botId: string): Promise<void> {
    const last = lastRunActivity.get(botId);
    if (last !== undefined && now().getTime() - last < RESERVE_THROTTLE_MS) {
      // Still the run the last reserve admitted; keep its activity fresh and ask nothing.
      touch(botId);
      return;
    }
    /*
     * One list answers both questions the admission asks. The second is the cap itself, counted
     * over the other computers; the first is whether this Bot's own is already running, because
     * a refresh is not a start: the /ensure the caller is about to reach starts nothing, so the
     * cap must not refuse it. Without that, a running computer reads as "no room" to its own
     * Bot the moment `others` hits the cap — multi-replica counting, a throttle-window race
     * between two /ensures, or a lowered OPENMUSE_MAX_ACTIVE_COMPUTERS all land there — and
     * its gestures, releases and revocations are all 503'd until an unrelated computer idles.
     */
    const admittedBy = async () => {
      const fleet = await running();
      const own = fleet.some((computer) => computer.botId === botId);
      const listed = new Set(fleet.map((computer) => computer.botId));
      // In-flight starts hold their slot (START_GRACE_MS above): admitted but not yet
      // visible in the list, they still count toward the cap for everyone else.
      const startingElsewhere = [...lastRunActivity.entries()].filter(
        ([id, at]) =>
          id !== botId &&
          !listed.has(id) &&
          now().getTime() - at < START_GRACE_MS,
      ).length;
      const others = fleet.filter(
        (computer) => computer.botId !== botId,
      ).length;
      return own || others + startingElsewhere < maxActive;
    };
    try {
      if (!(await admittedBy())) {
        /*
         * Contended, so the deployment's spare capacity is tried before the caller is refused:
         * computers idle past the limit are exactly the ones the contract wants stopped, and
         * the sweep on contention is the whole of the idle-stop trigger — no timer, no new service.
         *
         * The reserving Bot is excluded: stopping its own computer frees nothing (the count
         * already omits it) and only throws away the browser state its own /ensure is about to
         * restart.
         *
         * The sweep is awaited here — it is what frees this caller's slot — but it is not re-paid
         * on every refusal: within SWEEP_THROTTLE_MS of the last one, a contended reserve skips
         * straight to the re-check, so a retrying surface's gestures are not multiplied into a
         * fleet-wide list + per-computer consult per retry.
         */
        if (
          lastSweepStartedAt === undefined ||
          now().getTime() - lastSweepStartedAt >= SWEEP_THROTTLE_MS
        ) {
          await sweepIdle(now(), botId);
        }
        if (!(await admittedBy())) {
          throw new ComputerCapacityError(maxActive);
        }
      }
      touch(botId);
    } catch (error) {
      /*
       * The refusal is the decision; anything else is the provider's list being unreadable, which
       * must not become a new way for every action to fail while /ensure still answers. The cap
       * fails open on that one question and holds on every one it could answer.
       */
      if (error instanceof ComputerCapacityError) throw error;
      log.warn(
        `computer capacity could not be checked, so this start was admitted (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  }

  function reserve(botId: string): Promise<void> {
    const next = reserving.then(() => reserveOnce(botId));
    // Keep the chain alive when a start is refused.
    reserving = next.catch(() => undefined);
    return next;
  }

  async function sweepIdle(
    nowAt = now(),
    excludeBotId?: string,
  ): Promise<string[]> {
    /*
     * One sweep at a time. A nested sweep (a consult that rides a reserve that itself contends)
     * stands aside and returns nothing rather than awaiting the outer one — awaiting would
     * deadlock the outer sweep on its own unfinished promise, and re-sweeping would consult every
     * computer a second time.
     */
    if (sweeping) return [];
    sweeping = true;
    lastSweepStartedAt = nowAt.getTime();
    const stopped: string[] = [];
    try {
      for (const computer of await running()) {
        if (computer.botId === excludeBotId) continue;
        try {
          const control = await options.control?.(computer.botId);
          // A person holding the wheel is activity no timestamp captures, and the one activity that
          // must never be interrupted: a held lease is not idle however long it has been held.
          if (control?.holder === "human") continue;
          const last = latestOf(
            // The run's start, read off the list rather than asked of the computer: asking means
            // locating, and locating means /ensure, which starts the very computer being judged.
            computer.startedAt,
            lastRunActivity.get(computer.botId),
            control?.since,
            control?.request?.updatedAt,
            /*
             * The computer's own last-seen moment: startedAt and since are beginnings, not
             * activity, and lastRunActivity only knows this process — but a deployment's
             * servers sit behind a load balancer, each with its own half of the activity
             * picture. This one field is the signal visible from outside the computer, so a
             * run being driven through another replica reads as live here instead of losing
             * its browser 15 minutes in.
             */
            control?.lastActivity,
          );
          if (last === undefined) continue;
          if (nowAt.getTime() - last > idleMinutes * 60_000) {
            await options.provider.stop(computer.botId);
            stopped.push(computer.botId);
            // The run bookkeeping goes with the computer it described; the disk charge
            // stays, because the supervisor keeps the workspace volume across stops.
            lastRunActivity.delete(computer.botId);
            // The sweep is the one stopper that leaves no audit trail of its own (it bypasses
            // gateway.stopComputer), so the log is the trail round 3 asked for: who was stopped,
            // and how long it had been quiet.
            log.warn(
              `computer idle sweep stopped ${computer.botId} after ${idleMinutes} quiet minutes.`,
            );
          }
        } catch {
          // One computer's unreadable state must not protect every other idler by ending the sweep.
        }
      }
      return stopped;
    } finally {
      sweeping = false;
    }
  }

  function chargeWrite(botId: string, bytes: number): void {
    const used = charged.get(botId) ?? 0;
    if (used + bytes > diskCapBytes) {
      throw new WorkspaceQuotaError(diskGib, used + bytes, diskCapBytes);
    }
    charged.set(botId, used + bytes);
    /*
     * An approximation, recorded because the provider exposes no usage or du seam (the
     * ComputerProvider interface has list/status/stop/reset and nothing that reads disk): the cap
     * counts the bytes this server writes through the gateway seam, not what the browser downloads
     * or a shell creates inside the container, and it over-counts a write that was charged and then
     * failed. Both errors run conservative — a bound that refuses early never lets a workspace
     * past the cap it was promised.
     */
  }

  function resetUsage(botId: string) {
    charged.delete(botId);
  }

  function refundWrite(botId: string, bytes: number) {
    // A write that never landed must not eat the budget either: without this, transient
    // post failures keep the charge and enough of them lock the Bot's write path shut
    // (413) until a workspace wipe — with no bytes on disk to show for it.
    charged.set(botId, Math.max(0, (charged.get(botId) ?? 0) - bytes));
  }

  function forget(botId: string) {
    lastRunActivity.delete(botId);
  }

  return {
    reserve,
    sweepIdle,
    chargeWrite,
    refundWrite,
    resetUsage,
    forget,
  };
}
