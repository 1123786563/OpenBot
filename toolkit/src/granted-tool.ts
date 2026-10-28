import { z } from "zod";
import type { AuditInitiator } from "./initiator";

/** A tool a Bot holds, as the built-in runtime is handed it and executes it on the server. */
export type GrantedTool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  /**
   * PKG09: the runtime's own call id, when it carries one.
   *
   * The package dispatch branch uses it as the operation identity, so the
   * prepared row a parked approval left behind is the row the resumed call
   * completes — not an orphan beside a second, randomly-keyed one. Runtimes
   * that carry no id simply omit it (the store mints one per call).
   */
  execute: (
    args: unknown,
    context?: { toolCallId?: string },
  ) => Promise<string>;
  initiator?: AuditInitiator;
  /**
   * `<serverId>/<toolName>`, carried alongside the name the model is offered.
   *
   * The two spellings exist because a model tool name may not contain a slash, and selection has to
   * compare a tool against what a skill declared, which is written in the ref spelling because that
   * is how a grant is written. Carried rather than derived at the comparison, so there is one place
   * the two forms are converted (`toolNameFor`) and no second parser to drift from it.
   */
  ref: string;
};

/**
 * A vendor's JSON Schema as something the model can be handed.
 *
 * Anything that is not an object schema describes something other than a tool's arguments, and a
 * schema we cannot read must not stop the tool being offered: an open object lets the model call it
 * and lets the vendor be the one to reject a bad argument, which is where that error belongs.
 */
export function parametersFor(inputSchema: Record<string, unknown>): z.ZodType {
  try {
    const converted = z.fromJSONSchema(inputSchema as never);
    if (converted instanceof z.ZodObject) return converted;
  } catch {}
  return z.object({}).catchall(z.unknown());
}
