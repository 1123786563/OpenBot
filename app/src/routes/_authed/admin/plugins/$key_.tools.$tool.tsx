import { createFileRoute } from "@tanstack/react-router";
import { PluginToolPage } from "@/components/manage/plugin-tool-page";

import { pluginSubpageSearch } from "@/lib/plugin-search";

/** `$key_` opts this route out of nesting under `$key.tsx`, so the connector page stays a page. */
export const Route = createFileRoute(
  "/_authed/admin/plugins/$key_/tools/$tool",
)({ component: RouteComponent, validateSearch: pluginSubpageSearch });

function RouteComponent() {
  const { key, tool } = Route.useParams();
  const { q, filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  const onFilterChange = (value: string) =>
    void navigate({
      search: { q, filter: value.slice(0, 200) || undefined },
      replace: true,
      resetScroll: false,
    });
  return (
    <PluginToolPage
      pluginKey={key}
      toolName={tool}
      listQuery={q}
      filter={filter}
      onFilterChange={onFilterChange}
    />
  );
}
