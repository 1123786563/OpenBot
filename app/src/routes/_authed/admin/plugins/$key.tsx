import { createFileRoute } from "@tanstack/react-router";
import { PluginPage } from "@/components/manage/plugin-page";

import { pluginSearch } from "@/lib/plugin-search";

export const Route = createFileRoute("/_authed/admin/plugins/$key")({
  component: RouteComponent,
  validateSearch: pluginSearch,
});

function RouteComponent() {
  const { key } = Route.useParams();
  const { q } = Route.useSearch();
  return <PluginPage key={key} pluginKey={key} listQuery={q} />;
}
