import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import type { HeadlessTool } from "@openbot/toolkit/headless-tools";
import { z } from "zod";
import { PACKAGE_TOOL_REF_PREFIX } from "../../../shared/enterprise/plugin-package-contracts";
import type { RunAssertion } from "../agents/callback-token";
import type { AuditInitiator } from "../audit";
import { PluginRefusedError } from "../plugins/store";
import { isApprovalRecheck } from "./service";
import {
  type ApprovalAction,
  type ApprovalCandidate,
  type ApprovalContinuation,
  ApprovalRefusedError,
  parseApprovalContinuation,
} from "./types";

/** What carrying out an approved action needs from the deployment. Injected so it can be tested. */
export type ApprovedActionDependencies = {
  /** The conversation the action came from, if this Bot and person can still reach it. */
  sourceFor(run: {
    actorId: string;
    botId: string;
    threadId: string;
    runId: string;
    depth: number;
    initiator: AuditInitiator;
  }): Promise<unknown>;
  gate(candidate: ApprovalCandidate): Promise<unknown>;
  computerTools(
    actorId: string,
    botId: string,
    initiator: AuditInitiator,
  ): Promise<HeadlessTool[]>;
  hostTools(input: {
    actorId: string;
    botId: string;
    initiator: AuditInitiator;
  }): GrantedTool[];
  callTool(input: {
    ref: string;
    args: Record<string, unknown>;
    botId: string;
    actorId: string;
    initiator: AuditInitiator;
    credentialActorId?: string;
    /**
     * PKG09 (Spec §9): the server-issued package run context, rebuilt from the
     * persistent run row by `packageRunFor` — never from the deserialized
     * proposal. Present only for a `pkg:` ref, whose call is refused without it.
     */
    packageRun?: {
      runId: string;
      attemptGeneration: number;
      scope: unknown;
      toolCallId?: string;
    };
  }): Promise<{ text: string; isError: boolean }>;
  /**
   * Whose connected account a call goes out on: the live call path's rule (a Team Bot reaches its
   * owner's account, a teammate's own only with consent), applied again here so an approved call
   * does not go out on the approver's own account instead.
   */
  credentialActorFor(
    actorId: string,
    botId: string,
    ref: string,
  ): Promise<string>;
  /**
   * PKG09 (Spec §9): the background-scope rebuild for an approved `pkg:` tool —
   * the trusted scope and run identity re-derived from the persistent run row
   * (current membership re-verified server-side). Structural type only: the
   * production wiring injects the enterprise entrypoints service, so this module
   * imports no enterprise code.
   */
  packageRunFor?(action: ApprovalAction): Promise<
    | {
        outcome: "context";
        runId: string;
        attemptGeneration: number;
        scope: unknown;
      }
    | { outcome: "refused"; code: string }
  >;
  /** A hand-off or question tool (`bot/...`), run as the coordination tools run it live. */
  coordinationCall(input: {
    name: string;
    args: Record<string, unknown>;
    run: RunAssertion;
  }): Promise<{ text: string; isError: boolean } | null>;
  /** The signed run carried in the continuation, so a resumed hand-off keeps its original depth. */
  readRun?(forwardedProps: unknown): RunAssertion | null;
  answer(result: { text: string; isError: boolean }): string;
  privateShareToolRef: string;
  refusalMarker: string;
  personInitiator: AuditInitiator;
};

/**
 * The run attempt a package proposal was PREPARED against, read from the
 * proposal's own dispatch `target` (the package branch records it beside the
 * connection generation the approval is already bound to).
 *
 * A proposal written before that binding existed carries no attempt; the
 * caller then restores without one and the dispatch CAS still re-verifies the
 * run/lease/pin facts. Anything malformed is treated the same way — this is a
 * binding aid, never a source of authority.
 */
