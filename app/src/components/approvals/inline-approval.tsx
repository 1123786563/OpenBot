import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  type ApprovalDecision,
  approvalInboxOptions,
  decideApproval,
} from "@/lib/approvals";

/**
 * A pending approval, drawn in the conversation where the action it holds would have been.
 *
 * The same request as the Approvals page, read from the same owner-scoped inbox, so a decision made
 * in either place is the one decision. Once decided the server runs the action exactly once and
 * continues the conversation, and this gives the line back to the tool's own renderer.
 */
export function InlineApproval({
  toolCallId,
  fallback,
}: {
  toolCallId?: string;
  fallback: ReactNode;
}) {
  const { t } = useTranslation("approvals");
  const cache = useQueryClient();
  const inbox = useQuery(approvalInboxOptions());
  const decision = useMutation({
    mutationFn: (choice: ApprovalDecision) =>
      decideApproval(request?.id ?? "", choice),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["approvals"] }),
  });
  const request = toolCallId
    ? inbox.data?.requests.find(
        (candidate) => candidate.action.toolCallId === toolCallId,
      )
    : undefined;
  if (request?.status !== "pending") return <>{fallback}</>;
  const handOff = request.action.policy?.behaviour === "hand_off";
  const choices: [ApprovalDecision, string][] = handOff
    ? [
        ["handled", t("decision.handled")],
        ["deny", t("decision.dontDoIt")],
      ]
    : [
        ["allow_once", t("decision.allowOnce")],
        ["allow_always", t("decision.alwaysAllowHere")],
        ["deny", t("decision.deny")],
      ];
  return (
    <section
      aria-label={t("inline.waitingAria")}
      className="space-y-2 rounded-lg border p-3 text-sm"
    >
      <p className="font-medium">
        {handOff ? t("inline.needsYou") : t("inline.waiting")}:{" "}
        {request.action.toolRef
          .replace(/^computer_|^host\//, "")
          .replaceAll("_", " ")}{" "}
        {t("inline.onScope", { scope: request.action.scope })}
      </p>
      {request.action.policy ? (
        <p className="text-muted-foreground">{request.action.policy.reason}</p>
      ) : null}
      {decision.error ? (
        <p role="alert" className="text-destructive">
          {decision.error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {choices.map(([choice, label], index) => (
          <Button
            key={choice}
            size="sm"
            variant={index === 0 ? "default" : "outline"}
            disabled={decision.isPending}
            onClick={() => decision.mutate(choice)}
          >
            {label}
          </Button>
        ))}
      </div>
    </section>
  );
}

/**
 * The pending approvals for a group of tool calls, for a transcript that draws those calls itself
 * rather than through each tool's renderer: the browser-activity group folds every click and field
 * into one collapsed line, so a card inside a step would never be seen. Drawn beside the group,
 * outside the fold, one card per waiting call; nothing at all when none is waiting.
 */
export function PendingApprovals({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const inbox = useQuery(approvalInboxOptions());
  const waiting = new Set(
    (inbox.data?.requests ?? [])
      .filter((request) => request.status === "pending")
      .flatMap((request) =>
        request.action.toolCallId ? [request.action.toolCallId] : [],
      ),
  );
  const ids = toolCallIds.filter((id) => waiting.has(id));
  if (ids.length === 0) return null;
  return (
    <div className="mt-2 space-y-2">
      {ids.map((id) => (
        <InlineApproval key={id} toolCallId={id} fallback={null} />
      ))}
    </div>
  );
}
