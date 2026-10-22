import { createHash, randomUUID } from "node:crypto";
import { toStandardSchema } from "@mastra/core/schema";
import { createTool, type Tool } from "@mastra/core/tools";
// The ONE canonical JSON: the argsDigest is the exactly-once ledger's
// identity basis, so the formula must not fork per call site (this was the
// fifth private copy of the same definition).
import { canonicalJson } from "../ai-observability/datasets";
import { HeadlessToolSuspension } from "../computer/headless-tools";
import { LEARNED_SKILL_TOOL_NAMES } from "../learning/runtime";
import type { GrantedTool } from "../plugins/tools";
import type { LearnedSkillInvocationSurface } from "./execution-contracts";

/*
 * ME04 (#476) T2: the controlled Mastra tool wrapper.
 *
 * Discovery is not grant: the ONLY tools that reach the model are
 * GrantedTools the server resolved through the existing grant + selection
 * path, and the wrapped execute calls the ORIGINAL GrantedTool execute — so
 * every call still flows through the one path that checks the grant,
 * evaluates the policy, resolves the credential and writes the audit row
 * (`plugins/tools.ts` → `store.callTool`). Raw MCP tools are never mounted
 * here.
 *
 * The wrapper itself adds three things and nothing else:
 *  1. mount-time refusals — a duplicate model name, a reserved system name
 *     or an invalid name refuses with a named error instead of letting one
 *     grant silently override another (or the runtime's own tools);
 *  2. run-time guard — the execution's abort signal is checked BEFORE the
 *     granted path runs, so after a stop no NEW external call may start. A
 *     lease-current probe composes the runner's own fencing
 *     (`isRunnerRequestLeaseCurrent` over the runner's `RunnerRequestLease`)
 *     — no second fencing scheme — but this slice's only production assembly
 *     (`execution.ts`) wires the signal alone; the probe is connected by the
 *     approvals-integration wiring (ME09);
 *  3. operation identity — one operationId + argsDigest per logical
 *     operation, keyed by the engine's toolCallId, so a legitimate retry or
 *     recovery of the same call keeps the same identity (ME05's continuation
 *     ledger builds on this).
 *
 * The vendor's answer text is never re-worded: the granted path's own
 * untrusted envelope (vendorAnswer) and refusal marker pass through
 * byte-for-byte, and a granted execute that throws surfaces through the
 * engine's tool-error path, which stream-events already wraps with
 * markUntrusted. Nothing here launders or re-marks outside content.
 */

/** A wrapper refusal: named, thrown before any external call. */
export class MastraToolRefusal extends Error {}

/** The stable identity of one logical tool operation. */
export interface MastraToolOperation {
  readonly toolName: string;
  /** The engine call id this operation is bound to ("" when absent). */
  readonly toolCallId: string;
  /** Stable across retries/recovery of the same toolCallId. */
  readonly operationId: string;
  /** Digest of the exact arguments that went out. */
  readonly argsDigest: string;
}

/**
 * Run-time guard evaluated ahead of every granted execute. `signal` is the
 * execution's existing abort signal (the stop wire); `leaseCurrent` answers
 * "is this run's lease/owner still current" — composed from the runner's
 * `RunnerRequestLease` + `isRunnerRequestLeaseCurrent`, never a new scheme.
 */
export interface MastraToolGuard {
  readonly signal?: AbortSignal;
  readonly leaseCurrent?: () => boolean | Promise<boolean>;
  /** Observes each operation once, before the granted execute runs. */
  readonly onOperation?: (operation: MastraToolOperation) => void;
}

/**
 * Model tool names on this runtime: the granted spelling is
 * `mcp__<server>__<tool>` (selection and grants are written in the `ref`
 * spelling; `toolNameFor` converts once, in plugins). Anything outside this
 * charset — or past 64 characters, the OpenAI tool-name cap (the strictest
 * provider; Anthropic allows 128, which is no reason to admit names OpenAI
 * would refuse) — cannot be addressed safely by every provider and refuses.
 *
 * Exported so the grant write (plugins/store.ts, where `toolNameFor` mints
 * the name) enforces the SAME rule at configuration time; this mount-time
 * check stays as defense in depth for grants written before that gate.
 */
export const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function isReservedToolName(name: string): boolean {
  // The runtime's own system tools: the learned-skill pair (ME08 mounts them
  // through `createMastraLearnedTools`, and nothing else may take the names).
  return LEARNED_SKILL_TOOL_NAMES.has(name);
}

/** The argsDigest of one operation: sha256 over the canonical arguments. */
export function argsDigestFor(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex");
}

/** The engine call id of one tool execution, read defensively. */
function toolCallIdOf(context: unknown): string {
  const carried = context as
    | { agent?: { toolCallId?: unknown }; toolCallId?: unknown }
    | undefined;
  const id = carried?.agent?.toolCallId ?? carried?.toolCallId;
  return typeof id === "string" ? id : "";
}