export function proposalAttemptOf(action: ApprovalAction): number | undefined {
  const target = action.target;
  if (!target || typeof target !== "object" || Array.isArray(target))
    return undefined;
  const value = (target as { attemptGeneration?: unknown }).attemptGeneration;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Carry out one approved action as its own tool would have, so the action's own gate sees the
 * approval and lets it through. Also run under `validateReentry`, where that gate reports the action
 * it would have asked about instead of acting.
 */
export function createApprovedActionExecutor(deps: ApprovedActionDependencies) {
  return async (action: ApprovalAction): Promise<unknown> => {
    const snapshot: ApprovalContinuation = parseApprovalContinuation(
      action.continuation,
    );
    const initiator = snapshot.initiator ?? deps.personInitiator;
    const source = await deps.sourceFor({
      actorId: action.actorId,
      botId: action.botId,
      threadId: action.threadId,
      runId: action.runId,
      depth: 0,
      initiator,
    });
    if (!source)
      throw new ApprovalRefusedError(
        "That conversation is no longer available to this Bot and person.",
      );
    // A private-information share the person allowed: the approval is the whole action, and the Bot
    // is told to send again, which the share check then passes. Gated so re-entry validation sees it.
    if (action.toolRef === deps.privateShareToolRef) {
      await deps.gate({
        actorId: action.actorId,
        botId: action.botId,
        toolRef: action.toolRef,
        effect: action.effect,
        scope: action.scope,
        args: action.args,
        target: action.target,
        continuation: snapshot,
      });
      return "The person allowed this share. Send it again now, unchanged.";
    }
    const computer = await deps.computerTools(
      action.actorId,
      action.botId,
      initiator,
    );
    if (snapshot.toolName.startsWith("computer_")) {
      const tool = computer.find(
        (tool) => tool.definition.name === snapshot.toolName,
      );
      if (!tool)
        throw new ApprovalRefusedError(
          "That computer tool is no longer available.",
        );
      return tool.execute(snapshot.args, {
        toolCallId: snapshot.toolCallId,
        signal: new AbortController().signal,
      });
    }
    if (snapshot.toolName.startsWith("host_")) {
      const tool = deps
        .hostTools({ actorId: action.actorId, botId: action.botId, initiator })
        .find((tool) => tool.name === snapshot.toolName);
      if (!tool)
        throw new ApprovalRefusedError(
          "That host tool is no longer available.",
        );
      const result = await tool.execute(snapshot.args);
      if (result.startsWith(deps.refusalMarker))
        throw new ApprovalRefusedError(result);
      return result;
    }
    const args = z.record(z.string(), z.unknown()).parse(snapshot.args);
    // A hand-off is not a connector call: sent to the connector path, it was refused as not
    // granted, so "Allow once" on a hand-off could never be carried out.
    if (action.toolRef.startsWith("bot/")) {
      const forwarded = snapshot.forwardedProps;
      const signed =
        forwarded && typeof forwarded === "object" && "openbotRun" in forwarded
          ? (deps.readRun?.(forwarded.openbotRun) ?? null)
          : null;
      const run: RunAssertion =
        signed &&
        signed.actorId === action.actorId &&
        signed.botId === action.botId
          ? signed
          : {
              actorId: action.actorId,
              botId: action.botId,
              runId: action.runId,
              threadId: action.threadId,
              depth: 0,
              initiator,
            };
      const answered = await deps.coordinationCall({
        name: snapshot.toolName,
        args,
        run,
      });
      if (!answered)
        throw new ApprovalRefusedError(
          "That coordination tool is no longer available.",
        );
      if (answered.isError) throw new ApprovalRefusedError(answered.text);
      return answered.text;
    }
    // A refused call (the grant was removed, a teammate's consent is missing) is an answer for the
    // Bot. Left as the connector's own error, the approval sweep retried it until it gave up.
    let result: { text: string; isError: boolean };
    try {
      /*
       * PKG09 (Spec §9): a `pkg:` ref is a PACKAGE tool, and a package tool runs
       * only inside the managed run it was proposed in. The resume re-enters
       * `callTool` with the run context rebuilt from the persistent run row —
       * the deserialized proposal contributes NOTHING to scope, attempt or
       * identity, and the dispatch chain revalidates args digest, connection
       * generation, grant and lease at its CAS (A07). A proposal whose run is
       * unreachable is refused here rather than fabricated a run for; the
       * credential-actor rule is skipped too, because the package chain resolves
       * the caller's own connection itself.
       */
      if (action.toolRef.startsWith(PACKAGE_TOOL_REF_PREFIX)) {
        const restored = deps.packageRunFor
          ? await deps.packageRunFor(action)
          : ({ outcome: "refused", code: "PACKAGE_RUN_REQUIRED" } as const);
        if (restored.outcome !== "context") {
          throw new ApprovalRefusedError(packageResumeSentence(restored.code));
        }
        result = await deps.callTool({
          ref: action.toolRef,
          args,
          botId: action.botId,
          actorId: action.actorId,
          initiator,
          packageRun: {
            runId: restored.runId,
            attemptGeneration: restored.attemptGeneration,
            scope: restored.scope,
            toolCallId: action.toolCallId,
          },
        });
      } else {
        // The re-check stops at the gate before the call is made, so it must not resolve the account:
        // that spends a teammate's one-time consent, and the real run would then be refused.
        const credentialActorId = isApprovalRecheck()
          ? action.actorId
          : await deps.credentialActorFor(
              action.actorId,
              action.botId,
              action.toolRef,
            );
        result = await deps.callTool({
          ref: action.toolRef,
          args,
          botId: action.botId,
          actorId: action.actorId,
          initiator,
          ...(credentialActorId === action.actorId
            ? {}
            : { credentialActorId }),
        });
      }
    } catch (error) {
      if (error instanceof PluginRefusedError)
        throw new ApprovalRefusedError(error.message);
      throw error;
    }
    if (result.isError) throw new Error(result.text);
    return deps.answer(result);
  };
}

/**
 * The fixed refusal sentences for a package resume that could not rebuild its
 * run context — a closed vocabulary, nothing interpolated, because these are
 * the sentences a person reads next to their own approval.
 */
function packageResumeSentence(code: string): string {
  switch (code) {
    case "PACKAGE_RUN_BOT_MISMATCH":
      return "This approval names a Bot the run was not admitted for, so it cannot run.";
    case "PACKAGE_RUN_SCOPE_LOST":
      return "The team or membership this run belongs to changed while it waited, so the approval no longer applies.";
    case "PACKAGE_RUN_ATTEMPT_STALE":
      return "The run was cancelled or retried while this approval waited, so the approval no longer applies.";
    default:
      return "This package tool runs only inside a managed run, and none is reachable for this approval.";
  }
}
