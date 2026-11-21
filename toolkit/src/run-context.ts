import { AsyncLocalStorage } from "node:async_hooks";

export const CONTEXT_REVOKED = "context_revoked";
export const CONTEXT_REVOKED_MESSAGE =
  "The run paused because Memory or Learned skill access changed.";

type Check = () => Promise<boolean>;

type RunContext = {
  checks: Check[];
  revoked: boolean;
};

const active = new AsyncLocalStorage<RunContext>();

export const createRunContext = (): RunContext => ({ checks: [], revoked: false });

export function withRunContext<T>(context: RunContext, run: () => T): T {
  return active.run(context, run);
}

export function trackRunContext(check: Check): void {
  active.getStore()?.checks.push(check);
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
  if (context.revoked) throw new Error(CONTEXT_REVOKED_MESSAGE);
}
