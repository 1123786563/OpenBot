import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { astryxPilot } from "@/components/astryx-pilot/theme";
import { useActiveSkin } from "@/skins/registry";

/*
 * Screens that only a skin has (OpenDuet's Tasks, OpenMuse's Ideas) live here, so a skin adds
 * screens without adding routes. Switching to a skin without this screen, or following an old link
 * to it, goes home rather than to an empty page.
 */
export const Route = createFileRoute("/_authed/_app/s/$screen")({
  beforeLoad: ({ params }) => {
    if (!astryxPilot) return;
    if (params.screen === "routines")
      throw redirect({ to: "/routines", replace: true });
    if (params.screen === "tasks")
      throw redirect({ to: "/tasks", replace: true });
    if (params.screen === "goals") {
      throw redirect({
        to: "/responsibilities",
        search: { view: "goals" },
        replace: true,
      });
    }
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { screen } = Route.useParams();
  const Screen = useActiveSkin().screens?.[screen];

  if (!Screen) return <Navigate replace to="/" />;

  return <Screen />;
}
