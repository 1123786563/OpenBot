import { createFileRoute } from "@tanstack/react-router";
import { PluginBotPage } from "@/components/manage/plugin-bot-page";

import { pluginSubpageSearch } from "@/lib/plugin-search";

/** `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page. */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/bots/$agentId",
)({ component: RouteComponent, validateSearch: pluginSubpageSearch });

function RouteComponent() {
  const { key, agentId } = Route.useParams();
  const { q, filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onFilterChange = (value: string) =>
    void navigate({
      search: { q, filter: value.slice(0, 200) || undefined },
      replace: true,
      resetScroll: false,
    });
  return (
    <PluginBotPage
      agentId={agentId}
      key={JSON.stringify([key, agentId])}
      pluginKey={key}
      listQuery={q}
      filter={filter}
      onFilterChange={onFilterChange}
    />
  );
}
