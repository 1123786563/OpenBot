import { and, eq, gt, inArray, lt, lte, ne } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import {
  personalSaasAccounts,
  personalWorkspaceClosures,
  personalWorkspaces,
  personalWorkspaceAgentSandboxes as sandboxes,
  personalWorkspaceAgenticSpaces as spaces,
} from "../db/schema/personal-saas";
import type {
  ComputerGeneration,
  ComputerLease,
  ComputerStatus,
  ComputerTask,
} from "./workspace-computer";

const timestamp = z.int().nonnegative();
export const agentSandboxObservation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("starting") }),
  z.object({ kind: z.literal("unconfirmed") }),
  z.object({ kind: z.literal("never_started") }),
  z.object({
    kind: z.literal("running"),
    leaseExpiresAt: timestamp,
    endpoint: z
      .object({
        address: z.url({ protocol: /^https?$/ }),
        token: z.string().min(1),
        trafficAccessToken: z.string().min(1).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("exited"),
    exitedAt: timestamp,
    leaseExpiresAt: timestamp,
    clockUncertaintyMs: timestamp.optional(),
  }),
]);

export type AgentSandboxObservation = z.infer<typeof agentSandboxObservation>;
export type AgentSandboxBinding = {
  workspaceId: string;
  generation: string;
  epoch: number;
};

/**
 * The execution-side authority installs the absolute lease before running any
 * managed process, rejects late or reordered leases, and enforces the deadline
 * during control-plane loss. Destroy seals this generation against delayed
 * starts and renewals. Terminal observations require evidence of that seal
 * and an actual exit (or proof that no process was ever admitted). For
 * Flash, terminal also requires independent instance deletion evidence.
 */
export type AgentSandboxProvider = {
  allocationScope?: string;
  // storageBytes is the account's Computer reservation. prepare refuses before
  // allocating unless the durable storage is confirmed to be exactly that size;
  // storageUsage reports its used bytes, or null when they cannot be confirmed.
  eraseStorage?(storage: typeof spaces.$inferSelect): Promise<void>;
  storageUsage?(
    storage: typeof spaces.$inferSelect,
    storageBytes: number,
  ): Promise<number | null>;
  prepare?(binding: AgentSandboxBinding, storageBytes: number): Promise<void>;
  start(binding: AgentSandboxBinding, lease: ComputerLease): Promise<void>;
  renew(binding: AgentSandboxBinding, lease: ComputerLease): Promise<void>;
  destroy(binding: AgentSandboxBinding): Promise<void>;
  inspect(binding: AgentSandboxBinding): Promise<AgentSandboxObservation>;
};

type Sandbox = typeof sandboxes.$inferSelect;

function binding({ workspaceId, generation, epoch }: Sandbox) {
  return { workspaceId, generation, epoch };
}

