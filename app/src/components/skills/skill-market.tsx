import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Input } from "@/components/ui/input";
import { client } from "@/lib/client";
import { pluginKeys } from "@/lib/plugins/queries";
import {
  MarketVersionAdministration,
  MarketVersionControl,
  type MarketVersionIdentity,
  marketSkillPath,
  marketVersionQueryKey,
} from "./market-version-administration";

type Skill = {
  namespace: string;
  slug: string;
  title: string;
  summary: string;
  latestVersion: string;
};

type VersionPreview = Skill &
  MarketVersionIdentity & {
    publisher: string | null;
    disableReason?: string;
    instructions: string;
    runtimeRequirements: string | null;
    reasons: string[];
    installable: boolean;
    command?: string;
    canAssignCommand?: boolean;
  };

async function load<T>(path: string, signal: AbortSignal): Promise<T> {
  return (await client(`/api/skill-market${path}`, { signal })).json();
}

export function SkillMarket({ isAdmin = false }: { isAdmin?: boolean }) {
  const previewId = useId();
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
      <VStack gap={3} paddingBlockStart={3}>
        <InstalledMarketSkills isAdmin={isAdmin} />
        {isAdmin && <MarketVersionAdministration />}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const searchText = new FormData(event.currentTarget).get("q");
            setQuery(typeof searchText === "string" ? searchText.trim() : "");
            setPage(0);
            setSelected(undefined);
          }}
          aria-label="Skill market"
        >
          <HStack align="end" gap={2} wrap="wrap">
            <StackItem size="fill">
              <VStack as="label" gap={1}>
                <Text type="label">Search shared skills</Text>
                <Input maxLength={200} name="q" type="search" />
              </VStack>
            </StackItem>
            <Button type="submit" label="Search" />
          </HStack>
        </form>
        {search.isPending && <p role="status">Loading skills…</p>}
        {search.isError && (
          <p role="alert">
            Couldn't load the skill market.{" "}
            <Button
              variant="ghost"
              size="sm"
              label="Try again"
              onClick={() => void search.refetch()}
            />
          </p>
        )}
        {search.data?.items.length === 0 && (
          <p role="status">No skills on this page match your search.</p>
        )}
        {search.data && search.data.items.length > 0 && (
          <List edge="flush" hasDividers>
            {search.data.items.map((skill) => (
              <ListItem
                key={skill.slug}
                label={
                  <Text type="label" wordBreak="break-word">
                    {skill.title}
                  </Text>
                }
                description={
                  skill.summary && (
                    <Text type="supporting" wordBreak="break-word">
                      {skill.summary}
                    </Text>
                  )
                }
                endContent={
                  <Button
                    aria-controls={
                      skill.slug === selected?.slug ? previewId : undefined
                    }
                    aria-expanded={skill.slug === selected?.slug}
                    aria-label={`Preview ${skill.title}`}
                    label="Preview"
                    onClick={() => {
                      if (skill.slug === selected?.slug) {
                        setSelected(undefined);
                      } else {
                        setSelected(skill);
                        setVersion(skill.latestVersion);
                      }
                    }}
                    size="sm"
                  />
                }
              />
            ))}
          </List>
        )}
        {(page > 0 || search.data?.hasMore) && (
          <HStack gap={2} wrap="wrap">
            <Button
              isDisabled={page === 0}
              onClick={() => {
                setPage(page - 1);
                setSelected(undefined);
              }}
              label="Previous results"
            />
            <Button
              isDisabled={!search.data?.hasMore}
              onClick={() => {
                setPage(page + 1);
                setSelected(undefined);
              }}
              label="Next results"
            />
          </HStack>
        )}
        {selected && (
          <MarketPreview
            key={selected.slug}
            id={previewId}
            skill={selected}
            version={version}
            selectVersion={setVersion}
            isAdmin={isAdmin}
          />
        )}
      </VStack>
    </PageSection>
  );
}

