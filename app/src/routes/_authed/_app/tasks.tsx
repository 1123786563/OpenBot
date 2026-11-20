import { createFileRoute, redirect } from "@tanstack/react-router";
import { astryxPilot } from "@/components/astryx-pilot/theme";
import { AstryxTasksScreen } from "@/skins/openduet/tasks-screen";

export const Route = createFileRoute("/_authed/_app/tasks")({
  beforeLoad: () => {
    if (!astryxPilot) {
      throw redirect({
        params: { screen: "tasks" },
        replace: true,
        to: "/s/$screen",
      });
    }
  },
  component: AstryxTasksScreen,
});
