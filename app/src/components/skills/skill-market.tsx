import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import { pluginKeys } from "@/lib/plugins/queries";

type Skill = {
  namespace: string;
  slug: string;
  title: string;
  summary: string;
  publisher: string | null;
  latestVersion: string;
};

type VersionPreview = Skill & {
  source: string;
  version: string;
  instructions: string;
  runtimeRequirements: string | null;
  reasons: string[];
  installable: boolean;
  command?: string;
};

async function load<T>(path: string, signal: AbortSignal): Promise<T> {
  return (await client(`/api/skill-market${path}`, { signal })).json();
}

export function SkillMarket() {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Skill>();
  const [version, setVersion] = useState("");

  const search = useQuery({
    queryKey: ["skill-market", "search", query, page],
    queryFn: ({ signal }) =>
      load<{ items: Skill[]; hasMore: boolean }>(
        `?${new URLSearchParams({ q: query, page: String(page) })}`,
        signal,
      ),
    retry: false,
  });

  return (
    <PageSection
      title="Skill market"
      description="Browse skills curated by your deployment administrator."
    >
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const searchText = new FormData(event.currentTarget).get("q");
          setQuery(typeof searchText === "string" ? searchText.trim() : "");
          setPage(0);
          setSelected(undefined);
        }}
        aria-label="Skill market"
      >
        <label className="grid min-w-0 grow gap-1 text-sm" htmlFor={searchId}>
          Search shared skills
          <Input id={searchId} maxLength={200} name="q" type="search" />
        </label>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {search.isPending && <p role="status">Loading skills…</p>}
      {search.isError && (
        <p role="alert">
          Couldn't load the skill market.{" "}
          <Button variant="link" onClick={() => void search.refetch()}>
            Try again
          </Button>
        </p>
      )}
      {search.data?.items.length === 0 && (
        <p role="status">No skills on this page match your search.</p>
      )}
      <ul className="divide-y divide-border">
        {search.data?.items.map((skill) => (
          <li
            className="flex flex-wrap items-center justify-between gap-2 py-3"
            key={skill.slug}
          >
            <div className="min-w-0 break-words">
              <p className="font-medium">{skill.title}</p>
              {skill.summary && (
                <p className="text-sm text-muted-foreground">{skill.summary}</p>
              )}
            </div>
            <Button
              aria-controls={
                skill.slug === selected?.slug
                  ? "market-skill-preview"
                  : undefined
              }
              aria-expanded={skill.slug === selected?.slug}
              aria-label={`Preview ${skill.title}`}
              onClick={() => {
                if (skill.slug === selected?.slug) {
                  setSelected(undefined);
                } else {
                  setSelected(skill);
                  setVersion(skill.latestVersion);
                }
              }}
              size="sm"
              variant="outline"
            >
              Preview
            </Button>
          </li>
        ))}
      </ul>
      {(page > 0 || search.data?.hasMore) && (
        <div className="flex gap-2">
          <Button
            disabled={page === 0}
            onClick={() => {
              setPage(page - 1);
              setSelected(undefined);
            }}
            variant="outline"
          >
            Previous results
          </Button>
          <Button
            disabled={!search.data?.hasMore}
            onClick={() => {
              setPage(page + 1);
              setSelected(undefined);
            }}
            variant="outline"
          >
            Next results
          </Button>
        </div>
      )}
      {selected && (
        <MarketPreview
          key={selected.slug}
          skill={selected}
          version={version}
          selectVersion={setVersion}
        />
      )}
    </PageSection>
  );
}

