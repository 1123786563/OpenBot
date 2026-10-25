import { createHash, randomUUID } from "node:crypto";
import { toStandardSchema } from "@mastra/core/schema";
import { createTool, type Tool } from "@mastra/core/tools";
import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
// The ONE canonical JSON: the argsDigest is the exactly-once ledger's
// identity basis, so the formula must not fork per call site (this was the
// fifth private copy of the same definition).
import { canonicalJson } from "../ai-observability/datasets";
import type { ApprovalContinuation } from "../approvals/types";
import { withApprovalContext } from "../approvals/types";
import type { AuditInitiator } from "../audit";
import { LEARNED_SKILL_TOOL_NAMES } from "../learning/runtime";
import { REFUSAL_MARKER } from "../plugins/tools";
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
  /**
   * ME10 (F4): the unattended run's approval binding, present on the
   * governed headless assembly. When set, a granted execute runs inside the
   * approvals subsystem's context ALS — an approval ask opens its request
   * against THIS run (run id, thread, initiator) instead of refusing with
   * "not started from a conversation that can ask you" — and a pending wait
   * parks the engine durably (the `suspend()` surface the frontend bridge
   * uses), saving the ME05 continuation through the wiring's
   * save-before-waiting hook. The decision later resumes the exact parked
   * call through the six-gate orchestrator.
   */
  readonly approvalBinding?: {
    readonly runId: string;
    readonly threadId: string;
    readonly initiator?: AuditInitiator;
  };
}

/**
 * Model tool names on this runtime: the granted spelling is
 * `mcp__<server>__<tool>` (selection and grants are written in the `ref`
 * spelling; `toolNameFor` converts once, in plugins). Anything outside this
 * charset — or past 64 characters, the OpenAI tool-name cap (the strictest
 * provider) — refuses.
 *
 * The dot is admitted (UP10/#489 integration evidence chain): MCP tool
 * naming legally carries it and real brokered servers use it — OpenConnector's
 * action ids are dotted (`github.get_current_user`), and the brokered enable/
 * grant flow offers exactly those names, so the earlier `[A-Za-z0-9_-]`
 * charset refused every real OpenConnector grant at configuration time. The
 * 64-character cap and every other character stay as they were; a dot makes
 * no path (a `/` is still refused) and no prototype (mount records are
 * null-prototype) on this runtime.
 *
 * The dot's provider edge, on the record (#489 F03/C-M1; the anthropic side
 * adjudicated by F14 T26 / R13 F13-1): OpenAI's official function-name
 * charset is `^[a-zA-Z0-9_-]{1,64}$`, and Anthropic's Messages tool-name
 * charset is the same family at `^[a-zA-Z0-9_-]{1,128}$` — neither admits
 * a dot — so the "strictest provider" claim above holds for the LENGTH
 * only; on charset this runtime is deliberately looser than both. That
 * looseness is argued safe for the gateway/OpenAI-compatible endpoints
 * brokered tool calls ride (they forward the minted name as-is and accept
 * dotted names); a deployment pointing an `openai` provider straight at
 * api.openai.com — or an `anthropic` provider straight at
 * api.anthropic.com — is caught at the dial itself: the F11-1 guard in
 * enterprise/models/gateway.ts (directDottedToolName, branch-on-provider
 * since T26) answers 400 MASTRA_TOOL_NAME_INVALID naming the offending
 * mount, so the whole chat fails named and at home rather than lost to the
 * upstream wire charset; an ANTHROPIC_BASE_URL gateway is exempt exactly as
 * an OpenAI-compatible one is. The guard judges directness on
 * new Request(url).url — the same normalization the dial itself fetches
 * through (F01-R11-M1) — so a defaulted port or host case cannot slip a
 * dotted name past it. If a direct public API ever needs first-class
 * support — a dotted name that RIDES rather than being refused — the
 * shape is a name-alias/scrubbing layer between mount and wire: a follow-up
 * item, deliberately not built here.
 *
 * Exported so the grant write (plugins/store.ts, where `toolNameFor` mints
 * the name) enforces the SAME rule at configuration time; this mount-time
 * check stays as defense in depth for grants written before that gate.
 *
 * The stricter charset below is a DELIBERATE second rule, and the split is
 * the record (F16-2): this constant governs brokered/granted names — admin
 * configuration, where a dotted name a provider cannot take is a
 * configuration mistake the F11-1 guard answers once, loudly, for the whole
 * chat. VALID_BRIDGE_TOOL_NAME governs CLIENT declarations — the AG-UI tool
 * list is third-party input controllable per request, so a name outside the
 * wire-safe charset must degrade that ONE tool (dropped at mount,
 * structured diagnostic, chat continues) instead of costing the whole run.
 * The observed fail-hard shape is the pinned engine's, not the dial's:
 * `@mastra/core` 1.64.0 `formatTools` rewrites invalid characters to `_`
 * before the wire, so a declared `computer.navigate` beside the legal
 * `computer_navigate` becomes one name and throws
 * AGENT_TOOL_NAME_COLLISION before any provider request. Do not reuse
 * VALID_TOOL_NAME for a client-supplied name.
 */
