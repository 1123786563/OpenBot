import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { personalWorkspaces } from "../db/schema/personal-saas";
import type { AccountGrant, createAccountAccess } from "./account-access";
import {
  type AgentSandboxProvider,
  agentSandboxComputer,
} from "./agent-sandbox";

const status = z.object({
  status: z.enum([
    "not_started",
    "starting",
    "running",
    "stopping",
    "restart_required",
  ]),
  cutoff: z.enum(["confirmed", "failed"]).optional(),
  stopped: z.boolean().optional(),
  leaseExpiresAt: z.int().optional(),
  address: z.url({ protocol: /^http$/ }).optional(),
  token: z.string().min(1).optional(),
});
const storage = z.object({
  used: z.number().int().nonnegative(),
  capacity: z.number().int().positive(),
});
const running = z.object({
  computers: z.array(z.object({ id: z.uuid(), epoch: z.number().int() })),
});
export const workspaceComputerRestartMessage =
  "Start your Computer in your workspace before retrying this task.";
export const workspaceComputerLeaseMs = 15_000;
type Workspace = { id: string; ownerId: string };

type SupervisorConfig = {
  supervisorUrl: string;
  supervisorToken: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export type WorkspaceComputerConfig =
  | SupervisorConfig
  | { agentSandbox: AgentSandboxProvider };

export type ComputerLease = {
  epoch: number;
  issuedAt: number;
  expiresAt: number;
};
export type ComputerTask = { epoch: number; authorizedAt: number };
export type ComputerStatus = z.infer<typeof status>;
export type ComputerGeneration = {
  id: string;
  epoch: number;
  generation?: string;
};

function supervisorComputer(config: SupervisorConfig) {
  const base = new URL("/workspace-computers", config.supervisorUrl).href;
  async function call(
    path = "",
    grant?: {
      epoch: number;
      issuedAt: number;
      expiresAt: number;
      storageBytes?: number;
    },
    method = grant ? "POST" : "GET",
  ) {
    return (config.fetch ?? fetch)(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.supervisorToken}`,
        ...(grant ? { "Content-Type": "application/json" } : {}),
      },
      body: grant ? JSON.stringify(grant) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function read(id: string, task?: ComputerTask) {
    const response = await call(
      `/${id}${task ? `?${new URLSearchParams({ epoch: String(task.epoch), authorizedAt: String(task.authorizedAt) })}` : ""}`,
    );
    if (!response.ok) throw new Error("Managed Computer status unavailable");
    return status.parse(await response.json());
  }

  async function change(
    path: string,
    lease: ComputerLease & { storageBytes?: number },
  ) {
    const response = await call(path, lease);
    if (response.status === 409) return false;
    if (!response.ok) throw new Error("Managed Computer request unavailable");
    return true;
  }

  return {
    read,
    async eraseStorage(id: string) {
      const response = await call(`/${id}/storage`, undefined, "DELETE");
      if (response.status !== 204)
        throw new Error("Workspace Computer cleanup unconfirmed");
    },
    async storageUsage(id: string, storageBytes: number) {
      const response = await call(`/${id}/storage`);
      if (!response.ok) throw new Error("Managed Computer storage unavailable");
      const { used, capacity } = storage.parse(await response.json());
      if (used > capacity || capacity > storageBytes)
        throw new Error("Managed Computer storage exceeds its reservation");
      return used;
    },
    start(id: string, lease: ComputerLease, storageBytes: number) {
      return change(`/${id}/start-with-storage`, { ...lease, storageBytes });
    },
    stop(id: string, lease: ComputerLease) {
      return change(`/${id}/stop`, lease);
    },
    async generations(): Promise<ComputerGeneration[]> {
      const response = await call();
      if (!response.ok) throw new Error("Managed Computer leases unavailable");
      return running.parse(await response.json()).computers;
    },
    revoke: undefined,
    renew({ id }: ComputerGeneration, lease: ComputerLease) {
      return change(`/${id}/renew`, lease);
    },
  };
}

export function workspaceComputer(
  config: WorkspaceComputerConfig,
  database: Database,
  accounts: Pick<ReturnType<typeof createAccountAccess>, "decision" | "verify">,
  now: () => number,
) {
  const backend =
    "agentSandbox" in config
      ? agentSandboxComputer(config.agentSandbox, database, now)
      : supervisorComputer(config);
  const { read } = backend;

  function leaseFor(
    grant: { epoch: number; expiresAt: number },
    issuedAt: number,
  ) {
    return {
      epoch: grant.epoch,
      issuedAt,
      expiresAt: Math.min(grant.expiresAt, issuedAt + workspaceComputerLeaseMs),
    };
  }

  async function ownedWorkspace(id: string, ownerId: string) {
    const [workspace] = await database
      .select({ id: personalWorkspaces.id })
      .from(personalWorkspaces)
      .where(
        and(
          eq(personalWorkspaces.id, id),
          eq(personalWorkspaces.ownerId, ownerId),
        ),
      );
    return workspace;
  }

  return {
    eraseStorage: backend.eraseStorage,
    storageUsage: backend.storageUsage,
    async status(workspaceId: string) {
      const current = await read(workspaceId);
      return { status: current.status, cutoff: current.cutoff };
    },
    async stopped(workspaceId: string) {
      const current = await read(workspaceId);
      return (
        current.stopped ??
        (current.status === "not_started" ||
          (current.status === "restart_required" &&
            current.cutoff === "confirmed"))
      );
    },
    async start(
      workspaceId: string,
      session: AccountGrant,
      storageBytes: number,
    ) {
      const issuedAt = now();
      if (!(await ownedWorkspace(workspaceId, session.accountId))) return false;
      const grant = await accounts.verify(session);
      if (grant.kind !== "active") return false;
      if (
        !(await backend.start(
          workspaceId,
          leaseFor(grant, issuedAt),
          storageBytes,
        ))
      )
        return false;
      return (await accounts.verify(session)).kind === "active";
    },
    async stop(workspaceId: string, session: AccountGrant) {
      if (!(await ownedWorkspace(workspaceId, session.accountId))) return false;
      const grant = await accounts.verify(session);
      if (grant.kind !== "active") return false;
      const issuedAt = now();
      return backend.stop(workspaceId, leaseFor(grant, issuedAt));
    },
    async accessForTask(
      workspaceId: string,
      grant: AccountGrant & { authorizedAt: number },
    ) {
      if (
        !Number.isSafeInteger(grant.authorizedAt) ||
        grant.authorizedAt > now() ||
        !(await ownedWorkspace(workspaceId, grant.accountId)) ||
        (await accounts.verify(grant)).kind !== "active"
      )
        return { kind: "denied" } as const;
      const computer = await read(workspaceId, grant);
      if ((await accounts.verify(grant)).kind !== "active")
        return { kind: "denied" } as const;
      if (computer.status === "starting") return { kind: "starting" } as const;
      if (
        computer.status !== "running" ||
        !computer.address ||
        !computer.token ||
        (computer.leaseExpiresAt !== undefined &&
          now() >= computer.leaseExpiresAt)
      )
        return {
          kind: "restart_required",
          message: workspaceComputerRestartMessage,
        } as const;
      return {
        kind: "running",
        address: computer.address,
        token: computer.token,
      } as const;
    },
    async renew() {
      const computers: ComputerGeneration[] = await backend.generations();
      if (computers.length === 0) return;
      const workspaces: Workspace[] =
        await database.query.personalWorkspaces.findMany({
          columns: { id: true, ownerId: true },
          where: (table, { inArray }) =>
            inArray(
              table.id,
              computers.map(({ id }) => id),
            ),
        });
      const owners = new Map(
        workspaces.map(({ id, ownerId }) => [id, ownerId]),
      );
      const results = await Promise.allSettled(
        computers.map(async (computer) => {
          const owner = owners.get(computer.id);
          const issuedAt = now();
          const grant = owner ? await accounts.decision(owner) : null;
          if (grant?.kind !== "active" || grant.epoch !== computer.epoch) {
            await backend.revoke?.(computer);
            return;
          }
          await backend.renew(computer, leaseFor(grant, issuedAt));
        }),
      );
      if (results.some(({ status }) => status === "rejected")) {
        throw new Error("Managed Computer lease renewal failed");
      }
    },
  };
}
