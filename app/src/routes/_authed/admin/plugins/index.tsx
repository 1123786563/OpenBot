import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { McpAllowlistSection } from "@/components/admin/controls/mcp-allowlist-section";
import { PluginsListPage } from "@/components/manage/plugins-list-page";

export const Route = createFileRoute("/_authed/admin/plugins/")({
  component: AdminPluginsPage,
  validateSearch: z.object({
    q: z.string().max(200).optional().catch(undefined),
  }),
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
          search: { q: value || undefined },
          replace: true,
          resetScroll: false,
        })
      }
    >
      <McpAllowlistSection />
    </PluginsListPage>
  );
}
