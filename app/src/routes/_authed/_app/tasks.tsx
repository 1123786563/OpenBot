import { createFileRoute } from "@tanstack/react-router";
import { TasksScreen } from "@/components/astryx-pilot/tasks-screen";

export const Route = createFileRoute("/_authed/_app/tasks")({
  component: TasksScreen,
});