export const VALID_TOOL_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Client-declared (AG-UI) bridge names stay on the wire-safe charset: a
 * declaration outside it is DROPPED at mount — fail-soft, one structured
 * diagnostic, the chat continues (see VALID_TOOL_NAME above for the division
 * of labour and the engine rewrite that makes a dotted client name fatal).
 */
export const VALID_BRIDGE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The engine's model-visible spelling of a tool name: the pinned
 * `@mastra/core` 1.64.0 `formatTools` rewrites every `.` to `_` before the
 * wire (measured and pinned in mastra-computer-tools.test.ts, F16-2), so two
 * mounts whose names differ only in dots and underscores are ONE name to the
 * model. Collision identity is claimed in this spelling (F18-5/T35): an
 * exact-string check let a `foo.bar` + `foo_bar` grant pair mount and die
 * whole-run in the engine's AGENT_TOOL_NAME_COLLISION instead of being
 * refused at mount. Exported so the granted wrapper's claim registry and the
 * frontend bridge's grantedNames set both judge the same wire.
 */
export function wireName(name: string): string {
  return name.replace(/\./g, "_");
}

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
  // F18-5 (T35): claims are keyed by the WIRE name (wireName above — the
  // engine rewrites `.` to `_` before the wire), so a dotted/underscore twin
  // pair is refused HERE, at mount, instead of mounting both and dying
  // whole-run in the engine's AGENT_TOOL_NAME_COLLISION. The map remembers
  // the first claimant's original spelling so the refusal names both grants.
  const claimedWireNames = new Map<string, string>();
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
    const claimed = wireName(granted.name);
    // F19-1 (T36): the reserved pair must be refused in its WIRE spelling
    // too. The learned system tools mount dot-free (`copilotkit_load_skill`,
    // learning/runtime.ts) and the engine rewrites every `.` to `_` before
    // the wire, so a dotted grant (`copilotkit.load_skill`) passed the
    // exact-match check above, claimed this name, and collapsed the run at
    // the engine's AGENT_TOOL_NAME_COLLISION once the learned pair mounted
    // beside it. Refusing here makes that death path unreachable at mount.
    if (isReservedToolName(claimed)) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_RESERVED: ${granted.name} reaches the model as ${claimed}, a system tool name and cannot be overridden by a grant.`,
      );
    }
    const firstClaim = claimedWireNames.get(claimed);
    if (firstClaim !== undefined) {
      throw new MastraToolRefusal(
        `MASTRA_TOOL_NAME_COLLISION: two granted tools claim the model name ${claimed} (the engine's wire spelling of ${JSON.stringify(firstClaim)} and ${JSON.stringify(granted.name)}); refusing to override.`,
      );
    }
    claimedWireNames.set(claimed, granted.name);
    record[granted.name] = createTool({
      id: granted.name,
      description: granted.description,
      // The grant's own schema: the engine validates the model's arguments
      // against exactly what the grant declared, before anything executes.
      inputSchema: granted.parameters,
      execute: async (input: unknown, context: unknown) => {
        const operation = await controlledToolOperation(
          granted.name,
          input,
          context,
          guard,
          operations,
        );
        // The engine execute context, read the same way the frontend bridge
        // reads it: `context.agent.{resumeData, suspend, toolCallId}`. The
        // suspend surface is what makes an approval wait a DURABLE park.
        const ctx = context as
          | { agent?: { suspend?: unknown; resumeData?: unknown } }
          | undefined;
        const suspend = ctx?.agent?.suspend;
        // F4: under the run's approval binding, the granted execute runs
        // inside the approvals subsystem's context ALS — the ask's request
        // row opens with THIS run's identity, so the person's decision can
        // be applied to the exact parked call. `messages` stays empty: the
        // resumed loop rebuilds history from the conversation store, and a
        // stale client-side echo must never become model context.
        const approvalContext: ApprovalContinuation | undefined =
          guard.approvalBinding
            ? {
                runId: guard.approvalBinding.runId,
                threadId: guard.approvalBinding.threadId,
                toolCallId: operation.toolCallId,
                toolName: granted.name,
                args: input,
                messages: [],
                state: { engine: "mastra" },
                context: [],
                forwardedProps: undefined,
                ...(guard.approvalBinding.initiator
                  ? { initiator: guard.approvalBinding.initiator }
                  : {}),
              }
            : undefined;
        // The decision side of the durable park: the engine re-runs this
        // execute on EVERY resume, carrying the decision as `resumeData`
        // (approve → `{approved: true}`, decline → `declineToolCall`'s
        // `{approved: false, reason}`). A declined call never executes: the
        // person's answer IS the tool result, worded by the decliner.
        if (approvalContext && ctx?.agent?.resumeData !== undefined) {
          const decision = ctx.agent.resumeData as {
            approved?: unknown;
            reason?: unknown;
          };
          if (decision && decision.approved === false) {
            const reason =
              typeof decision.reason === "string" && decision.reason.trim()
                ? decision.reason.trim()
                : "The person declined this action.";
            return `${REFUSAL_MARKER} ${reason}`;
          }
        }
        // The ONE granted execute: grant → policy → credential → audit.
        // Vendor answers arrive already enveloped (vendorAnswer); refusals
        // arrive as "Refused." text; any other throw becomes the engine's
        // tool-error, which stream-events wraps with markUntrusted.
        try {
          const answer = approvalContext
            ? await withApprovalContext(approvalContext, () =>
                granted.execute(input),
              )
            : await granted.execute(input);
          return answer;
        } catch (error) {
          if (error instanceof HeadlessToolSuspension) {
            // F4: a pending approval wait parks the ENGINE durably — the
            // pinned engine's own `suspend()` surface, the same pattern the
            // frontend bridge uses. The suspension payload names the call;
            // the stream ends terminal-less, the normalizer derives the
            // suspension fact, and the wiring's save-before-waiting hook
            // commits the ME05 continuation BEFORE any waiting state can
            // publish. The decision later resumes THIS exact call through
            // the six-gate orchestrator (reactivateSuspensionLease under
            // it), and the execute re-runs into an approved gate.
            if (
              error.waiting.kind === "approval" &&
              typeof suspend === "function"
            ) {
              await (suspend as (payload: unknown) => Promise<void>)({
                kind: "approval",
                toolCallId: operation.toolCallId,
                toolName: granted.name,
                args: input,
                ...(typeof error.waiting.approvalId === "string"
                  ? { approvalId: error.waiting.approvalId }
                  : {}),
              });
              // In an agent run the suspend parks the step and this return
              // is never read; it exists so an engine that ignores the
              // pause still cannot read a fabricated tool result.
              return {
                waiting: true,
                kind: "approval",
                toolCallId: operation.toolCallId,
              };
            }
            // A wait raised outside an engine run (no surface to park on),
            // or a non-approval wait this engine cannot host: fail the call
            // closed instead of letting the suspension be read as a vendor
            // error or a rejection the human never sees.
            throw new MastraToolRefusal(
              "MASTRA_TOOL_SUSPENSION_UNSUPPORTED: this call's wait has no durable surface to park on here; the wait fails the call closed instead of being read as a vendor error.",
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
   * depth, not the primary rule. Callers may pass raw grant spellings
   * (execution.ts passes `Object.keys(tools)`): the set is normalized to
   * the wire spelling here, so a dotted twin cannot slip through.
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
  // F19-2 (T36): the granted set enters in its WIRE spelling, exactly as the
  // frontend bridge's collision set does (F18-4). A raw-spelling set let the
  // dotted grant `copilotkit.load_skill` pass this gate and mount beside the
  // dot-free reserved pair, which the engine then collapses into one name
  // (AGENT_TOOL_NAME_COLLISION, whole run). The learned names themselves
  // carry no dot — LEARNED_SKILL_TOOL_NAMES is underscored — so the
  // comparison below is wire against wire and lossless.
  const granted = new Set((guard.grantedNames ?? []).map(wireName));
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
