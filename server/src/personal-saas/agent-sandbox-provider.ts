import { and, eq, gt, isNull } from "drizzle-orm";
import type { Sandbox } from "e2b";
import { z } from "zod";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import { personalWorkspaceAgentSandboxes as sandboxes } from "../db/schema/personal-saas";
import type {
  AgentSandboxBinding,
  AgentSandboxObservation,
  AgentSandboxProvider,
} from "./agent-sandbox";
import { createFlashSandboxApi, flashConnection } from "./flash-sandbox-api";
import {
  type ComputerLease,
  workspaceComputerLeaseMs,
} from "./workspace-computer";

const instanceBinding = z.object({
  workspaceId: z.uuid(),
  generation: z.uuid(),
  epoch: z.int().nonnegative(),
  sandboxId: z.string().min(1),
});
const workerExited = z.object({
  kind: z.literal("exited"),
  exitedAt: z.int().nonnegative(),
  issuedAt: z.int().nonnegative(),
  leaseExpiresAt: z.int().nonnegative(),
  pid: z.int().positive(),
  bootId: z.uuid(),
});
const workerNeverStarted = z.object({ kind: z.literal("never_started") });
const workerExit = z.discriminatedUnion("kind", [
  workerExited,
  workerNeverStarted,
]);
const watchdogResponse = z.object({
  binding: instanceBinding,
  observation: z.discriminatedUnion("kind", [
    workerExited,
    workerNeverStarted,
    z.object({ kind: z.literal("starting") }),
    z.object({ kind: z.literal("rejected") }),
    z.object({ kind: z.literal("unconfirmed") }),
    workerExited
      .omit({ exitedAt: true })
      .extend({ kind: z.literal("running") }),
  ]),
});
const runtimeCredentials = flashConnection.extend({
  computerToken: z.string().min(1),
});
const clockUncertaintyMs = 500;

type WatchdogAction =
  | { action: "start"; issuedAt: number; expiresAt: number; token: string }
  | { action: "renew"; issuedAt: number; expiresAt: number }
  | { action: "stop" }
  | { action: "inspect" };
type WatchdogRequest = WatchdogAction & {
  binding: z.infer<typeof instanceBinding>;
};
type Row = typeof sandboxes.$inferSelect;

type FlashWorkerArtifact = { archive: Blob; sha256: string };

async function installWorker(sandbox: Sandbox, artifact: FlashWorkerArtifact) {
  const path = "/root/.openbot-runtime.tar.gz";
  const directory = "/opt/openbot";
  const digest = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(artifact.sha256);
  await sandbox.files.write(path, artifact.archive, {
    user: "root",
    requestTimeoutMs: 20_000,
  });
  await sandbox.commands.run(
    `umask 022 && printf '%s  %s\n' '${digest}' '${path}' | sha256sum -c - && ` +
      `install -d -o 0 -g 0 -m 0755 ${directory} && ` +
      `tar --no-same-owner -xzf ${path} -C ${directory} && ` +
      `chmod 0755 ${directory}/openbot-lease ${directory}/worker && ` +
      `install -d -o 10001 -g 10001 -m 0700 ${directory}/workspace && rm -- ${path}`,
    { user: "root", requestTimeoutMs: 4_000, timeoutMs: 4_000 },
  );
}

async function invokeWatchdog(
  sandbox: Sandbox,
  request: WatchdogRequest,
): Promise<unknown> {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const result = await sandbox.commands.run(
    `/opt/openbot/openbot-lease control ${encoded}`,
    {
      user: "root",
      requestTimeoutMs: 3_000,
      timeoutMs: 3_000,
    },
  );
  return JSON.parse(result.stdout);
}

