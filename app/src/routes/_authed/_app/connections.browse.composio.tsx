import { createFileRoute } from "@tanstack/react-router";
import { pluginSubpageSearch } from "@/lib/plugin-search";
import { BrokerDirectory } from "@/components/plugins/broker-directory";
import { personalOnly } from "@/lib/edition-guard";

export const Route = createFileRoute(
  "/_authed/_app/connections/browse/composio",
)({
  beforeLoad: personalOnly("/connections"),
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
