import { toStandardSchema } from "@mastra/core/schema";
import { createTool, type Tool } from "@mastra/core/tools";
import type { FrontendToolDefinition } from "./execution-contracts";
import { isReservedToolName, VALID_BRIDGE_TOOL_NAME, wireName } from "./tools";

/*
 * ME06 (#478): the frontend (client-participation) tool bridge.
 *
 * A tool that needs the browser is registered on the client
 (`useFrontendTool` — the computer tools, the gallery tools, the sandboxed
 * UI). The server never executes it and never fabricates its result: the
 * engine mounts an INERT bridge whose only behaviors are
 *
 *   1. first run  — suspend the engine at the call (the `tool-call-suspended`
 *      pause), after the TOOL_CALL_START/ARGS events have streamed to the
 *      client, persisting the suspend payload {kind, toolCallId, toolName,
 *      args} the continuation and any re-suspension read back;
 *   2. resume run — `context.agent.resumeData` IS the authenticated client
 *      result; the bridge returns it as the tool result, and the loop
 *      continues from real participation.
 *
 * The suspend/resumeData surface is the pinned engine's own built-in pattern
 * (ask_user / submit_plan in @mastra/core 1.64.0); the integration suite
 * asserts the execute-context shape against the locked version (re-review
 * O11). Suspension durability is the ME05-proven storage-backed stack — with
 * the tenant storage wired, the pause persists and a fresh process can resume
 * it; without one it stays in-process, exactly the pre-ME05 footing.
 *
 * The granted wrapper (tools.ts) stays the ONLY path for server-executable
 * tools: a bridge executes no grant, calls no vendor, writes no audit row,
 * because there is nothing server-side to execute. Governance for the
 * client's own action lives where it always did — the client's authenticated
 * handler and, for the computer writes, the server's durable approval gate
 * (`/api/approvals/computer/<botId>`) the handler posts to before returning.
 */

/** The suspension payload one bridge persists into the engine snapshot. */
export interface FrontendSuspendPayload {
  readonly kind: "frontend_tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
}

/** A wrapper refusal: named, thrown before anything waits or returns. */
class FrontendBridgeRefusal extends Error {}

export interface CreateFrontendBridgeToolsOptions {
  /**
   * Names already mounted as granted (server-executed) tools. A client
   * declaration colliding with one is DROPPED — the granted tool is the
   * server's authority and must never be shadowed by what the wire declared
   * (the mirror image of the granted wrapper's mount-time collision refusal,
   * which guards two server claims). Matching is in the engine's WIRE
   * spelling (wireName): the underscore twin of a dotted grant collides too
   * (F18-4), because that is the pair the engine collapses to one name
   * before any provider dial.
   */
  readonly grantedNames?: readonly string[];
  /** Test/diagnostic probe: observes the execute context the engine hands the bridge. */
  readonly onExecuteContext?: (context: unknown) => void;
}

/**
 * Mount the client-declared tools as inert bridges. Names are validated with
 * the client-facing charset (VALID_BRIDGE_TOOL_NAME — `[A-Za-z0-9_-]`, no
 * dot): the AG-UI tool list is third-party input the client controls per
 * request, so a name outside the wire-safe charset degrades THAT tool —
 * dropped at mount with one structured diagnostic, the chat continues —
 * rather than being mounted and costing the whole run. The fail-hard shape
 * is the pinned engine's own: `@mastra/core` 1.64.0 `formatTools` rewrites
 * every invalid character to `_`, so a declared `computer.navigate` beside
 * the legal `computer_navigate` reaches the model as the same name and
 * throws AGENT_TOOL_NAME_COLLISION before any provider dial. Brokered /
 * granted names keep the looser VALID_TOOL_NAME (dot admitted) in tools.ts;
 * the division is recorded there. A repeated client name keeps its FIRST
 * declaration (the AG-UI tool list is a set — a duplicate is a wire artifact,
 * not a second tool).
 */