/**
 * The shared controlled prologue both server-executed wrappers run before
 * anything external happens: the stop wire, the optional lease-current
 * probe, and the ONE operation-identity formula (operationId + argsDigest
 * per engine call id). Extracted when the learned-skill wrapper (ME08)
 * joined, so the identity basis the exactly-once ledger keys on cannot fork
 * into a second private copy.
 */
async function controlledToolOperation(
  toolName: string,
  input: unknown,
  context: unknown,
  guard: MastraToolGuard,
  operations: Map<string, MastraToolOperation>,
): Promise<MastraToolOperation> {
  // Stop wire first: after a stop no NEW external call may start. A named
  // refusal (not a bare AbortError) so the blocked call is diagnosable in
  // whichever transcript receives it.
  if (guard.signal?.aborted) {
    throw new MastraToolRefusal(
      "MASTRA_TOOL_RUN_NOT_CURRENT: the run was stopped before this external call could start.",
    );
  }
  // Then the lease-current probe (the runner's fencing, composed by the
  // caller): a run whose owner is gone starts nothing external.
  if (guard.leaseCurrent && !(await guard.leaseCurrent())) {
    throw new MastraToolRefusal(
      "MASTRA_TOOL_LEASE_NOT_CURRENT: the run's lease/owner is no longer current; new external calls are blocked.",
    );
  }
  // Operation identity: stable per engine call id, so a legitimate
  // retry/recovery of one call keeps one identity. A call whose id the
  // engine never carried is its own logical operation — two unkeyed
  // executes must never merge into one identity — and a repeat of one call
  // id with DIFFERENT arguments is a different operation, not a retry of
  // the old one. Identical callId+args within one run intentionally share
  // the operationId (retry semantics); ME05 dedup must not equate identity
  // uniqueness with single execution.
  const toolCallId = toolCallIdOf(context);
  const argsDigest = argsDigestFor(input);
  const known = toolCallId ? operations.get(toolCallId) : undefined;
  const operation: MastraToolOperation =
    known && known.argsDigest === argsDigest
      ? known
      : {
          toolName,
          toolCallId,
          operationId: `op_${randomUUID()}`,
          argsDigest,
        };
  if (toolCallId) operations.set(toolCallId, operation);
  guard.onOperation?.(operation);
  return operation;
}

/**
 * Wrap each GrantedTool as a Mastra tool whose execute IS the granted
 * executor. Mount-time refusals throw {@link MastraToolRefusal} — a Bot
 * never runs with a half-mounted or overridden toolset.
 */
export function createMastraTools(
  tools: readonly GrantedTool[],
  guard: MastraToolGuard = {},
): Record<string, Tool> {
  // Prototype-less: a granted tool must never be able to name itself into
  // the record's prototype chain (`__proto__`), and an inherited key must
  // never read as an existing mount.
  const record: Record<string, Tool> = Object.create(null);
  const operations = new Map<string, MastraToolOperation>();
  for (const [index, granted] of tools.entries()) {
    if (
      !granted ||
      typeof granted.name !== "string" ||
      typeof granted.execute !== "function"
    ) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_UNKNOWN: tool entry ${index} is not a granted tool; refusing to mount an unknown tool.`,
      );
    }
    if (!VALID_TOOL_NAME.test(granted.name)) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_INVALID: ${JSON.stringify(granted.name)} is not a valid model tool name.`,
      );
    }
    if (isReservedToolName(granted.name)) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_RESERVED: ${granted.name} is a system tool name and cannot be overridden by a grant.`,
      );
    }
    if (record[granted.name]) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_COLLISION: two granted tools claim the model name ${granted.name}; refusing to override.`,
      );
    }
    record[granted.name] = createTool({
      id: granted.name,
      description: granted.description,
      // The grant's own schema: the engine validates the model's arguments
      // against exactly what the grant declared, before anything executes.
      inputSchema: granted.parameters,
      execute: async (input: unknown, context: unknown) => {
        await controlledToolOperation(
          granted.name,
          input,
          context,
          guard,
          operations,
        );
        // The ONE granted execute: grant → policy → credential → audit.
        // Vendor answers arrive already enveloped (vendorAnswer); refusals
        // arrive as "Refused." text; any other throw becomes the engine's
        // tool-error, which stream-events wraps with markUntrusted.
        try {
          return await granted.execute(input);
        } catch (error) {
          if (error instanceof HeadlessToolSuspension) {
            // The governed granted path rethrows HeadlessToolSuspension on
            // purpose (plugins/tools.ts): the legacy approval wait. This
            // engine cannot host that pause — letting it through would drop
            // it into the tool-error branch above, where markUntrusted
            // launders an approval wait into a "vendor tool error" the model
            // reads as a rejection and the human never sees a request. Fail
            // closed with a named refusal instead (ME09's durable approval
            // wiring is the real host).
            throw new MastraToolRefusal(
              "MASTRA_TOOL_SUSPENSION_UNSUPPORTED: this engine cannot pause for an approval; the wait fails the call closed instead of being read as a vendor error.",
            );
          }
          throw error;
        }
      },
    });
  }
  return record;
}

