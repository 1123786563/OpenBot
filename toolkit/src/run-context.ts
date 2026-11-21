import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

export const CONTEXT_REVOKED = "context_revoked";
export const CONTEXT_REVOKED_MESSAGE =
  "The run paused because Memory or Learned skill access changed.";

export class RunContextRevokedError extends Error {
  constructor() {
    super(CONTEXT_REVOKED_MESSAGE);
  }
}

export const runContextVersion = z.object({
  kind: z.enum(["memory", "learned_skill"]),
  id: z.string(),
  version: z.string(),
});
export type RunContextVersion = z.infer<typeof runContextVersion>;

type Check = () => Promise<boolean>;

type RunContext = {
  checks: Check[];
  versions: RunContextVersion[];
  revoked: boolean;
};

const active = new AsyncLocalStorage<RunContext>();

export const createRunContext = (): RunContext => ({
  checks: [],
  versions: [],
  revoked: false,
});

export function withRunContext<T>(context: RunContext, run: () => T): T {
  return active.run(context, run);
}

export function withinRunContext<T>(run: () => T): T {
  return active.getStore() ? run() : withRunContext(createRunContext(), run);
}

export function trackRunContext(
  check: Check,
  versions: RunContextVersion[],
): void {
  const context = active.getStore();
  if (!context) return;
  context.checks.push(check);
  context.versions.push(...versions);
}

export function runContextVersions(): RunContextVersion[] | undefined {
  const versions = active.getStore()?.versions;
  return versions?.length ? [...versions] : undefined;
}

export async function verifyRunContext(): Promise<void> {
  const context = active.getStore();
  if (!context) return;
  if (!context.revoked) {
    for (const check of context.checks) {
      if (!(await check().catch(() => false))) {
        context.revoked = true;
        break;
      }
    }
  }
  if (context.revoked) throw new RunContextRevokedError();
}
