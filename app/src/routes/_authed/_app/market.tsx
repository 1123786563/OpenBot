import {
  IconBolt,
  IconPencil,
  IconPlug,
  IconSearch,
  IconSparkles,
  IconUser,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { ConnectorDialogWb, ConnectorsPane, type ConnectorSubject } from "@/components/market/connectors-pane";
import {
  AgentDialogWb,
  ExpertsPane,
  TemplateDialogWb,
} from "@/components/market/experts-pane";
import { MyExpertsView } from "@/components/market/my-experts-view";
import {
  SkillDialogWb,
  SkillsPane,
  type SkillSubject,
} from "@/components/market/skills-pane";
import { WbCardSkeleton, WbSecondaryButton } from "@/components/market/wb";
import { SidebarToggleBar } from "@/components/layout/sidebar-toggle";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  installExpertMutationOptions,
  installMarketSkillMutationOptions,
  invalidateMarketplace,
  uninstallExpertMutationOptions,
  uninstallMarketSkillMutationOptions,
} from "@/lib/marketplace/mutations";
import {
  type MarketExpert,
  marketplaceQueryOptions,
} from "@/lib/marketplace/queries";
import {
  addCuratedServerMutationOptions,
  enableComposioAppMutationOptions,
  enableOpenConnectorAppMutationOptions,
  invalidatePlugins,
} from "@/lib/plugins/mutations";
import {
  type ComposioApp,
  composioAppsQueryOptions,
  openConnectorAppsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";
import { queryClient } from "@/query-client";
import { cn } from "@/lib/utils";

/**
 * The marketplace, drawn in the WorkBuddy client's 专家·技能·连接器 layout (v5.7.7): one sticky
 * top bar with the three shelves as tabs, a search box and at most one verb on the right, and
 * each shelf carrying WorkBuddy's own sections — featured scenario cards and an expert centre for
 * 专家, a featured pair and shelf sub-tabs for 技能, a flat icon-card grid for 连接器 — with
 * WorkBuddy's detail dialog presenting whichever card was opened.
 *
 * THE MAPPING THE PAGE EXISTS TO SHOW: an OpenBot Agent is a WB expert (「我的专家」 renders the
 * roster), an OpenBot skill is a WB skill, an OpenBot plugin is a WB connector. Every card draws
 * only fields the rest of the app already shows.
 *
 * THE CONNECTOR SHELF KEEPS THE GOVERNANCE THE PLUGIN SCREENS ALREADY PUT AROUND CONNECTORS.
 * Adding one is an administrative act — it carries a credential for the deployment — so install
 * affordances and the broker directories draw for an administrator only; everybody else sees what
 * the deployment has and who to ask.
 */

export const Route = createFileRoute("/_authed/_app/market")({
  component: MarketPage,
});

type Tab = "experts" | "skills" | "connectors";

function MarketPage() {
  const { t } = useTranslation("market");
  const [tab, setTab] = React.useState<Tab>("experts");
  const [view, setView] = React.useState<"hub" | "mine">("hub");
  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState<string>("all");
  const [installedOnly, setInstalledOnly] = React.useState(false);
  // Broker directories take the term server-side; it follows debounce like the admin picker, one
  // round trip per settled term rather than per keystroke.
  const [brokerQuery, setBrokerQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setBrokerQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const marketplace = useQuery(marketplaceQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const me = useQuery(currentUserQueryOptions());
  const isAdmin = me.data?.role === "admin";
  const connectorsTab = tab === "connectors";
  const openConnector = useQuery({
    ...openConnectorAppsQueryOptions(brokerQuery),
    enabled: connectorsTab && isAdmin,
  });
  const composio = useQuery({
    ...composioAppsQueryOptions(brokerQuery),
    enabled: connectorsTab && isAdmin,
  });

  const [actionError, setActionError] = React.useState<string | null>(null);
  // Which kinds are mid-request, tracked beside one shared mutation per kind — the same shape the
  // admin picker uses, because one observer cannot describe more than the most recent press.
  //
  // THE SETTLED HANDLER HERE IS THE WHOLE REFETCH, NOT ONLY THE BOOKKEEPING. Spreading `track()`
  // over mutation options replaces their `onSettled` rather than running beside it, so the refetch
  // the factories carry has to happen HERE: without it, a press succeeded at the server and the
  // card never heard about it.
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const track = (kind: string) => ({
    onMutate: () => {
      setActionError(null);
      setBusy((held) => new Set(held).add(kind));
    },
    onError: (thrown: Error) => setActionError(thrown.message),
    onSettled: async () => {
      setBusy((held) => {
        const left = new Set(held);
        left.delete(kind);
        return left;
      });
      await invalidateMarketplace(queryClient);
      invalidatePlugins(queryClient);
    },
  });

  const installExpert = useMutation({
    ...installExpertMutationOptions(queryClient),
    ...track("expert"),
  });
  const uninstallExpert = useMutation({
    ...uninstallExpertMutationOptions(queryClient),
    ...track("expert"),
  });
  const installSkill = useMutation({
    ...installMarketSkillMutationOptions(queryClient),
    ...track("skill"),
  });
  const uninstallSkill = useMutation({
    ...uninstallMarketSkillMutationOptions(queryClient),
    ...track("skill"),
  });
  const addCurated = useMutation({
    ...addCuratedServerMutationOptions(queryClient),
    ...track("connector"),
  });
  const enableOpenConnector = useMutation({
    ...enableOpenConnectorAppMutationOptions(queryClient),
    ...track("connector"),
  });
  const enableComposio = useMutation({
    ...enableComposioAppMutationOptions(queryClient),
    ...track("connector"),
  });

  const categories = marketplace.data?.categories;
  const activeCategories = categories
    ? tab === "connectors"
      ? categories.connectors
      : tab === "skills"
        ? categories.skills
        : categories.experts
    : [];

  const term = search.trim().toLowerCase();
  const searching = term.length > 0;
  const matches = (...fields: (string | null | undefined)[]) =>
    !searching || fields.some((field) => (field ?? "").toLowerCase().includes(term));

  const experts = (marketplace.data?.experts ?? [])
    .filter((expert) => !installedOnly || expert.installed)
    .filter((expert) => matches(expert.name, expert.tagline, expert.description, ...expert.tags));

  const skills = (marketplace.data?.skills ?? [])
    .filter((skill) => !installedOnly || skill.installed)
    .filter((skill) => matches(skill.title, skill.summary, skill.slug));

  const allSkills = plugins.data?.skills ?? [];
  const mineSkills = allSkills
    .filter((skill) => skill.ownerUserId === me.data?.id)
    .filter((skill) => matches(skill.title, skill.summary, skill.slug));
  const deploymentSkills = allSkills
    .filter((skill) => skill.ownerUserId === null)
    .filter((skill) => matches(skill.title, skill.summary, skill.slug));

  const agentList = (agents.data ?? []).filter((agent) => !agent.hidden);

  const servers = (plugins.data?.servers ?? []).filter((server) =>
    matches(server.title, server.summary, server.vendor),
  );
  const catalogue = (plugins.data?.catalogue ?? [])
    .filter((entry) => !installedOnly || servers.some((s) => s.id === entry.key))
    .filter((entry) => matches(entry.title, entry.summary, entry.vendor));
  const filterBroker = (apps: ComposioApp[] | undefined) =>
    (apps ?? [])
      .filter((app) => !installedOnly || app.enabled)
      .filter((app) => matches(app.name, app.description));

  const installConnector = (entry: ConnectorSubject) => {
    if (entry.kind === "catalogue") {
      addCurated.mutate({ key: entry.item.key });
      return;
    }
    if (entry.kind === "broker") {
      if (entry.source === "open-connector") {
        enableOpenConnector.mutate({ slug: entry.app.slug });
        return;
      }
      enableComposio.mutate({ slug: entry.app.slug });
    }
  };

  const pending = marketplace.isPending || plugins.isPending;
  const skillBusy = busy.has("skill");
  const installedSkillCount = (marketplace.data?.skills ?? []).filter(
    (skill) => skill.installed,
  ).length;

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "experts", label: t("tab.experts"), icon: <IconSparkles className="size-5" /> },
    { key: "skills", label: t("tab.skills"), icon: <IconBolt className="size-5" /> },
    { key: "connectors", label: t("tab.connectors"), icon: <IconPlug className="size-5" /> },
  ];

  // Dialog subjects: one per card kind, held so the dialog survives the re-render a mutation
  // triggers (the card's data updates underneath, the dialog reads the fresh record).
  const [agentSubject, setAgentSubject] = React.useState<string | null>(null);
  const [templateSubject, setTemplateSubject] = React.useState<string | null>(null);
  const [skillSubject, setSkillSubject] = React.useState<SkillSubject | null>(null);
  const [connectorSubject, setConnectorSubject] = React.useState<
    Parameters<typeof ConnectorDialogWb>[0]["subject"]
  >(null);

  const agentOpen = agentList.find((agent) => agent.id === agentSubject) ?? null;
  const templateOpen =
    marketplace.data?.experts.find((expert) => expert.slug === templateSubject) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarToggleBar />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/*
         * The WorkBuddy top bar: the three shelf tabs at the left, search and the one verb at the
         * right edge. Sticky, because it is the page's primary navigation and the shelves scroll
         * under it.
         */}
        <div className="sticky top-0 z-20 border-border/60 border-b bg-background/95 backdrop-blur">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
            <nav aria-label={t("title")} className="flex items-center gap-6">
              {tabs.map((entry) => (
                <button
                  className={cn(
                    "flex items-center gap-1.5 text-base leading-6 font-semibold transition-colors",
                    tab === entry.key
                      ? "text-foreground"
                      : "text-foreground/50 hover:text-foreground",
                  )}
                  key={entry.key}
                  onClick={() => {
                    setTab(entry.key);
                    setView("hub");
                    setSearch("");
                    setCategory("all");
                    setInstalledOnly(false);
                  }}
                  type="button"
                >
                  {entry.icon}
                  {entry.label}
                </button>
              ))}
            </nav>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="relative">
                <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-foreground/40" />
                <input
                  aria-label={t("searchAria")}
                  className="h-9 w-56 rounded-lg border border-transparent bg-foreground/[0.04] pr-3 pl-8 text-sm text-foreground outline-none transition-colors placeholder:text-foreground/40 focus-visible:border-foreground/20 focus-visible:bg-card"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={
                    tab === "experts"
                      ? t("search.experts")
                      : tab === "skills"
                        ? t("search.skills")
                        : t("search.connectors")
                  }
                  value={search}
                />
              </div>
              {tab === "experts" && view === "hub" ? (
                <WbSecondaryButton onClick={() => setView("mine")}>
                  <IconUser className="size-4" />
                  {t("wb.myExperts")}
                </WbSecondaryButton>
              ) : null}
              {tab === "skills" ? (
                <WbSecondaryButton
                  aria-pressed={installedOnly}
                  className={cn(
                    installedOnly &&
                      "bg-primary text-primary-foreground hover:opacity-85 hover:bg-primary",
                  )}
                  onClick={() => setInstalledOnly((held) => !held)}
                >
                  {t("wb.installedCount", { count: installedSkillCount })}
                </WbSecondaryButton>
              ) : null}
              {tab === "connectors" && isAdmin ? (
                <Link
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-85"
                  to="/admin/plugins"
                >
                  <IconPencil className="size-4" />
                  {t("wb.customConnector")}
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="px-6 pt-5 pb-12">
          {actionError ? (
            <p className="mb-4 text-destructive text-sm" role="alert">
              {actionError}
            </p>
          ) : null}

          {pending ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <WbCardSkeleton key={i} />
              ))}
            </div>
          ) : marketplace.error && tab !== "connectors" ? (
            <p className="text-destructive text-sm" role="alert">
              {marketplace.error.message || t("loadError")}
            </p>
          ) : tab === "experts" ? (
            view === "mine" ? (
              <MyExpertsView
                agents={agentList}
                onBack={() => setView("hub")}
                onOpenAgent={(agent) => setAgentSubject(agent.id)}
              />
            ) : (
              <ExpertsPane
                agents={agentList}
                category={category}
                categories={activeCategories}
                experts={experts}
                onCategory={setCategory}
                onInstall={(slug) => installExpert.mutate(slug)}
                onOpenAgent={(agent) => setAgentSubject(agent.id)}
                onOpenMine={() => setView("mine")}
                onOpenTemplate={(expert) => setTemplateSubject(expert.slug)}
                onUninstall={(slug) => uninstallExpert.mutate(slug)}
                pendingInstall={busy.has("expert")}
                searching={searching}
              />
            )
          ) : tab === "skills" ? (
            <SkillsPane
              categories={activeCategories}
              category={category}
              deploymentSkills={deploymentSkills}
              marketSkills={skills}
              mineSkills={mineSkills}
              onCategory={setCategory}
              onOpen={setSkillSubject}
              onToggle={(skill) =>
                skill.installed && skill.mine
                  ? uninstallSkill.mutate(skill.slug)
                  : installSkill.mutate(skill.slug)
              }
              pendingInstall={skillBusy}
              searching={searching}
            />
          ) : (
            <ConnectorsPane
              catalogue={catalogue}
              categories={activeCategories}
              category={category}
              composioApps={filterBroker(composio.data?.apps)}
              isAdmin={isAdmin === true}
              onCategory={setCategory}
              onInstall={installConnector}
              onOpen={setConnectorSubject}
              openConnectorApps={filterBroker(openConnector.data?.apps)}
              servers={servers}
            />
          )}
        </div>
      </div>

      <AgentDialogWb agent={agentOpen} onClose={() => setAgentSubject(null)} />
      <TemplateDialogWb
        expert={templateOpen}
        label={{
          install: t("install"),
          installing: t("installing"),
          installed: t("installed"),
          chat: t("chat"),
          uninstall: t("uninstall"),
        }}
        onClose={() => setTemplateSubject(null)}
        onInstall={(expert) =>
          expert.installed
            ? uninstallExpert.mutate(expert.slug)
            : installExpert.mutate(expert.slug)
        }
        pending={busy.has("expert")}
      />
      <SkillDialogWb
        label={{ install: t("install"), installing: t("installing"), installed: t("installed") }}
        onClose={() => setSkillSubject(null)}
        onInstall={(slug) => installSkill.mutate(slug)}
        pendingInstall={skillBusy}
        subject={skillSubject}
      />
      <ConnectorDialogWb
        isAdmin={isAdmin === true}
        label={{
          install: t("install"),
          installing: t("installing"),
          installed: t("installed"),
          connect: t("connect"),
        }}
        onClose={() => setConnectorSubject(null)}
        onInstall={installConnector}
        pending={busy.has("connector")}
        subject={connectorSubject}
      />
    </div>
  );
}
