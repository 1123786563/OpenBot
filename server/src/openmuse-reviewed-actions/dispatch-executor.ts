import { createHash } from "node:crypto";
import { getLogger } from "../../../shared/logger";
import { GCAL_CREATE_DIAL_ACTION_ID } from "./calendar-create-executor";
import { GCAL_DELETE_DIAL_ACTION_ID } from "./calendar-delete-executor";
import {
  GCAL_GET_DIAL_ACTION_ID,
  GCAL_UPDATE_DIAL_ACTION_ID,
} from "./calendar-update-executor";
import { GMAIL_SEND_DIAL_ACTION_ID } from "./gmail-send-executor";
import { canonicalJson, type ReviewedActionProposal } from "./proposal";
import type { ClaimGuardedExecutor } from "./service";

const log = getLogger("server");

/*
 * Boot-time O02 reminder (round 6 M40, the mail/calendar clients' own
 * baseline): every action id the reviewed-action executors dial is a
 * placeholder this repository pins by name alone, overridable by env and
 * verified against the vendor's catalogue at deployment. The signal fires
 * once at module load so a skipped O02 check leaves a trace rather than a
 * silent 4xx on every approval.
 */
log.info(
  {
    type: "openmuse-reviewed-action-placeholder-ids",
    ids: {
      "gmail.send": GMAIL_SEND_DIAL_ACTION_ID,
      "gcalendar.create": GCAL_CREATE_DIAL_ACTION_ID,
      "gcalendar.update": GCAL_UPDATE_DIAL_ACTION_ID,
      "gcalendar.delete": GCAL_DELETE_DIAL_ACTION_ID,
      "gcalendar.get": GCAL_GET_DIAL_ACTION_ID,
    },
  },
  "openmuse-reviewed-action-placeholder-ids",
);

/**
 * The assembly's kind dispatcher (§6): the service's executor seam is ONE
 * executor, while the delivery ships one per provider surface — gmail.send,
 * gcalendar.create/update/delete. This seam routes each proposal by its kind
 * to the executor that owns it, and answers a kind nobody owns the way a
 * single-kind executor always answered a foreign kind: a definite `failed`
 * ("not executable here"), zero provider dials — never a wrong-surface dial
 * and never a silent pass. The legacy `mail`/`calendar` kinds land there too
 * until an executor is written for them.
 */
export function createKindDispatchingExecutor(
  executors: Partial<
    Record<ReviewedActionProposal["kind"], ClaimGuardedExecutor>
  >,
): ClaimGuardedExecutor {
  return {
    async execute(proposal) {
      const executor = executors[proposal.kind];
      if (executor === undefined) {
        return {
          outcome: "failed",
          error: `This deployment's reviewed action executor has no executor for ${proposal.kind}; it is not executable here.`,
          fingerprint: createHash("sha256")
            .update(
              `undispatched:${proposal.accountEmail}:${canonicalJson(proposal.payload)}`,
              "utf8",
            )
            .digest("hex"),
        };
      }
      return executor.execute(proposal);
    },
    async preflight(proposal) {
      // A kind nobody owns needs no guard: execute refuses it definitively.
      await executors[proposal.kind]?.preflight?.(proposal);
    },
  };
}