function MarketPreview({
  id,
  installed,
  skill,
  version,
  selectVersion,
  isAdmin,
}: {
  id: string;
  installed?: { agentId: string; skill: InstalledSkill };
  skill: Pick<Skill, "namespace" | "slug" | "title">;
  version: string;
  selectVersion: (version: string) => void;
  isAdmin: boolean;
}) {
  const [page, setPage] = useState(0);
  const path = marketSkillPath(skill);
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
    queryKey: marketVersionQueryKey(path, version),
    queryFn: ({ signal }) => load<VersionPreview>(versionPath, signal),
    retry: false,
  });
  const versions = new Set([version, ...(detail.data?.versions ?? [])]);
  return (
    <section id={id} aria-labelledby={`${id}-heading`}>
      <Section variant="muted" padding={3}>
        <VStack gap={3}>
          <Heading level={4} accessibilityLevel={3} id={`${id}-heading`}>
            {skill.title}
          </Heading>
          <HStack align="end" gap={2} wrap="wrap">
            <Selector
              size="sm"
              label="Published version"
              options={Array.from(versions)}
              onChange={selectVersion}
              value={version}
            />
            {page > 0 && (
              <Button
                size="sm"
                label="Newer versions"
                onClick={() => setPage(page - 1)}
              />
            )}
            {detail.data?.hasMore && (
              <Button
                size="sm"
                label="Older versions"
                onClick={() => setPage(page + 1)}
              />
            )}
          </HStack>
          {detail.isError && (
            <p role="alert">Couldn't load the version list.</p>
          )}
          {preview.isPending && <p role="status">Loading version {version}…</p>}
          {preview.isError && (
            <p role="alert">Couldn't preview version {version}.</p>
          )}
          {preview.data && (
            <>
              <VStack as="dl" gap={2}>
                <VStack gap={0.5}>
                  <dt>
                    <Text type="label">Source</Text>
                  </dt>
                  <dd>
                    <Text type="supporting" wordBreak="break-word">
                      {preview.data.source} · {skill.namespace}/{skill.slug}
                    </Text>
                  </dd>
                </VStack>
                {preview.data.publisher && (
                  <VStack gap={0.5}>
                    <dt>
                      <Text type="label">Publisher</Text>
                    </dt>
                    <dd>
                      <Text type="supporting">{preview.data.publisher}</Text>
                    </dd>
                  </VStack>
                )}
                <VStack gap={0.5}>
                  <dt>
                    <Text type="label">Version</Text>
                  </dt>
                  <dd>
                    <Text type="supporting">{preview.data.version}</Text>
                  </dd>
                </VStack>
              </VStack>
              <VStack gap={1}>
                <Heading level={5} accessibilityLevel={4}>
                  OpenBot compatibility
                </Heading>
                {preview.data.runtimeRequirements && (
                  <Text as="p" wordBreak="break-word">
                    {preview.data.runtimeRequirements}
                  </Text>
                )}
                {preview.data.installable ? (
                  <Text as="p">
                    Confirmed for OpenBot. Requires only SKILL.md.
                  </Text>
                ) : (
                  <>
                    <Text as="p">This version cannot be installed.</Text>
                    <List listStyle="disc" density="compact">
                      {preview.data.reasons.map((reason) => (
                        <ListItem
                          key={reason}
                          label={<Text wordBreak="break-word">{reason}</Text>}
                        />
                      ))}
                    </List>
                  </>
                )}
              </VStack>
              {isAdmin && (
                <MarketVersionControl
                  key={versionPath}
                  version={preview.data}
                  disableReason={preview.data.disableReason ?? null}
                />
              )}
              {preview.data.canAssignCommand && (
                <MarketCommandAssignment path={path} />
              )}
              {preview.data.installable &&
                preview.data.command &&
                (installed ? (
                  preview.data.source === installed.skill.registry &&
                  preview.data.command === installed.skill.command ? (
                    <MarketSwitch
                      key={versionPath}
                      installed={installed}
                      version={version}
                      versionPath={versionPath}
                    />
                  ) : (
                    <p role="alert">
                      This version belongs to a different market source.
                    </p>
                  )
                ) : (
                  <MarketInstall
                    key={versionPath}
                    command={preview.data.command}
                    versionPath={versionPath}
                  />
                ))}
              <VStack gap={1}>
                <Heading level={5} accessibilityLevel={4}>
                  Instructions
                </Heading>
                <CodeBlock
                  code={preview.data.instructions}
                  container="section"
                  hasCopyButton={false}
                  isWrapped
                  width="100%"
                />
              </VStack>
            </>
          )}
        </VStack>
      </Section>
    </section>
  );
}

