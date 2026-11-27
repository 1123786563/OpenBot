import { createFileRoute } from "@tanstack/react-router";
import { McpAllowlistSection } from "@/components/admin/controls/mcp-allowlist-section";
import { PluginsListPage } from "@/components/manage/plugins-list-page";

import { pluginSearch } from "@/lib/plugin-search";

export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: AdminPluginsPage,
  validateSearch: pluginSearch,
});

/** The apps and servers, then the allowlist of MCP servers Bots may call. */
function AdminPluginsPage() {
  const { q = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PluginsListPage
      search={q}
      onSearchChange={(value) =>
        void navigate({
          search: { q: value.slice(0, 200) || undefined },
          replace: true,
          resetScroll: false,
          state: { returnPlugin: undefined },
        })
      }
    >
      <McpAllowlistSection />
    </PluginsListPage>
  );
}
