import {
  type ReactFrontendTool,
  useCopilotKit,
  useFrontendTool as useSDKFrontendTool,
} from "@copilotkit/react-core/v2";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, type ReactNode } from "react";
import { InlineApproval } from "@/components/approvals/inline-approval";
import { tryClient } from "@/lib/client";
import {
  type ScopedCache,
  useScopedCache,
} from "@/lib/enterprise/tenant/scoped-cache";
import { useActiveBotHolder } from "./active-bot";
import { frontendApprovalSnapshot } from "./approval-context";
import { answerMastraParticipation } from "./mastra-participation";

type RenderProps = { toolCallId: string; [key: string]: unknown };

/** The selection pair a scoped call rides, spread into the client options (MT086). */
type ScopePair = { tenantId?: string; workspaceId?: string };

/**
 * The live scope, readable from a handler the SDK registered once.
 *
 * `active-bot.tsx` owns the rule this follows: a tool handler outlives the render that registered
 * it, so anything it sends must be read from a holder updated on every render, never from a closed
 * over render value. The holder wraps `useScopedCache()` — the one reactive scope source (MT083),
 * so what a handler carries is the scope in force at the moment the call runs: the selection pair
 * for the request, the subtree prefix for the cache settle. A pending scope or the personal
 * context yields no pair: the request rides nothing, exactly as before this wiring.
 */
export function useCallTimeScope(): { current: ScopedCache } {
  const scope = useScopedCache();
  const holder = useRef<ScopedCache>(scope);
  holder.current = scope;
  return holder;
}

/** The pair an open scope's request rides; nothing for a pending one or the personal context. */
export function pairOf(scope: ScopedCache): ScopePair {
  return scope.status === "open" ? (scope.selection ?? {}) : {};
}

/**
 * Both homes the approvals inbox lives in, invalidated together (the settle shape approvals.ts
 * MT086 already writes): the unscoped entry a legacy surface may still read, and — when a scope
 * is open — this scope's own subtree, where the scoped read now lives.
 */
function invalidateInbox(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: ScopedCache,
) {
  void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  if (scope.status === "open") {
    void queryClient.invalidateQueries({
      queryKey: [...scope.prefix, "approvals"],
    });
  }
}

const writes = new Set([
  "computer_click",
  "computer_type",
  "computer_key",
  "computer_run_command",
  "computer_write_file",
]);

/**
 * Route computer changes through the server's durable approval gate, and draw a pending decision
 * inline where the action would have been.
 *
 * EVERY CHANGE GOES THROUGH THE GATE, not only when "Ask before making changes" is on. The server
 * decides, and it can ask for reasons the browser cannot see: a team rule, a safety requirement, the
 * auto-review model. It used to read the person's switch here, and the SDK registers a tool's
 * handler once and never again (its registration effect does not depend on the handler), so the
 * handler kept the switch as it was on first render, usually still loading. Every change then went
 * straight to the computer outside any run, and the gate could only answer "this action needs an
 * authenticated run". Nothing in this handler may depend on render-time state for that reason.
 */
export function useFrontendTool<T extends Record<string, unknown>>(
  tool: ReactFrontendTool<T>,
) {
  const { copilotkit } = useCopilotKit();
  // Stable for the provider's life, so the SDK's once-registered handler may keep it.
  const queryClient = useQueryClient();
  const bot = useActiveBotHolder();
  // Same discipline as the bot holder (active-bot.tsx): the handler outlives the render that
  // registered it, so the selection pair is read at the moment the call runs, never frozen.
  const scopeHolder = useCallTimeScope();
  const render = tool.render;
  useSDKFrontendTool({
    ...tool,
    ...(writes.has(tool.name)
      ? {
          // A component, so the approval card can use hooks; the SDK keeps this function forever.
          render: (props: RenderProps) => {
            const Original = render as
              | ((props: RenderProps) => ReactNode)
              | undefined;
            return (
              <InlineApproval
                toolCallId={props.toolCallId}
                fallback={Original ? <Original {...props} /> : null}
              />
            );
          },
        }
      : {}),
    handler: tool.handler
      ? async (args, context) => {
          const answer = async (result: unknown) => {
            /*
             * ME16 (#488): a Mastra engine suspension never sees a handler's
             * result in-band — the run is parked on the server as a durable
             * waiting continuation, and the browser is the only party that
             * can hand the real result over. Answer it when the server says
             * one is waiting for this call; the legacy engine's in-band flow
             * reads as "nothing waiting" and behaves exactly as before. A
             * parked APPROVAL decision (`waiting`) is not a tool result: the
             * approvals decision flow owns that resume.
             */
            if (
              !writes.has(tool.name) ||
              !(
                result &&
                typeof result === "object" &&
                "waiting" in result &&
                (result as { waiting?: unknown }).waiting === true
              )
            ) {
              await answerMastraParticipation({
                toolCallId: context.toolCall?.id,
                result,
                signal: context.signal,
                pair: pairOf(scopeHolder.current),
              });
            }
            return result;
          };
          if (!writes.has(tool.name)) {
            return answer(await tool.handler?.(args, context));
          }
          let snapshot: ReturnType<typeof frontendApprovalSnapshot>;
          try {
            snapshot = frontendApprovalSnapshot(context);
          } catch {
            // A surface with no observed conversation. The server still gates the action; it can
            // run it when nothing asks, and says why when something does.
            return answer(await tool.handler?.(args, context));
          }
          const response = await tryClient(
            `/api/approvals/computer/${encodeURIComponent(bot.current)}`,
            {
              method: "POST",
              body: snapshot,
              signal: context.signal,
              ...pairOf(scopeHolder.current),
            },
          );
          const payload: unknown = await response.json();
          if (response.status === 202) {
            if (!context.agent)
              throw new Error("The interrupted conversation is unavailable.");
            // Stop signals the SDK to discard this handler's unfinished result. The server owns
            // resume: the decision executes the action once and continues this conversation.
            copilotkit.stopAgent({ agent: context.agent });
            // Draw the card now rather than on the inbox's next poll, in both cache homes.
            invalidateInbox(queryClient, scopeHolder.current);
            // `answer` skips the waiting sentinel itself: a parked approval
            // decision resumes the engine, a tool result never does.
            return answer({ waiting: true });
          }
          if (!response.ok)
            throw new Error(
              payload &&
                typeof payload === "object" &&
                "error" in payload &&
                typeof payload.error === "string"
                ? payload.error
                : "The computer action could not be approved.",
            );
          if (!payload || typeof payload !== "object" || !("result" in payload))
            throw new Error("The computer action returned no result.");
          return answer(payload.result);
        }
      : undefined,
  });
}