export function createFrontendBridgeTools(
  definitions: readonly FrontendToolDefinition[],
  options: CreateFrontendBridgeToolsOptions = {},
): Record<string, Tool> {
  const record: Record<string, Tool> = Object.create(null);
  // F18-4 (T35): granted names enter the collision set in their WIRE
  // spelling. The engine rewrites every `.` to `_` before the wire (the
  // pinned formatTools behavior), so a client declaration of the underscore
  // twin of a dotted grant — `github_get_current_user` beside the granted
  // `github.get_current_user` — used to pass the exact-match set, mount, and
  // collapse the run at the engine's AGENT_TOOL_NAME_COLLISION; normalized
  // here, that declaration is dropped at mount instead (fail-soft, one
  // structured diagnostic). Client names carry no dot
  // (VALID_BRIDGE_TOOL_NAME), so the normalized spelling is lossless: an
  // exact-match collision and a wire-twin collision both land in this set.
  const granted = new Set((options.grantedNames ?? []).map(wireName));
  const mounted = new Set<string>();
  for (const definition of definitions) {
    const name = definition?.name;
    const dropReason =
      !definition || typeof name !== "string"
        ? "invalid declaration (no string name)"
        : !VALID_BRIDGE_TOOL_NAME.test(name)
          ? "invalid tool name"
          : isReservedToolName(name)
            ? "reserved tool name"
            : granted.has(name)
              ? "collides with a granted (server-executed) tool"
              : mounted.has(name)
                ? "duplicate client declaration"
                : null;
    if (dropReason !== null) {
      // F5 (fix-round-1): a silent drop hides a mount the model will never
      // see — one structured line names the dropped tool and the reason
      // (never the args) so a wire/collision surprise stays diagnosable.
      // biome-ignore lint/suspicious/noConsole: stable-code operational log
      console.warn({
        event: "mastra_frontend_tool_declaration_dropped",
        toolName: typeof name === "string" ? name : undefined,
        reason: dropReason,
      });
      continue;
    }
    mounted.add(name);
    // The bridge's execute reads the input as the opaque client payload it
    // is (the client's own schema governs it); the mounted Tool is widened
    // to the record's opaque-tool type on purpose.
    record[definition.name] = createTool({
      id: definition.name,
      description: definition.description ?? "",
      // The client's own declared argument schema, verbatim: the engine
      // validates the model's arguments against exactly what the browser
      // registered. The bridge never executes, so this schema governs only
      // the call shape, not any server authority.
      inputSchema: toStandardSchema(
        (definition.parameters ?? { type: "object" }) as never,
      ) as never,
      execute: async (input: unknown, context: unknown) => {
        options.onExecuteContext?.(context);
        // The ask-user shape, read exactly as the pinned engine's own
        // built-ins read it: `context.agent.{resumeData, suspend, toolCallId}`.
        const ctx = context as
          | {
              agent?: {
                resumeData?: unknown;
                suspend?: unknown;
                toolCallId?: unknown;
              };
              toolCallId?: unknown;
            }
          | undefined;
        const resumeData = ctx?.agent?.resumeData;
        if (resumeData !== undefined) {
          // The authenticated client result, as the client returned it — the
          // one value the model may read as this call's outcome. Never
          // re-worded, never synthesized.
          return resumeData;
        }
        const suspend = ctx?.agent?.suspend;
        if (typeof suspend !== "function") {
          // Out-of-run invocation (no engine to pause): fail closed with a
          // named refusal instead of returning a fabricated result.
          throw new FrontendBridgeRefusal(
            "MASTRA_FRONTEND_TOOL_SUSPEND_UNAVAILABLE: the bridge can only wait inside an engine run; there is no participation surface to suspend on here.",
          );
        }
        const payload: FrontendSuspendPayload = {
          kind: "frontend_tool",
          toolCallId:
            typeof ctx?.agent?.toolCallId === "string"
              ? ctx.agent.toolCallId
              : typeof ctx?.toolCallId === "string"
                ? ctx.toolCallId
                : "",
          toolName: definition.name,
          args: input,
        };
        await (suspend as (payload: unknown) => Promise<void>)(payload);
        // In an agent run the suspend pauses the step and this return is
        // never read; it exists so a hostile/greedy engine that ignores the
        // pause still cannot read a fabricated tool result.
        return {
          waiting: true,
          kind: "frontend_tool",
          toolCallId: payload.toolCallId,
        };
      },
    }) as unknown as Tool;
  }
  return record;
}
