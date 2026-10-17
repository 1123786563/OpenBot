import type { AgentActor } from "../agents/profile-types";
import type { ApprovalService } from "../approvals/service";
import type { RoutineStore } from "../routines/store";

/**
 * The Activity screen's one read: what is waiting on me (approvals), and what
 * runs on a schedule in my name (routines). The integration spec §10.1 maps the
 * Activity page onto "Routines、Responsibilities、Approvals、执行记录"; this
 * first cut carries the two halves the mobile UI can act on today, and the
 * responsibilities half joins when its mobile surface exists (spec T11).
 *
 * Counts only, plus the inbox items themselves: a phone's Activity list needs
 * "3 waiting, 5 routines", not every routine's run history — those stay behind
 * their own pages and their own pagination.
 */
export type MobileBffActivityReader = {
  read(actor: AgentActor): Promise<{
    approvals: {
      total: number;
      items: unknown[];
    };
    routines: {
      total: number;
      enabled: number;
    };
  }>;
};

export function createMobileBffActivity(deps: {
  approvals?: ApprovalService;
  routines?: RoutineStore;
}): MobileBffActivityReader {
  return {
    async read(actor) {
      const [inbox, routines] = await Promise.all([
        deps.approvals ? deps.approvals.inbox(actor.id) : Promise.resolve(null),
        deps.routines ? deps.routines.listFor(actor.id) : Promise.resolve([]),
      ]);
      // `inbox` is the approvals surface's whole answer (requests, rules,
      // questions); the Activity list wants only the waiting requests.
      const items = inbox?.requests ?? [];
      return {
        approvals: {
          total: items.length,
          items: items.slice(0, 20),
        },
        routines: {
          total: routines.length,
          enabled: routines.filter((routine) => routine.enabled).length,
        },
      };
    },
  };
}
