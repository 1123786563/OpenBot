import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { agentQueryOptions } from "@/lib/agents/queries";

/**
 * Route guard for creator-facing observability pages (`/bots/$agentId/runs|datasets|evaluations`).
 *
 * The Bot's profile carries the server-decided authorization verdict (`canManage`, true for the
 * creator and for administrators), so a direct URL is checked against that flag in `beforeLoad`
 * rather than by whatever the page happens to render. Sharing one helper keeps the three chains'
 * guard from drifting when the observability queries replace the profile as the source.
 */
export async function requireBotObservabilityAccess(
  queryClient: QueryClient,
  agentId: string,
) {
  const agent = await queryClient.ensureQueryData(agentQueryOptions(agentId));
  if (agent?.canManage !== true) {
    throw redirect({ to: "/bots" });
  }
  return agent;
}