function MarketPreview({
  skill,
  version,
  selectVersion,
}: {
  skill: Skill;
  version: string;
  selectVersion: (version: string) => void;
}) {
  const [page, setPage] = useState(0);
  const path = `/${encodeURIComponent(skill.namespace)}/${encodeURIComponent(skill.slug)}`;
  const detail = useQuery({
    queryKey: ["skill-market", path, page],
    queryFn: ({ signal }) =>
      load<{ versions: string[]; hasMore: boolean }>(
        `${path}?page=${page}`,
        signal,
      ),
    retry: false,
  });
  const versionPath = `${path}/versions/${encodeURIComponent(version)}`;
  const preview = useQuery({
    queryKey: ["skill-market", path, "version", version],
    queryFn: ({ signal }) => load<VersionPreview>(versionPath, signal),
    retry: false,
  });
  const versions = new Set([version, ...(detail.data?.versions ?? [])]);
  return (
    <section
      className="grid gap-3 rounded-lg border p-4"
      id="market-skill-preview"
      aria-labelledby="market-preview-heading"
    >
      <h3 className="font-semibold" id="market-preview-heading">
        {skill.title}
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          Published version
          <select
            className="rounded-md border bg-background px-2 py-1"
            onChange={(event) => selectVersion(event.target.value)}
            value={version}
          >
            {Array.from(versions, (option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {page > 0 && (
          <Button size="sm" variant="outline" onClick={() => setPage(page - 1)}>
            Newer versions
          </Button>
        )}
        {detail.data?.hasMore && (
          <Button size="sm" variant="outline" onClick={() => setPage(page + 1)}>
            Older versions
          </Button>
        )}
      </div>
      {detail.isError && <p role="alert">Couldn't load the version list.</p>}
      {preview.isPending && <p role="status">Loading version {version}…</p>}
      {preview.isError && (
        <p role="alert">Couldn't preview version {version}.</p>
      )}
      {preview.data && (
        <>
          <dl className="grid gap-2 break-words text-sm">
            <div>
              <dt className="font-medium">Source</dt>
              <dd>
                {preview.data.source} · {skill.namespace}/{skill.slug}
              </dd>
            </div>
            {preview.data.publisher && (
              <div>
                <dt className="font-medium">Publisher</dt>
                <dd>{preview.data.publisher}</dd>
              </div>
            )}
            <div>
              <dt className="font-medium">Version</dt>
              <dd>{preview.data.version}</dd>
            </div>
          </dl>
          <div className="text-sm">
            <h4 className="font-medium">OpenBot compatibility</h4>
            {preview.data.runtimeRequirements && (
              <p>{preview.data.runtimeRequirements}</p>
            )}
            {preview.data.installable ? (
              <p>Confirmed for OpenBot. Requires only SKILL.md.</p>
            ) : (
              <>
                <p>This version cannot be installed.</p>
                <ul className="list-disc pl-5">
                  {preview.data.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {preview.data.installable && preview.data.command && (
            <MarketInstall
              key={versionPath}
              command={preview.data.command}
              versionPath={versionPath}
            />
          )}
          <div>
            <h4 className="font-medium">Instructions</h4>
            <pre className="whitespace-pre-wrap break-words text-sm">
              {preview.data.instructions}
            </pre>
          </div>
        </>
      )}
    </section>
  );
}

type InstallTarget = { id: string; title: string };

function MarketInstall({
  command,
  versionPath,
}: {
  command: string;
  versionPath: string;
}) {
  const [agentId, setAgentId] = useState("");
  const queryClient = useQueryClient();
  const targets = useQuery({
    queryKey: ["skill-market", "install-targets"],
    queryFn: ({ signal }) =>
      load<{ bots: InstallTarget[] }>("/install-targets", signal),
    retry: false,
  });
  const install = useMutation({
    mutationFn: async (bot: InstallTarget) => {
      const response = await client(`/api/skill-market${versionPath}/install`, {
        method: "POST",
        body: { agentId: bot.id },
        fallback: "Couldn't install this skill.",
      });
      const result: { command: string; version: string } =
        await response.json();
      return { ...result, botTitle: bot.title };
    },
    onSuccess: (_result, bot) =>
      queryClient.invalidateQueries({ queryKey: pluginKeys.forAgent(bot.id) }),
  });

  if (targets.isPending) return <p role="status">Loading Bots…</p>;
  if (targets.isError) {
    return (
      <p role="alert">
        Couldn't load Bots for installation.{" "}
        <Button variant="link" onClick={() => void targets.refetch()}>
          Try again
        </Button>
      </p>
    );
  }
  if (targets.data.bots.length === 0) {
    return <p>You don't manage any Bots that can install this skill.</p>;
  }
  const selected = targets.data.bots.find((bot) => bot.id === agentId);
  return (
    <form
      className="grid gap-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && !install.isPending) install.mutate(selected);
      }}
    >
      <p>
        Slash command <code>/{command}</code>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1">
          Bot
          <select
            className="rounded-md border bg-background px-2 py-1"
            disabled={install.isPending}
            value={selected?.id ?? ""}
            onChange={(event) => {
              setAgentId(event.target.value);
              install.reset();
            }}
          >
            <option value="">Choose a Bot</option>
            {targets.data.bots.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.title}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="submit"
          size="sm"
          disabled={!selected || install.isPending || install.isSuccess}
        >
          {install.isPending ? "Installing…" : "Install on Bot"}
        </Button>
      </div>
      {install.error && <p role="alert">{install.error.message}</p>}
      {install.data && (
        <p role="status">
          Installed {install.data.version}. Use /{install.data.command} on{" "}
          {install.data.botTitle}.
        </p>
      )}
    </form>
  );
}