/*
 * ME08 (#480): the learned-skill wrapper — the SAME controlled shape the
 * granted wrapper runs above, for the two RESERVED names the pinned SDK
 * defines (`copilotkit_load_skill` / `copilotkit_read_skill_file`).
 *
 * Discovery is not acquisition: the ONLY tools mounted here come from the
 * outer run's ALREADY-VALIDATED invocation (acquired once per run through
 * `createLearningRuntime().acquire`, whose SDK owns archive verification,
 * the bound revision, the supporting-file scope and the revocation policy).
 * The wrapper adds the same three things the granted wrapper does —
 * mount-time refusals, the run-time guard, and the one operation identity —
 * and its execute calls the invocation's own execute, so a load or a file
 * read is the SDK's real read against the verified snapshot, never a
 * re-implementation. Names outside the reserved pair refuse: this surface
 * cannot grow beyond what Automatic Learning publishes.
 */

/** Guard options for the learned wrapper (the granted set, plus names taken). */
export interface MastraLearnedToolGuard extends MastraToolGuard {
  /**
   * Names already mounted as granted (server-executed) tools. A learned
   * surface claiming one refuses — though `createMastraTools` already
   * refuses any grant carrying a reserved name, so this is defense in
   * depth, not the primary rule.
   */
  readonly grantedNames?: readonly string[];
}

/**
 * Wrap the outer run's validated learned-skill invocation as Mastra tools
 * under their ORIGINAL reserved names. Mount-time refusals throw
 * {@link MastraToolRefusal} — a run never executes with a half-mounted or
 * substituted skill surface.
 */
export function createMastraLearnedTools(
  surface: LearnedSkillInvocationSurface,
  guard: MastraLearnedToolGuard = {},
): Record<string, Tool> {
  // Prototype-less, like the granted record: a learned tool must never be
  // able to name itself into the record's prototype chain.
  const record: Record<string, Tool> = Object.create(null);
  if (!surface || typeof surface.execute !== "function") {
    throw new MastraToolRefusal(
      "MASTRA_LEARNED_SKILL_UNKNOWN: the learned-skill invocation carries no execute; refusing to mount skills without the validated learning surface.",
    );
  }
  const operations = new Map<string, MastraToolOperation>();
  const granted = new Set(guard.grantedNames ?? []);
  for (const [index, spec] of surface.tools.entries()) {
    if (!spec || typeof spec.name !== "string") {
      throw new MastraToolRefusal(
        `MASTRA_LEARNED_TOOL_UNKNOWN: learned tool entry ${index} carries no name; refusing to mount an unknown tool.`,
      );
    }
    if (!LEARNED_SKILL_TOOL_NAMES.has(spec.name)) {
      throw new MastraToolRefusal(
        `MASTRA_LEARNED_TOOL_NAME_FOREIGN: ${JSON.stringify(spec.name)} is not a learned Skill tool name; this surface mounts only the reserved pair Automatic Learning defines.`,
      );
    }
    if (!VALID_TOOL_NAME.test(spec.name)) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_INVALID: ${JSON.stringify(spec.name)} is not a valid model tool name.`,
      );
    }
    if (granted.has(spec.name)) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_COLLISION: a granted tool already claims the model name ${spec.name}; refusing to override.`,
      );
    }
    if (record[spec.name]) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_COLLISION: two learned tools claim the model name ${spec.name}; refusing to override.`,
      );
    }
    const learnedName = spec.name;
    // The same widening the frontend bridge applies: `toStandardSchema`'s
    // generic Tool type is not the record's opaque-tool type; the execute
    // below reads the input as the schema-validated JSON object it is.
    record[learnedName] = createTool({
      id: learnedName,
      // The original reserved name is what the model is offered; the
      // description is the SDK's own, unchanged.
      description: spec.description ?? "",
      // The SDK's own JSON Schema for the arguments: the engine validates
      // the model's arguments against it before anything executes, and the
      // SDK validates them again inside execute (its parse is authoritative).
      inputSchema: toStandardSchema(
        (spec.parameters ?? { type: "object" }) as never,
      ) as never,
      execute: async (input: unknown, context: unknown) => {
        await controlledToolOperation(
          learnedName,
          input,
          context,
          guard,
          operations,
        );
        // The ONE learning execute: the SDK's own load/read against the
        // outer run's verified snapshot. A refusal inside (unknown skill,
        // path outside the skill, revoked content) throws through to the
        // engine's tool-error, which stream-events wraps with markUntrusted
        // — a real, observable failure, never a fabricated result.
        return surface.execute(learnedName, input);
      },
    }) as unknown as Tool;
  }
  return record;
}
