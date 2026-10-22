import type { BaseEvent, RunAgentInput } from "@ag-ui/client";
import type { Observable } from "rxjs";
import type { PlatformScope } from "../enterprise/contracts";
import type { GovernedModelRequest } from "../enterprise/runs/governed-execution";
import type { GrantedTool } from "../plugins/tools";
import type { MastraToolOperation } from "./tools";

/*
 * ME02 (#474) T2 frozen execution contracts. These names are the seam every
 * later ticket of the Mastra execution migration extends — never renames.
 * OpenBot stays the authority for identity, scope, run/attempt, budget and
 * events; this contract only describes what one admitted execution consumes.
 */

/**
 * The server-issued identity one execution runs under.
 *
 * Every field is minted server-side — the wire input cannot choose any of
 * them. `runId`/`attemptId`/`generation` are the OpenBot run identities the
 * admission bound; `executionKey` is the server-generated engine execution
 * identifier the Mastra stream runs under, mapping the engine run back to
 * the business run without ever letting the client name it.
 */
export interface ExecutionBinding {
  readonly scope: PlatformScope;
  readonly botId: string;
  /** OpenBot identity: the admitted run. */
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
  /** Server-generated; maps to the Mastra run id. */
  readonly executionKey: string;
  /**
   * ME03: the admitted run's thread, minted server-side with the rest of the
   * binding. Optional only because ME02 constructions predate it; output
   * persistence (`persistExecutionMessages`) refuses a binding without one
   * rather than guessing the conversation from any client field.
   */
  readonly threadId?: string;
  /**
   * ME05 fix-round-1: true when this binding was re-derived from durable
   * storage (the continuation row) rather than minted by the current
   * admission. A re-derived binding's scope IDENTITY fields
   * (tenant/workspace/principal/actor) are authoritative — the store compares
   * them field-wise — but its `memberEpoch`/`aclEpoch`/`entrypoint` values are
   * PLACEHOLDERS (zeros / "web") until the current admission re-establishes
   * them; they are never the stored history and never authority. Set by the
   * continuation store's `recordOf`; admission-minted bindings never set it.
   */
  readonly reDerivedScope?: boolean;
}

/** The server-side reference to one persisted continuation (typed for ME05+). */
export interface ResumeRef {
  readonly continuationId: string;
  readonly revision: number;
}

/*
 * ME05 (#477) T6 continuation contracts — frozen names from plan §3, extended
 * (never renamed) onto the same file that carries ResumeRef. Every identity is
 * re-verified inside the store at claim time: these types are descriptions,
 * never authorization.
 */

/** The versioned envelope one durable suspension persists. */
export interface ContinuationPayload {
  readonly schemaVersion: 1;
  readonly engine: "mastra";
  /** From the ME01-probe fingerprint: an incompatible snapshot isolates. */
  readonly packageFingerprint: string;
  readonly kind: "approval" | "question" | "frontend_tool";
  readonly toolCallId: string;
  readonly toolName: string;
  /** Canonical JSON digest of the exact arguments (mastra/tools.ts). */
  readonly argsDigest: string;
  /** Opaque ref into restricted storage; never keys/capabilities/signals. */
  readonly snapshotRef: string;
}

/** The authenticated decision one continuation is resumed with. */
export type ResumeDecision =
  | { kind: "approved"; approvalId: string; argsDigest: string }
  | { kind: "declined"; approvalId: string; reason: string }
  | { kind: "answered"; responseId: string }
  | {
      kind: "tool_result";
      /** The idempotency id of THIS reply (replays converge on it). */
      receiptId: string;
      /**
       * ME06: the client's real tool result, exactly as the authenticated
       * participation entry received it — the value the resumed engine loop
       * reads as the call's outcome. Evidence identity stays the receiptId;
       * this is only the drive's input.
       */
      result?: unknown;
    };

/** What one CAS winner holds; `claimToken` is server-only and never logged. */
export interface ClaimedContinuation {
  readonly ref: ResumeRef;
  readonly binding: ExecutionBinding;
  readonly payload: ContinuationPayload;
  readonly claimToken: string;
}

export type ContinuationOutcome = "resumed" | "declined" | "failed_unknown";

/**
 * The durable-suspension facts one execution reports to the continuation
 * wiring. Computed entirely from server-side state (the engine's own call
 * frames and the ME04 operation identity) — never from any client field.
 */
export interface MastraSuspensionFact {
  readonly kind: "approval" | "question" | "frontend_tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly argsDigest: string;
  readonly operationId: string;
  readonly snapshotRef: string;
}

