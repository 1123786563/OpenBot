import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { personalWorkspaces } from "../db/schema/personal-saas";
import type { AccountGrant, createAccountAccess } from "./account-access";

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
export const workspaceComputerLeaseMs = 15_000;
type Workspace = { id: string; ownerId: string };

export type WorkspaceComputerConfig = {
  supervisorUrl: string;
  supervisorToken: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

export function workspaceComputer(
  config: WorkspaceComputerConfig,
  database: Database,
  accounts: Pick<ReturnType<typeof createAccountAccess>, "decision" | "verify">,
  now: () => number,
) {
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

  async function read(
    id: string,
    task?: { epoch: number; authorizedAt: number },
  ) {
    const response = await call(
      `/${id}${task ? `?${new URLSearchParams({ epoch: String(task.epoch), authorizedAt: String(task.authorizedAt) })}` : ""}`,
    );
    if (!response.ok) throw new Error("Managed Computer status unavailable");
    return status.parse(await response.json());
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
    async eraseStorage(workspaceId: string) {
      const response = await call(
        `/${workspaceId}/storage`,
        undefined,
        "DELETE",
      );
      if (response.status !== 204)
        throw new Error("Workspace Computer cleanup unconfirmed");
    },
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
    async storageUsage(workspaceId: string, storageBytes: number) {
      const response = await call(`/${workspaceId}/storage`);
      if (!response.ok) throw new Error("Managed Computer storage unavailable");
      const { used, capacity } = storage.parse(await response.json());
      if (used > capacity || capacity > storageBytes)
        throw new Error("Managed Computer storage exceeds its reservation");
      return used;
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
      const response = await call(`/${workspaceId}/start-with-storage`, {
        storageBytes,
        epoch: grant.epoch,
        issuedAt,
        expiresAt: Math.min(
          grant.expiresAt,
          issuedAt + workspaceComputerLeaseMs,
        ),
      });
      if (response.status === 409) return false;
      if (!response.ok) throw new Error("Managed Computer start unavailable");
      return (await accounts.verify(session)).kind === "active";
    },
    async stop(workspaceId: string, session: AccountGrant) {
      if (!(await ownedWorkspace(workspaceId, session.accountId))) return false;
      const grant = await accounts.verify(session);
      if (grant.kind !== "active") return false;
      const issuedAt = now();
      const response = await call(`/${workspaceId}/stop`, {
        epoch: grant.epoch,
        issuedAt,
        expiresAt: Math.min(grant.expiresAt, issuedAt + 15_000),
      });
      if (response.status === 409) return false;
      if (!response.ok) throw new Error("Managed Computer stop unavailable");
      return true;
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
      if (computer.status !== "running" || !computer.address || !computer.token)
        return {
          kind: "restart_required",
          message:
            "Start your Computer in your workspace before retrying this task.",
        } as const;
      return {
        kind: "running",
        address: computer.address,
        token: computer.token,
      } as const;
    },
    async renew() {
      const response = await call();
      if (!response.ok) throw new Error("Managed Computer leases unavailable");
      const { computers } = running.parse(await response.json());
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
        computers.map(async ({ id, epoch }) => {
          const owner = owners.get(id);
          if (!owner) return;
          const issuedAt = now();
          const grant = await accounts.decision(owner);
          if (grant.kind !== "active" || grant.epoch !== epoch) return;
          const result = await call(`/${id}/renew`, {
            epoch,
            issuedAt,
            expiresAt: Math.min(
              grant.expiresAt,
              issuedAt + workspaceComputerLeaseMs,
            ),
          });
          if (!result.ok && result.status !== 409)
            throw new Error("Lease renewal unavailable");
        }),
      );
      if (results.some(({ status }) => status === "rejected")) {
        throw new Error("Managed Computer lease renewal failed");
      }
    },
  };
}