function MarketCommandAssignment({ path }: { path: string }) {
  const helpId = useId();
  const queryClient = useQueryClient();
  const assign = useMutation({
    mutationFn: (command: string) =>
      client(`/api/skill-market${path}/command`, {
        method: "POST",
        body: { command },
        fallback: "Couldn't assign the slash command.",
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: marketVersionQueryKey(path),
      }),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const command = new FormData(event.currentTarget).get("command");
        if (typeof command === "string" && !assign.isPending)
          assign.mutate(command);
      }}
    >
      <VStack gap={2}>
        <HStack align="end" gap={2} wrap="wrap">
          <VStack as="label" gap={1}>
            <Text type="label">New slash command</Text>
            <Input
              aria-describedby={helpId}
              name="command"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={40}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              required
              disabled={assign.isPending}
            />
          </VStack>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            isLoading={assign.isPending}
            label={assign.isPending ? "Assigning…" : "Assign command"}
          />
        </HStack>
        <Text as="p" type="supporting" id={helpId}>
          Use lowercase letters or digits with single hyphens between groups.
          All Bots that install this skill will use this command.
        </Text>
        {assign.error && <p role="alert">{assign.error.message}</p>}
      </VStack>
    </form>
  );
}

type InstallTarget = { id: string; title: string };

function useInstallTargets() {
  return useQuery({
    queryKey: ["skill-market", "install-targets"],
    queryFn: ({ signal }) =>
      load<{ bots: InstallTarget[] }>("/install-targets", signal),
    retry: false,
  });
}

type InstalledSkill = {
  command: string;
  namespace: string;
  slug: string;
  registry: string;
  title: string;
  version: string;
  versionId: number;
};

function installationsKey(agentId: string) {
  return ["skill-market", "installations", agentId];
}

function installationsPath(agentId: string) {
  return `/bots/${encodeURIComponent(agentId)}/installations`;
}

function refreshBotSkills(
  queryClient: ReturnType<typeof useQueryClient>,
  agentId: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: installationsKey(agentId) }),
    queryClient.invalidateQueries({ queryKey: pluginKeys.forAgent(agentId) }),
  ]);
}

function InstalledMarketSkills({ isAdmin }: { isAdmin: boolean }) {
  const targets = useInstallTargets();
  const [agentId, setAgentId] = useState("");
  if (targets.isPending) return <p role="status">Loading Bots…</p>;
  if (targets.isError)
    return (
      <p role="alert">
        Couldn't load Bots for skill management.{" "}
        <Button
          variant="ghost"
          size="sm"
          label="Try again"
          onClick={() => void targets.refetch()}
        />
      </p>
    );
  if (!targets.data.bots.length) return null;
  return (
    <VStack gap={2}>
      <Selector
        label="Manage installed skills on"
        placeholder="Choose a Bot"
        options={[
          { value: "", label: "Choose a Bot" },
          ...targets.data.bots.map((bot) => ({
            value: bot.id,
            label: bot.title,
          })),
        ]}
        value={agentId}
        onChange={setAgentId}
      />
      {agentId && (
        <BotMarketInstallations
          key={agentId}
          agentId={agentId}
          isAdmin={isAdmin}
        />
      )}
    </VStack>
  );
}

