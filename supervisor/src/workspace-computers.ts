type Grant = { epoch: number; issuedAt: number; expiresAt: number };
type Process = {
  status: string;
  finishedAt?: number;
  address?: string;
  token?: string;
};
type Run = {
  grant: Grant;
  startedWith: number;
  launching: boolean;
  stopping: boolean;
  closed: boolean;
  settled: boolean;
  cutoff?: "confirmed" | "failed";
};

const maxGrantMs = 15_000;
const exitGraceMs = 3_000;

export function workspaceComputers(runtime: {
  now: () => number;
  launch: (id: string, mayStart: () => boolean) => Promise<void>;
  stop: (id: string) => Promise<void>;
  inspect: (id: string) => Promise<Process | null>;
}) {
  const runs = new Map<string, Run>();
  const valid = (grant: Grant) => {
    const now = runtime.now();
    return (
      Number.isSafeInteger(grant.epoch) &&
      grant.epoch >= 0 &&
      Number.isSafeInteger(grant.issuedAt) &&
      Number.isSafeInteger(grant.expiresAt) &&
      grant.issuedAt <= now &&
      grant.expiresAt <= grant.issuedAt + maxGrantMs &&
      now < grant.expiresAt - exitGraceMs
    );
  };

  function fail(id: string, run: Run) {
    if (run.cutoff === "failed") return;
    run.cutoff = "failed";
    console.error(
      JSON.stringify({
        type: "workspace-computer-cutoff-failed",
        workspaceId: id,
        expiresAt: run.grant.expiresAt,
      }),
    );
  }

  async function reconcile(id: string, run: Run) {
    if (
      run.settled ||
      (runtime.now() < run.grant.expiresAt - exitGraceMs && !run.closed)
    )
      return;
    run.closed = true;
    if (!run.cutoff && runtime.now() >= run.grant.expiresAt) fail(id, run);
    if (run.stopping) return;
    run.stopping = true;
    try {
      await runtime.stop(id);
      const process = await runtime.inspect(id);
      if (!run.launching && (!process || process.status === "created")) {
        run.settled = true;
      }
      if (!run.launching && process?.status === "exited") {
        run.settled = true;
        if (
          process.finishedAt &&
          process.finishedAt <= run.grant.expiresAt &&
          runtime.now() <= run.grant.expiresAt
        ) {
          if (!run.cutoff) {
            run.cutoff = "confirmed";
            console.info(
              JSON.stringify({
                type: "workspace-computer-cutoff-confirmed",
                workspaceId: id,
                finishedAt: process.finishedAt,
                expiresAt: run.grant.expiresAt,
              }),
            );
          }
        } else {
          fail(id, run);
        }
      }
    } catch {
      // Retry from the local sweep. The time limit still applies to exit confirmation.
    } finally {
      run.stopping = false;
      if (!run.settled && !run.cutoff && runtime.now() >= run.grant.expiresAt)
        fail(id, run);
    }
  }

  return {
    async start(id: string, grant: Grant) {
      const prior = runs.get(id);
      if (
        !valid(grant) ||
        (prior &&
          (prior.stopping ||
            prior.launching ||
            !prior.closed ||
            grant.epoch < prior.grant.epoch ||
            grant.issuedAt <= prior.grant.issuedAt))
      )
        return false;
      const run: Run = {
        grant,
        startedWith: grant.issuedAt,
        launching: true,
        stopping: false,
        closed: false,
        settled: false,
      };
      runs.set(id, run);
      const mayStart = () => !run.closed && valid(run.grant);
      try {
        const existing = await runtime.inspect(id);
        if (existing && !["created", "exited"].includes(existing.status)) {
          run.closed = true;
          return false;
        }
        if (!mayStart()) return false;
        await runtime.launch(id, mayStart);
        return mayStart();
      } catch (error) {
        if (!mayStart()) return false;
        run.closed = true;
        throw error;
      } finally {
        run.launching = false;
        await reconcile(id, run);
      }
    },
    async stop(id: string, grant: Grant) {
      const run = runs.get(id);
      if (!run) return true;
      if (grant.epoch < run.grant.epoch || grant.issuedAt < run.startedWith)
        return false;
      run.closed = true;
      await reconcile(id, run);
      return true;
    },
    renew(id: string, grant: Grant) {
      const run = runs.get(id);
      if (
        !run ||
        run.closed ||
        !valid(run.grant) ||
        !valid(grant) ||
        grant.epoch !== run.grant.epoch ||
        grant.issuedAt <= run.grant.issuedAt
      )
        return false;
      run.grant = grant;
      return true;
    },
    async status(id: string, task?: { epoch: number; authorizedAt: number }) {
      const run = runs.get(id);
      const process = await runtime.inspect(id);
      if (run && !run.launching && process?.status === "exited")
        run.closed = true;
      if (run && !run.closed && valid(run.grant)) {
        const ready = !run.launching && process?.status === "running";
        const authorized =
          ready &&
          task?.epoch === run.grant.epoch &&
          task.authorizedAt >= run.startedWith;
        return {
          status: ready ? "running" : "starting",
          ...(authorized
            ? { address: process.address, token: process.token }
            : {}),
        };
      }
      return {
        status:
          process && !["exited", "created"].includes(process.status)
            ? "stopping"
            : run || process
              ? "restart_required"
              : "not_started",
        cutoff: run?.cutoff,
      };
    },
    active() {
      return [...runs].flatMap(([id, run]) =>
        !run.closed && valid(run.grant) ? [{ id, epoch: run.grant.epoch }] : [],
      );
    },
    async sweep() {
      await Promise.all([...runs].map(([id, run]) => reconcile(id, run)));
    },
  };
}