/**
 * ME05 wiring an execution may carry (server-assembled only, like the
 * governed model): the tenant-restricted engine storage the durable
 * suspension snapshot persists into, the granted tool names mounted with the
 * engine-level approval pause, and the save hook that must resolve BEFORE the
 * stream ends terminal-less.
 */
export interface ExecutionContinuationContext {
  readonly storage?: unknown;
  readonly durableToolNames?: readonly string[];
  readonly onSuspension: (suspension: MastraSuspensionFact) => Promise<void>;
}

/**
 * ME08: a client-declared (browser-registered) tool definition — the AG-UI
 * tool the page registered with `useFrontendTool` and the run relayed. The
 * server mounts it as an INERT bridge (mastra/frontend-tools.ts): the model's
 * call suspends the engine for real client participation, and the server
 * never executes the tool or fabricates its result.
 */
export interface FrontendToolDefinition {
  readonly name: string;
  readonly description: string;
  /** The client's own JSON Schema for the arguments, verbatim. */
  readonly parameters?: unknown;
}

/**
 * ME08: the per-run validated learned-skill invocation, acquired ONCE per
 * outer run by the same `RunBuiltAgent` middleware the legacy engine uses —
 * so this engine consumes the identical verified snapshot the legacy path
 * does. The two tool definitions are the pinned SDK's own reserved names
 * (`LEARNED_SKILL_TOOL_NAMES`), and every execute routes through the
 * invocation's own execute: archive verification, the bound revision, the
 * file-read scope and the revocation policy all stay in the SDK
 * (`learning/runtime.ts` pins that export) — never re-implemented on this
 * engine. `server/src/learning/runtime.ts`'s `LearnedSkillInvocation`
 * satisfies this shape structurally.
 */
export interface LearnedSkillInvocationSurface {
  /** The formatted catalog the trusted prompt composes (may be empty). */
  readonly catalog: string;
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    /** JSON Schema for the arguments, from the pinned SDK. */
    readonly parameters?: unknown;
  }[];
  /** The ONE learned execute: `copilotkit_load_skill` / `copilotkit_read_skill_file`. */
  execute(name: string, args: unknown): Promise<string>;
}

/**
 * What one execution consumes. Built entirely from server-issued facts: the
 * binding above, the agent input the runner relayed (history rebuilt
 * server-side; ME03 deepens this), the trusted instruction parts, the
 * granted tools, the governed model collaborator and the run's signal.
 */
export interface ExecutionRequest {
  readonly binding: ExecutionBinding;
  readonly input: RunAgentInput;
  /** Trusted instruction parts; composed by {@link buildInstructions}. */
  readonly instructions: readonly string[];
  /**
   * Trusted instruction parts the legacy prompt places AFTER the two
   * unconditional guidance blocks (the granted-tool paragraph); the composed
   * order is the legacy prompt's exact sequence. Absent/empty means none.
   */
  readonly trailingInstructions?: readonly string[];
  /** ME02: usually empty (text-only slice). */
  readonly tools: readonly GrantedTool[];
  /**
   * ME06: the client-declared participation tools this run relays, mounted
   * as inert bridges. Composed server-side from the relayed run input minus
   * the granted names; absent means none (a text/granted-only run).
   */
  readonly frontendTools?: readonly FrontendToolDefinition[];
  /**
   * ME08: the outer run's validated learned-skill invocation. Composed
   * server-side (the same acquired object the legacy engine receives);
   * absent means learning is off for this Bot or excluded — never that the
   * learning service failed (a failed acquire refuses the run upstream).
   */
  readonly learnedSkills?: LearnedSkillInvocationSurface;
  /**
   * OCR fix wave 3 (R3-3): observes each wrapped operation once, before the
   * granted execute runs — the seam through which the REAL engine's execute
   * context (the `toolCallId` carrier the operation identity keys on) is
   * observable, so the identity contract can be pinned against the locked
   * engine rather than a synthetic context. Server-assembled only, like the
   * governed model; absent means nobody observes.
   */
  readonly onToolOperation?: (operation: MastraToolOperation) => void;
  readonly governedModel: GovernedModelRequest;
  /** Unused in ME02; typed for the continuation tickets. */
  readonly resume?: ResumeRef;
  /**
   * ME05: durable-continuation support, present only when the server
   * assembly wired it. Absent keeps the pre-ME05 behavior exactly.
   */
  readonly continuations?: ExecutionContinuationContext;
  readonly signal: AbortSignal;
}

/**
 * One execution: consumes an admitted request, returns the canonical AG-UI
 * event stream. One execution instance per call/subscription.
 */
export type ExecuteMastra = (
  request: ExecutionRequest,
) => Observable<BaseEvent>;
