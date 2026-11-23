import { eq } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  githubPilotEventTriggers as bindings,
  githubPilotEventOutcomes as outcomes,
} from "../../db/schema/corsair";
import type { createGithubEventTriggers } from "./event-triggers";

export const GITHUB_EVENT_PREFIX = "corsair-github:";
export const GITHUB_EVENT_ACCESS_ENDED =
  "GitHub event read authorization ended.";

export class GithubEventAccessRetry extends Error {
  constructor() {
    super("GitHub event read access is temporarily unavailable.");
  }
}

export async function githubQueuedRunAuthorization({
  database,
  service,
  runId,
  personId,
}: {
  database: Database;
  service?: ReturnType<typeof createGithubEventTriggers>;
  runId: string;
  personId: string;
}) {
  const [origin] = await database
    .select({ outcome: outcomes, trigger: bindings })
    .from(outcomes)
    .leftJoin(bindings, eq(bindings.id, outcomes.triggerId))
    .where(eq(outcomes.runId, runId));
  if (!origin?.trigger || !service) return { kind: "denied", origin } as const;
  const access = await service.access(origin.trigger, personId);
  if (access === "retry") throw new GithubEventAccessRetry();
  if (access === "denied") return { kind: "denied", origin } as const;
  return { kind: "allowed", origin, check: service.stillAuthorized } as const;
}