function BotMarketInstallations({
  agentId,
  isAdmin,
}: {
  agentId: string;
  isAdmin: boolean;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [command, setCommand] = useState("");
  const [version, selectVersion] = useState("");
  const path = installationsPath(agentId);
  const list = useQuery({
    queryKey: installationsKey(agentId),
    queryFn: ({ signal }) =>
      load<{ installations: InstalledSkill[] }>(path, signal),
    retry: false,
  });
  const uninstall = useMutation({
    mutationFn: (skill: InstalledSkill) =>
      client(`/api/skill-market${path}/${encodeURIComponent(skill.command)}`, {
        method: "DELETE",
        body: { expectedVersionId: skill.versionId },
        fallback: "Couldn't uninstall this skill.",
      }),
    onSettled: () => refreshBotSkills(queryClient, agentId),
  });
  const selected = list.data?.installations.find(
    (skill) => skill.command === command,
  );

  return (
    <>
      {list.isPending && <p role="status">Loading installed skills…</p>}
      {list.isError && (
        <p role="alert">
          Couldn't load installed skills.{" "}
          <Button
            variant="ghost"
            size="sm"
            label="Try again"
            onClick={() => void list.refetch()}
          />
        </p>
      )}
      {list.data?.installations.length === 0 && (
        <p>This Bot has no installed market skills.</p>
      )}
      {list.data && list.data.installations.length > 0 && (
        <List edge="flush" hasDividers>
          {list.data.installations.map((skill) => (
            <ListItem
              key={skill.command}
              label={
                <Text type="label" wordBreak="break-word">
                  {skill.title} <Text type="code">/{skill.command}</Text>
                </Text>
              }
              description={`Installed version ${skill.version}`}
              endContent={
                <HStack gap={2} wrap="wrap" justify="end">
                  <Button
                    aria-label={`Change version of ${skill.title}`}
                    aria-expanded={command === skill.command}
                    aria-controls={command === skill.command ? id : undefined}
                    label="Change version"
                    size="sm"
                    onClick={() => {
                      setCommand(
                        command === skill.command ? "" : skill.command,
                      );
                      selectVersion(skill.version);
                    }}
                  />
                  <Button
                    aria-label={`Uninstall ${skill.title}`}
                    label="Uninstall"
                    size="sm"
                    isDisabled={uninstall.isPending}
                    onClick={() => uninstall.mutate(skill)}
                  />
                </HStack>
              }
            />
          ))}
        </List>
      )}
      {uninstall.error && <p role="alert">{uninstall.error.message}</p>}
      {uninstall.isSuccess && (
        <p role="status">Uninstalled {uninstall.variables.title}.</p>
      )}
      {selected && (
        <MarketPreview
          isAdmin={isAdmin}
          key={selected.command}
          id={id}
          installed={{ agentId, skill: selected }}
          skill={selected}
          version={version}
          selectVersion={selectVersion}
        />
      )}
    </>
  );
}

function MarketSwitch({
  installed: { agentId, skill },
  version,
  versionPath,
}: {
  installed: { agentId: string; skill: InstalledSkill };
  version: string;
  versionPath: string;
}) {
  const queryClient = useQueryClient();
  const changeVersion = useMutation({
    mutationFn: (expectedVersionId: number) =>
      client(`/api/skill-market${versionPath}/switch`, {
        method: "POST",
        body: { agentId, expectedVersionId },
        fallback: "Couldn't change the installed version.",
      }),
    onSettled: () => refreshBotSkills(queryClient, agentId),
  });
  return (
    <VStack gap={1} align="start">
      <Button
        size="sm"
        variant="primary"
        isDisabled={version === skill.version}
        isLoading={changeVersion.isPending}
        onClick={() => changeVersion.mutate(skill.versionId)}
        label={changeVersion.isPending ? "Switching…" : `Switch to ${version}`}
      />
      {changeVersion.error && <p role="alert">{changeVersion.error.message}</p>}
      {changeVersion.isSuccess && <p role="status">Switched to {version}.</p>}
    </VStack>
  );
}

function MarketInstall({
  command,
  versionPath,
}: {
  command: string;
  versionPath: string;
}) {
  const [agentId, setAgentId] = useState("");
  const queryClient = useQueryClient();
  const targets = useInstallTargets();
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
    onSuccess: (_result, bot) => refreshBotSkills(queryClient, bot.id),
  });

  if (targets.isPending) return <p role="status">Loading Bots…</p>;
  if (targets.isError) {
    return (
      <p role="alert">
        Couldn't load Bots for installation.{" "}
        <Button
          variant="ghost"
          size="sm"
          label="Try again"
          onClick={() => void targets.refetch()}
        />
      </p>
    );
  }
  if (targets.data.bots.length === 0) {
    return <p>You don't manage any Bots that can install this skill.</p>;
  }
  const selected = targets.data.bots.find((bot) => bot.id === agentId);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (selected && !install.isPending) install.mutate(selected);
      }}
    >
      <VStack gap={2}>
        <Text as="p">
          Slash command <Text type="code">/{command}</Text>
        </Text>
        <HStack align="end" gap={2} wrap="wrap">
          <Selector
            label="Bot"
            placeholder="Choose a Bot"
            options={[
              { value: "", label: "Choose a Bot" },
              ...targets.data.bots.map((bot) => ({
                value: bot.id,
                label: bot.title,
              })),
            ]}
            isDisabled={install.isPending}
            value={selected?.id ?? ""}
            onChange={(value) => {
              setAgentId(value);
              install.reset();
            }}
          />
          <Button
            type="submit"
            size="md"
            variant="primary"
            isDisabled={!selected || install.isSuccess}
            isLoading={install.isPending}
            label={install.isPending ? "Installing…" : "Install on Bot"}
          />
        </HStack>
        {install.error && <p role="alert">{install.error.message}</p>}
        {install.data && (
          <p role="status">
            Installed {install.data.version}. Use /{install.data.command} on{" "}
            {install.data.botTitle}.
          </p>
        )}
      </VStack>
    </form>
  );
}
