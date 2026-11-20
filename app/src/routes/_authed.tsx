import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { BotLookProvider } from "../components/agents/bot-look";
import { TeamFeaturesDialog } from "../components/edition/team-features-dialog";
import { currentUserQueryOptions, needsOnboarding } from "../lib/auth/queries";
import { appReturnPath } from "../lib/auth/resume";
import { CopilotProvider } from "../lib/copilot/provider";
import { AppHotkeys } from "../lib/hotkeys/app-hotkeys";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async ({ context, location }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    const returnTo = appReturnPath(location.href);
    if (!user) {
      throw redirect({
        to: "/sign",
        search: returnTo ? { returnTo } : {},
        replace: true,
      });
    }
    /*
     * Somebody who has not finished onboarding goes there and nowhere else. Here rather than in
     * `_app`, so admin and settings are behind the same gate; checked against the destination so
     * the onboarding route itself stays reachable.
     */
    if (needsOnboarding(user) && location.pathname !== "/onboarding") {
      throw redirect({
        to: "/onboarding",
        search: { returnTo },
        replace: true,
      });
    }
  },
  // Mounted INSIDE the authed boundary, not at the root: the runtime endpoint requires a session, so
  // a provider above the sign-in gate would open a run for a visitor who has not signed in yet.
  component: () => (
    <CopilotProvider>
      <AppHotkeys />
      {/* Opened by the personal edition's "OpenBot for Business" entry. */}
      <TeamFeaturesDialog />
      <BotLookProvider value="orb">
        <Outlet />
      </BotLookProvider>
    </CopilotProvider>
  ),
});