export function createAgentSandboxProvider(
  config: Parameters<typeof createFlashSandboxApi>[0] & {
    encryptionKey: string;
    artifact: FlashWorkerArtifact;
    provision?: typeof installWorker;
    invoke?: typeof invokeWatchdog;
    fetchWorker?: (url: string, init: RequestInit) => Promise<Response>;
  },
  database: Database,
  now: () => number = Date.now,
): AgentSandboxProvider {
  const api = createFlashSandboxApi(config);
  const allocationScope = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        config.apiUrl,
        config.domain,
        config.template,
        config.apiKey,
      ]),
    )
    .digest("hex");

  function generation(binding: AgentSandboxBinding) {
    return and(
      eq(sandboxes.workspaceId, binding.workspaceId),
      eq(sandboxes.generation, binding.generation),
      eq(sandboxes.epoch, binding.epoch),
      eq(sandboxes.flashScope, allocationScope),
    );
  }

  async function state(binding: AgentSandboxBinding) {
    const [row] = await database
      .select()
      .from(sandboxes)
      .where(generation(binding));
    if (!row)
      throw new Error(
        "Flash allocation belongs to another generation or provider",
      );
    return row;
  }

  function credentialLabel(row: Row) {
    return `flash:${row.workspaceId}:${row.generation}:${row.epoch}:${row.flashSandboxId}`;
  }

  async function credentials(row: Row) {
    const decoded = await unseal(
      row.flashConnection ?? undefined,
      config.encryptionKey,
      credentialLabel(row),
    );
    if (!decoded) throw new Error("Flash runtime credentials unavailable");
    return runtimeCredentials.parse(JSON.parse(decoded));
  }

  async function watchdog(row: Row, action: WatchdogAction) {
    if (!row.flashSandboxId) throw new Error("Flash instance ID unavailable");
    const binding = {
      workspaceId: row.workspaceId,
      generation: row.generation,
      epoch: row.epoch,
      sandboxId: row.flashSandboxId,
    };
    const runtime = api.runtime(binding.sandboxId, await credentials(row));
    const response = watchdogResponse.parse(
      await (config.invoke ?? invokeWatchdog)(runtime, { binding, ...action }),
    );
    if (
      response.binding.workspaceId !== binding.workspaceId ||
      response.binding.generation !== binding.generation ||
      response.binding.epoch !== binding.epoch ||
      response.binding.sandboxId !== binding.sandboxId
    ) {
      throw new Error("Flash watchdog evidence belongs to another instance");
    }
    return response.observation;
  }

  function verifyAcknowledgement(
    result: Awaited<ReturnType<typeof watchdog>>,
    lease: ComputerLease,
  ) {
    if (
      result.kind !== "running" ||
      result.issuedAt !== lease.issuedAt ||
      result.leaseExpiresAt !== lease.expiresAt ||
      result.leaseExpiresAt <= now()
    ) {
      throw new Error("Flash watchdog lease unconfirmed");
    }
  }

  async function recordExit(row: Row) {
    const result = row.flashWorkRequested
      ? await watchdog(row, { action: "stop" })
      : { kind: "never_started" };
    const exit = workerExit.parse(result);
    if (
      exit.kind === "exited" &&
      (exit.issuedAt < row.startedAt ||
        exit.issuedAt > row.issuedAt ||
        exit.leaseExpiresAt > row.expiresAt ||
        exit.leaseExpiresAt <= exit.issuedAt ||
        exit.leaseExpiresAt - exit.issuedAt > workspaceComputerLeaseMs ||
        exit.exitedAt < row.startedAt - clockUncertaintyMs ||
        exit.exitedAt > now() + clockUncertaintyMs)
    ) {
      throw new Error("Flash watchdog exit evidence is invalid");
    }
    await database
      .update(sandboxes)
      .set({ flashWorkerExit: exit, flashConnection: null })
      .where(
        and(
          generation(row),
          eq(sandboxes.phase, "stopping"),
          isNull(sandboxes.flashWorkerExit),
        ),
      );
  }

  return {
    allocationScope,
    async prepare(binding) {
      const [intent] = await database
        .update(sandboxes)
        .set({ flashCreateRequested: true })
        .where(
          and(
            generation(binding),
            eq(sandboxes.phase, "starting"),
            eq(sandboxes.flashCreateRequested, false),
            gt(sandboxes.expiresAt, now()),
          ),
        )
        .returning();
      if (!intent) throw new Error("Flash allocation no longer authorized");

      const allocation = await api.create(binding);
      await database
        .update(sandboxes)
        .set({ flashSandboxId: allocation.id })
        .where(and(generation(binding), isNull(sandboxes.flashSandboxId)));

      if (!allocation.connection)
        throw new Error("Flash returned incomplete runtime credentials");
      const runtime = api.runtime(allocation.id, allocation.connection);
      await (config.provision ?? installWorker)(runtime, config.artifact);

      const encrypted = await seal(
        JSON.stringify({
          ...allocation.connection,
          computerToken: crypto.randomUUID() + crypto.randomUUID(),
        }),
        config.encryptionKey,
        credentialLabel({ ...intent, flashSandboxId: allocation.id }),
      );
      const [prepared] = await database
        .update(sandboxes)
        .set({ flashConnection: encrypted })
        .where(
          and(
            generation(binding),
            eq(sandboxes.phase, "starting"),
            eq(sandboxes.flashSandboxId, allocation.id),
            gt(sandboxes.expiresAt, now()),
          ),
        )
        .returning({ id: sandboxes.flashSandboxId });
      if (!prepared) throw new Error("Flash setup no longer authorized");
    },
    async start(binding, lease) {
      const row = await state(binding);
      if (!row.flashConnection)
        throw new Error("Flash runtime setup unconfirmed");
      const { computerToken } = await credentials(row);
      const [armed] = await database
        .update(sandboxes)
        .set({ flashWorkRequested: true })
        .where(
          and(
            generation(binding),
            eq(sandboxes.phase, "starting"),
            eq(sandboxes.issuedAt, lease.issuedAt),
            eq(sandboxes.expiresAt, lease.expiresAt),
            eq(sandboxes.flashWorkRequested, false),
            gt(sandboxes.expiresAt, now()),
          ),
        )
        .returning();
      if (!armed) throw new Error("Flash work no longer authorized");
      const result = await watchdog(armed, {
        action: "start",
        issuedAt: lease.issuedAt,
        expiresAt: lease.expiresAt,
        token: computerToken,
      });
      verifyAcknowledgement(result, lease);
    },
    async renew(binding, lease) {
      const row = await state(binding);
      if (
        row.phase !== "active" ||
        row.issuedAt !== lease.issuedAt ||
        row.expiresAt !== lease.expiresAt ||
        lease.expiresAt <= now()
      ) {
        throw new Error("Flash renewal no longer authorized");
      }
      verifyAcknowledgement(
        await watchdog(row, {
          action: "renew",
          issuedAt: lease.issuedAt,
          expiresAt: lease.expiresAt,
        }),
        lease,
      );
    },
    async destroy(binding) {
      let row = await state(binding);
      if (row.phase !== "stopping") return;
      if (row.flashCreateRequested && !row.flashSandboxId) {
        const ids = await api.discover(binding);
        const [id] = ids;
        if (ids.length !== 1 || !id) return;
        await database
          .update(sandboxes)
          .set({ flashSandboxId: id })
          .where(and(generation(binding), isNull(sandboxes.flashSandboxId)));
        row = await state(binding);
      }

      // Capture process evidence before sending DELETE. The two operations
      // can finish on different replicas or on opposite sides of a restart.
      if (!row.flashWorkerExit) await recordExit(row);
      if (row.flashSandboxId && row.flashDestroyedAt === null)
        await api.delete(row.flashSandboxId);
    },
    async inspect(binding): Promise<AgentSandboxObservation> {
      const row = await state(binding);
      if (row.phase === "stopping") {
        let destroyedAt = row.flashDestroyedAt;
        if (
          destroyedAt === null &&
          row.flashSandboxId &&
          (await api.isDestroyed(binding, row.flashSandboxId))
        ) {
          destroyedAt = now();
          const [confirmed] = await database
            .update(sandboxes)
            .set({ flashDestroyedAt: destroyedAt, flashConnection: null })
            .where(
              and(
                generation(binding),
                eq(sandboxes.phase, "stopping"),
                isNull(sandboxes.flashDestroyedAt),
              ),
            )
            .returning({ id: sandboxes.flashSandboxId });
          if (confirmed) {
            console.info(
              JSON.stringify({
                type: "agent-sandbox-instance-destroyed",
                ...binding,
                sandboxId: confirmed.id,
                confirmedAt: destroyedAt,
              }),
            );
          }
        }
        if (row.flashCreateRequested && destroyedAt === null)
          return { kind: "unconfirmed" };
        const terminal = workerExit.safeParse(row.flashWorkerExit);
        if (!terminal.success) return { kind: "unconfirmed" };
        return terminal.data.kind === "never_started"
          ? terminal.data
          : { ...terminal.data, clockUncertaintyMs };
      }

      if (row.phase !== "active" || !row.flashSandboxId)
        return { kind: "starting" };
      const observation = await watchdog(row, { action: "inspect" });
      if (observation.kind !== "running") return { kind: "unconfirmed" };

      const address = api.address(row.flashSandboxId);
      const { computerToken, trafficAccessToken } = await credentials(row);
      const ready = await (config.fetchWorker ?? fetch)(`${address}/health`, {
        headers: {
          "e2b-traffic-access-token": trafficAccessToken,
          "x-openbot-computer-token": computerToken,
        },
        signal: AbortSignal.timeout(1_000),
        redirect: "error",
      });
      await ready.body?.cancel();
      if (ready.status !== 200) return { kind: "starting" };
      return {
        kind: "running",
        leaseExpiresAt: observation.leaseExpiresAt,
        endpoint: { address, token: computerToken, trafficAccessToken },
      };
    },
  };
}