export function agentSandboxComputer(
  provider: AgentSandboxProvider,
  database: Database,
  now: () => number,
) {
  async function get(workspaceId: string) {
    const [row] = await database
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.workspaceId, workspaceId));
    return row;
  }

  function sameGeneration(row: Sandbox) {
    return and(
      eq(sandboxes.workspaceId, row.workspaceId),
      eq(sandboxes.generation, row.generation),
    );
  }

  async function seal(row: Sandbox) {
    await database
      .update(sandboxes)
      .set({ phase: "stopping" })
      .where(
        and(
          sameGeneration(row),
          inArray(sandboxes.phase, ["starting", "active"]),
        ),
      );
  }

  async function destroy(row: Sandbox) {
    await seal(row);
    await provider.destroy(binding(row)).catch(() => undefined);
  }

  async function read(
    workspaceId: string,
    task?: ComputerTask,
  ): Promise<ComputerStatus> {
    const row = await get(workspaceId);
    if (!row) return { status: "not_started" };
    if (row.phase === "stopped")
      return {
        status: "restart_required",
        cutoff: row.cutoff ?? undefined,
        stopped: true,
      };
    if (
      task &&
      (task.epoch !== row.epoch || task.authorizedAt <= row.startedAt)
    )
      return { status: "restart_required" };

    const observation = await provider
      .inspect(binding(row))
      .then((result) => agentSandboxObservation.parse(result))
      .catch((): AgentSandboxObservation => ({ kind: "unconfirmed" }));
    const observedAt = now();
    const current = await get(workspaceId);
    if (!current || current.generation !== row.generation)
      return { status: "starting" };
    if (current.phase === "stopped")
      return {
        status: "restart_required",
        cutoff: current.cutoff ?? undefined,
        stopped: true,
      };

    if (
      observation.kind === "never_started" ||
      (observation.kind === "exited" &&
        observation.exitedAt + (observation.clockUncertaintyMs ?? 0) >=
          current.startedAt &&
        observation.exitedAt <= observedAt &&
        observation.leaseExpiresAt > current.startedAt &&
        observation.leaseExpiresAt <= current.expiresAt)
    ) {
      const cutoff =
        observation.kind === "never_started" ||
        observation.exitedAt + (observation.clockUncertaintyMs ?? 0) <=
          observation.leaseExpiresAt
          ? "confirmed"
          : "failed";
      const [confirmed] = await database
        .update(sandboxes)
        .set({ phase: "stopped", cutoff })
        .where(and(sameGeneration(row), ne(sandboxes.phase, "stopped")))
        .returning({ generation: sandboxes.generation });
      if (confirmed && observation.kind === "exited") {
        console.info(
          JSON.stringify({
            type: "agent-sandbox-exit-confirmed",
            ...binding(current),
            leaseExpiresAt: observation.leaseExpiresAt,
            exitedAt: observation.exitedAt,
            clockUncertaintyMs: observation.clockUncertaintyMs,
            confirmedAt: observedAt,
            cutoff,
          }),
        );
      }
      return { status: "restart_required", cutoff, stopped: true };
    }

    if (current.phase === "stopping") return { status: "stopping" };
    if (
      now() >= current.expiresAt ||
      observation.kind === "exited" ||
      (observation.kind === "running" &&
        (observation.leaseExpiresAt <= now() ||
          observation.leaseExpiresAt > current.expiresAt))
    ) {
      await seal(current);
      return { status: "stopping" };
    }
    if (observation.kind === "unconfirmed")
      return { status: current.phase === "starting" ? "starting" : "stopping" };
    if (current.phase === "starting" || observation.kind === "starting")
      return { status: "starting" };

    return {
      status: "running",
      leaseExpiresAt: observation.leaseExpiresAt,
      ...observation.endpoint,
    };
  }

  return {
    read,
    async storageUsage(workspaceId: string, storageBytes: number) {
      const [storage] = await database
        .select()
        .from(spaces)
        .where(eq(spaces.workspaceId, workspaceId));
      if (!storage) return 0;
      return provider.storageUsage?.(storage, storageBytes) ?? null;
    },
    async eraseStorage(workspaceId: string) {
      const result = await read(workspaceId);
      if (result.status !== "not_started" && !result.stopped)
        throw new Error("Workspace Computer cleanup unconfirmed");
      const [storage] = await database
        .select()
        .from(spaces)
        .where(eq(spaces.workspaceId, workspaceId));
      if (!storage) return;
      if (!provider.eraseStorage)
        throw new Error("Workspace Computer storage cleanup unconfirmed");
      await provider.eraseStorage(storage);
    },
    async start(
      workspaceId: string,
      lease: ComputerLease,
      storageBytes: number,
      refresh?: () => Promise<ComputerLease | undefined>,
    ) {
      if (now() >= lease.expiresAt || (provider.prepare && !refresh))
        return false;
      const reservation = {
        workspaceId,
        ...lease,
        startedAt: lease.issuedAt,
        // While preparing, this closes a stalled slot reservation. No work
        // grant can be sent until the account has authorized a fresh lease.
        expiresAt: provider.prepare ? now() + 30_000 : lease.expiresAt,
        generation: crypto.randomUUID(),
        phase: "starting" as const,
        cutoff: null,
        flashScope: provider.allocationScope ?? null,
        flashCreateRequested: false,
        flashSandboxId: null,
        flashAgenticSpaceId: null,
        flashConnection: null,
        flashWorkRequested: false,
        flashWorkerExit: null,
        flashDestroyedAt: null,
      };
      const row = await database.transaction(async (tx) => {
        // Serialize the reservation with closure acceptance on the owner row.
        // Every pre-closure generation is then visible to the cutoff sweep.
        const [owner] = await tx
          .select({ id: personalSaasAccounts.id })
          .from(personalSaasAccounts)
          .innerJoin(
            personalWorkspaces,
            eq(personalWorkspaces.ownerId, personalSaasAccounts.id),
          )
          .where(eq(personalWorkspaces.id, workspaceId))
          .for("update", { of: personalSaasAccounts });
        if (!owner) return;
        const [closure] = await tx
          .select({ id: personalWorkspaceClosures.id })
          .from(personalWorkspaceClosures)
          .where(eq(personalWorkspaceClosures.workspaceId, workspaceId))
          .limit(1);
        if (closure) return;
        const [reserved] = await tx
          .insert(sandboxes)
          .values(reservation)
          .onConflictDoUpdate({
            target: sandboxes.workspaceId,
            set: reservation,
            setWhere: and(
              eq(sandboxes.phase, "stopped"),
              lte(sandboxes.epoch, lease.epoch),
              lt(sandboxes.issuedAt, lease.issuedAt),
            ),
          })
          .returning();
        return reserved;
      });
      if (!row) return false;
      try {
        // An error leaves an ambiguous allocation. Reconcile by generation;
        // issuing another create could allocate a second Computer.
        if (now() >= row.expiresAt) {
          await destroy(row);
          return false;
        }
        let workLease = lease;
        if (provider.prepare && refresh) {
          await provider.prepare(binding(row), storageBytes);
          const authorized = await refresh();
          if (
            !authorized ||
            authorized.epoch !== row.epoch ||
            now() >= authorized.expiresAt
          ) {
            await destroy(row);
            return false;
          }
          const [granted] = await database
            .update(sandboxes)
            .set({
              issuedAt: authorized.issuedAt,
              expiresAt: authorized.expiresAt,
            })
            .where(
              and(
                sameGeneration(row),
                eq(sandboxes.phase, "starting"),
                gt(sandboxes.expiresAt, now()),
              ),
            )
            .returning({ generation: sandboxes.generation });
          if (!granted) {
            await destroy(row);
            return false;
          }
          workLease = authorized;
        }
        await provider.start(binding(row), workLease);
        if (now() >= workLease.expiresAt) {
          await destroy(row);
          return false;
        }
        const [accepted] = await database
          .update(sandboxes)
          .set({ phase: "active" })
          .where(and(sameGeneration(row), eq(sandboxes.phase, "starting")))
          .returning({ generation: sandboxes.generation });
        return Boolean(accepted);
      } catch {
        await destroy(row);
        return false;
      }
    },
    async stop(workspaceId: string, lease: ComputerLease) {
      const row = await get(workspaceId);
      if (!row || row.phase === "stopped") return true;
      if (
        lease.epoch < row.epoch ||
        lease.issuedAt < row.startedAt ||
        now() >= lease.expiresAt
      )
        return false;
      await destroy(row);
      return true;
    },
    async generations(): Promise<ComputerGeneration[]> {
      return database
        .select({
          id: sandboxes.workspaceId,
          generation: sandboxes.generation,
          epoch: sandboxes.epoch,
        })
        .from(sandboxes)
        .where(ne(sandboxes.phase, "stopped"));
    },
    async revoke({ id, generation }: ComputerGeneration) {
      const row = await get(id);
      if (!row || row.generation !== generation || row.phase === "stopped")
        return;
      await destroy(row);
      await read(id);
    },
    async renew({ id, generation }: ComputerGeneration, lease: ComputerLease) {
      const row = await get(id);
      if (!row || row.generation !== generation || row.phase === "stopped")
        return false;
      if (row.phase === "stopping" || now() >= row.expiresAt) {
        await destroy(row);
        await read(id);
        return false;
      }
      if (
        row.phase !== "active" ||
        lease.epoch !== row.epoch ||
        lease.issuedAt <= row.issuedAt ||
        lease.expiresAt <= row.expiresAt ||
        now() >= lease.expiresAt
      )
        return false;
      const [offered] = await database
        .update(sandboxes)
        .set({ issuedAt: lease.issuedAt, expiresAt: lease.expiresAt })
        .where(
          and(
            sameGeneration(row),
            eq(sandboxes.phase, "active"),
            eq(sandboxes.issuedAt, row.issuedAt),
            gt(sandboxes.expiresAt, now()),
          ),
        )
        .returning({ generation: sandboxes.generation });
      if (!offered) return false;
      try {
        await provider.renew(binding(row), lease);
        return true;
      } catch {
        await destroy(row);
        throw new Error("Agent Sandbox lease renewal unconfirmed");
      }
    },
  };
}
