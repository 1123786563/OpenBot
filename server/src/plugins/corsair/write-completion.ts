import type { ApprovalStore } from "../../approvals/types";

export async function finishExplicitWrite(
  approvals: Pick<ApprovalStore, "saveResult" | "finish">,
  actorId: string,
  approvalId: string,
  result: Parameters<ApprovalStore["saveResult"]>[2],
) {
  await approvals.saveResult(actorId, approvalId, result);
  await approvals.finish(actorId, approvalId);
}
