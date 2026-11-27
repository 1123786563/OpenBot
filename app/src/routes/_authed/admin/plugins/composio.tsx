import { createFileRoute } from "@tanstack/react-router";
import { pluginSubpageSearch } from "@/lib/plugin-search";
import { BrokerDirectory } from "@/components/plugins/broker-directory";

/** Composio's directory, behind the guard that it answers only on a Composio deployment. */
export const Route = createFileRoute("/_authed/admin/plugins/composio")({
  component: DirectoryPage,
  validateSearch: pluginSubpageSearch,
});

function DirectoryPage() {
  const { q, filter } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BrokerDirectory
      provider="composio"
      listQuery={q}
      search={filter ?? ""}
      onSearchChange={(value) =>
        void navigate({
          search: { q, filter: value.slice(0, 200) || undefined },
          replace: true,
          resetScroll: false,
        })
      }
    />
  );
}
