import { z } from "zod";
import {
  ACTIVE_TASKS_PER_USER,
  TASK_LIMIT_MESSAGE,
} from "../openmuse-tasks/capacity";
import type { OpenMuseTaskStore } from "../openmuse-tasks/store";
import {
  OpenMuseOwnerDisabledError,
  OpenMuseTaskQuotaError,
} from "../openmuse-tasks/store";
import type { GrantedTool } from "../plugins/tools";
import { REFUSAL_MARKER } from "../plugins/tools";
import type { GoalToolRecord } from "./goals";
import type { IdeaToolRecord } from "./ideas";
import type { MemoryToolRecord } from "./memories";

/*
 * C07 (contracts §7, S14): the private OpenMuse Bot's personal-context tools.
 *
 * The P trio's read-only lookups (goalLookupFor / ideaLookupFor /
 * memoryLookupFor) and the T01 create seam, offered to the model as four
 * tools. The owner is the runtime actor, bound when the tools are built —
 * never a tool parameter, so every schema is strict and an identity the model
 * tries to pass is refused rather than honored.
 *
 * S14's observable contract lives in openmuse_task_delegate's result: it
 * carries the Task id and the row's CURRENT status, read back through the
 * store's owner-scoped get, so a reply quoting it cannot claim completion
 * before the row is terminal. No status here is assumed.
 */
export function openMusePersonalTools(options: {
  ownerUserId: string;
  agentId: string;
  goalLookup: (id: string) => Promise<GoalToolRecord | null>;
  ideaLookup: (id: string) => Promise<IdeaToolRecord | null>;
  memoryLookup: (id: string) => Promise<MemoryToolRecord | null>;
  tasks: Pick<OpenMuseTaskStore, "activeTasks" | "create" | "get">;
  /**
   * D01's fence, consulted by the tool seam itself: the interactive chat path reaches these
   * tools with no /api/mobile fence in front of it, so the lookups' own "BOUNDARY RECORDED"
   * premise (only the fenced tasks runner calls them) stopped holding the day C07 wired the
   * chat path. Fenced: every tool refuses, reads included — same 403 the mobile fence gives.
   */
  ownerFenced?: () => Promise<boolean>;
}): GrantedTool[] {
  const {
    ownerUserId,
    agentId,
    goalLookup,
    ideaLookup,
    memoryLookup,
    tasks,
    ownerFenced,
  } = options;
  const fenced = async () =>
    ownerFenced ? await ownerFenced() : false;
  const refuseIfFenced = async (): Promise<string | null> =>
    (await fenced())
      ? `${REFUSAL_MARKER} This account is disabled.`
      : null;
  function tool<T>(
    name: string,
    description: string,
    parameters: z.ZodType<T>,
    execute: (input: T) => Promise<unknown>,
  ): GrantedTool {
    return {
      name: `openmuse_${name}`,
      ref: `openmuse/${name}`,
      description,
      parameters,
      async execute(args) {
        const parsed = parameters.safeParse(args);
        if (!parsed.success)
          return `${REFUSAL_MARKER} ${parsed.error.issues[0]?.message ?? "Invalid OpenMuse tool arguments."}`;
        // A string result is already the tool's own reply to the model (a
        // refusal like the parse one above); everything else serializes.
        const result = await execute(parsed.data);
        return typeof result === "string" ? result : JSON.stringify(result);
      },
    };
  }
  return [
    tool(
      "goal_read",
      "Read one of this person's private OpenMuse goals by id: its title and its milestones' statuses, exactly as stored.",
      z.object({ id: z.string().min(1).max(400) }).strict(),
      async ({ id }) => {
        const refusal = await refuseIfFenced();
        if (refusal !== null) return refusal;
        return (await goalLookup(id)) ?? { notFound: id };
      },
    ),
    tool(
      "idea_read",
      "Read one of this person's private OpenMuse ideas by id: its title and kind. A withdrawn idea no longer answers.",
      z.object({ id: z.string().min(1).max(400) }).strict(),
      async ({ id }) => {
        const refusal = await refuseIfFenced();
        if (refusal !== null) return refusal;
        return (await ideaLookup(id)) ?? { notFound: id };
      },
    ),
    tool(
      "memory_read",
      "Read one of this person's private OpenMuse memories verbatim by id: its text and where it came from.",
      z.object({ id: z.string().min(1).max(400) }).strict(),
      async ({ id }) => {
        const refusal = await refuseIfFenced();
        if (refusal !== null) return refusal;
        return (await memoryLookup(id)) ?? { notFound: id };
      },
    ),
    tool(
      "task_delegate",
      "Delegate work as ONE durable OpenMuse Task: summarize the task and delegate it. The result carries the task id and the Task's CURRENT status, read from the row — quote that status, and never claim the work is done until the row says so. Reuse the same idempotency_key to refer to a Task you already delegated.",
      z
        .object({
          task_summary: z.string().trim().min(1).max(2000),
          idempotency_key: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
      async ({ task_summary, idempotency_key }) => {
        const refusal = await refuseIfFenced();
        if (refusal !== null) return refusal;
        // O04's per-user quota, the same ceiling the create route enforces:
        // each delegated Task offers a full headless agent run, so a model
        // looping task_delegate across turns must not push its owner past
        // the limit. Refused as a string (the tool's convention), naming
        // the quota so the model stops rather than retries.
        // M35: this read is the FAST path only — the bound itself lives in
        // the store's insert (advisory-lock transaction), and a delegation
        // that slips past this check still meets the typed error below.
        if ((await tasks.activeTasks(ownerUserId)) >= ACTIVE_TASKS_PER_USER) {
          return `${REFUSAL_MARKER} The owner's active Task quota is full (${TASK_LIMIT_MESSAGE}); tell the person delegation is unavailable rather than retrying.`;
        }
        let task: Awaited<ReturnType<typeof tasks.create>>["task"];
        try {
          task = (await tasks.create({
            ownerUserId,
            botId: agentId,
            kind: "agent",
            prompt: task_summary,
            idempotencyKey: idempotency_key ?? null,
          })).task;
        } catch (error) {
          // The fence can land between the check above and this insert (the account deletion
          // marker arrives on its own clock): refuse the readable way, the quota's own shape,
          // rather than letting the error unwind out of GrantedTool.execute as a 500.
          if (error instanceof OpenMuseOwnerDisabledError) {
            return `${REFUSAL_MARKER} This account is disabled.`;
          }
          // M35: the insert-side bound — refuse the readable way, the quota's
          // own shape, exactly like the fast path above.
          if (error instanceof OpenMuseTaskQuotaError) {
            return `${REFUSAL_MARKER} The owner's active Task quota is full (${TASK_LIMIT_MESSAGE}); tell the person delegation is unavailable rather than retrying.`;
          }
          throw error;
        }
        // S14: the status in the result is the row's, read back through the
        // owner-scoped get — not the create's snapshot — so a converging retry
        // that lands while the Task runs reports "running", never a canned
        // "queued" and never a claim of completion.
        const row = await tasks.get(ownerUserId, task.id);
        if (!row) throw new Error("The delegated Task could not be read back.");
        return { taskId: row.id, status: row.status };
      },
    ),
  ];
}
