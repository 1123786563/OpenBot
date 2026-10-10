import {
  IconCheck,
  IconMessage,
  IconPlug,
  IconPlus,
  IconSearch,
  IconShoppingBag,
  IconTrash,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { PageShell } from "@/components/layout/page-shell";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  installExpertMutationOptions,
  installMarketSkillMutationOptions,
  uninstallExpertMutationOptions,
  uninstallMarketSkillMutationOptions,
} from "@/lib/marketplace/mutations";
import {
  type MarketExpert,
  marketplaceQueryOptions,
  type MarketSkill,
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
import { invalidateMarketplace } from "@/lib/marketplace/mutations";
import { queryClient } from "@/query-client";

/**
 * The marketplace: packaged experts, skills and connectors on cards, installed with one press.
 *
 * Three shelves in one page because they answer one question — "what can I add to make my Bots more
 * capable" — and because the alternative is three near-identical pages. Each shelf draws from where
 * its truth lives: experts and skills from the catalogue endpoint (which knows what this person has
 * installed), connectors from the plugin screens' own sources, so an install made anywhere shows as
 * installed here.
 *
 * THE CONNECTOR SHELF KEEPS THE GOVERNANCE THE PLUGIN SCREENS ALREADY PUT AROUND CONNECTORS. Adding
 * one is an administrative act — it carries a credential for the deployment — so the install
 * buttons and the broker directories are drawn for an administrator only; everybody else sees what
 * the deployment has and who to ask. Experts and skills are prose and stay per-person installs, the
 * same split the skills page's comment states.
 */

export const Route = createFileRoute("/_authed/_app/market")({
  component: MarketPage,
});

type Tab = "experts" | "skills" | "connectors";

type ConnectorCardData = {
  key: string;
  title: string;
  description: string;
  categories: string[];
  logo: string | null;
  installed: boolean;
  source: "catalogue" | "open-connector" | "composio";
  /** Enabled but with no connected account yet, which is what 去连接 is for. */
  needsAccount: boolean;
};

/** The card shell every shelf draws, so the three grids read as one marketplace. */
function MarketCard({
  icon,
  title,
  subtitle,
  description,
  tags,
  actions,
  footer,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  description: React.ReactNode;
  tags?: React.ReactNode;
  actions: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="group flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-ring/50">
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center font-medium leading-tight">
            <span className="truncate">{title}</span>
          </div>
          {subtitle ? (
            <p className="mt-0.5 truncate text-muted-foreground text-xs">
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
      <p className="line-clamp-2 min-h-10 text-muted-foreground text-sm">
        {description}
      </p>
      <div className="flex flex-wrap gap-1.5 empty:hidden">{tags}</div>
      {/*
       * The footer row has the card's full width to itself, which is where the two-button actions
       * live: in the header they fought the title for width and on a three-column grid the title
       * lost — squeezed to an ellipsis nobody could read.
       */}
      {footer ? (
        <div className="-mt-1 flex items-center justify-end gap-1.5">{footer}</div>
      ) : null}
    </div>
  );
}

function TagChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground text-xs">
      {children}
    </span>
  );
}

function MarkIcon() {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
      <IconPlug className="size-5" />
    </div>
  );
}

function EmojiMark({ glyph }: { glyph: string }) {
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-xl">
      {glyph}
    </div>
  );
}

/** The 安装 button and its states, shared by every card that has one. */
function InstallButton({
  pending,
  onClick,
  label,
}: {
  pending: boolean;
  onClick: () => void;
  label: { install: string; pending: string };
}) {
  return (
    <Button
      aria-label={pending ? label.pending : label.install}
      disabled={pending}
      onClick={onClick}
      size="icon-sm"
      title={pending ? label.pending : label.install}
      variant="outline"
    >
      <IconPlus className="size-4" />
    </Button>
  );
}

function InstalledMark({ label }: { label: string }) {
  return (
    <span
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground"
      title={label}
    >
      <IconCheck className="size-4" />
    </span>
  );
}

function UninstallButton({
  pending,
  onClick,
  label,
}: {
  pending: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      aria-label={label}
      disabled={pending}
      onClick={onClick}
      size="icon-sm"
      title={label}
      variant="ghost"
    >
      <IconTrash className="size-4 text-muted-foreground" />
    </Button>
  );
}

function ExpertCard({
  expert,
  install,
  uninstall,
  pending,
  label,
}: {
  expert: MarketExpert;
  install: () => void;
  uninstall: () => void;
  pending: boolean;
  label: {
    install: string;
    installed: string;
    pending: string;
    uninstall: string;
    chat: string;
  };
}) {
  const tags = (
    <>
      {expert.tags.map((tag) => (
        <TagChip key={tag}>{tag}</TagChip>
      ))}
      <TagChip>{expert.category}</TagChip>
    </>
  );
  const icon = <EmojiMark glyph={expert.avatar} />;
  if (expert.installed && expert.agentId) {
    return (
      <MarketCard
        actions={<InstalledMark label={label.installed} />}
        description={expert.description}
        footer={
          <>
            <Button
              disabled={pending}
              onClick={uninstall}
              size="sm"
              variant="ghost"
            >
              {label.uninstall}
            </Button>
            <Button
              render={(props) => (
                <Link
                  {...props}
                  search={{ agent: expert.agentId ?? undefined }}
                  to="/agents"
                />
              )}
              size="sm"
              variant="outline"
            >
              <IconMessage className="size-4" />
              {label.chat}
            </Button>
          </>
        }
        icon={icon}
        subtitle={expert.tagline}
        tags={tags}
        title={expert.name}
      />
    );
  }
  return (
    <MarketCard
      actions={
        <InstallButton
          label={{ install: label.install, pending: label.pending }}
          onClick={install}
          pending={pending}
        />
      }
      description={expert.description}
      icon={icon}
      subtitle={expert.tagline}
      tags={tags}
      title={expert.name}
    />
  );
}

function SkillCard({
  skill,
  install,
  uninstall,
  pending,
  label,
}: {
  skill: MarketSkill;
  install: () => void;
  uninstall: () => void;
  pending: boolean;
  label: {
    install: string;
    installed: string;
    pending: string;
    uninstall: string;
  };
}) {
  return (
    <MarketCard
      actions={
        skill.installed ? (
          skill.mine ? (
            <UninstallButton
              label={label.uninstall}
              onClick={uninstall}
              pending={pending}
            />
          ) : (
            <InstalledMark label={label.installed} />
          )
        ) : (
          <InstallButton
            label={{ install: label.install, pending: label.pending }}
            onClick={install}
            pending={pending}
          />
        )
      }
      description={skill.summary}
      icon={<EmojiMark glyph={skill.icon} />}
      tags={
        <>
          {/*
           * The slug is how the skill is invoked, so it sits with the tags where there is room
           * for it — beside the title it fought the actions for width and every long name lost.
           */}
          <TagChip>
            <code className="font-mono text-foreground/60">/{skill.slug}</code>
          </TagChip>
          <TagChip>{skill.category}</TagChip>
        </>
      }
      title={skill.title}
    />
  );
}

function ConnectorCard({
  entry,
  install,
  pending,
  isAdmin,
  label,
}: {
  entry: ConnectorCardData;
  install: () => void;
  pending: boolean;
  isAdmin: boolean;
  label: {
    install: string;
    installed: string;
    pending: string;
    connect: string;
    contactAdmin: string;
  };
}) {
  const icon = entry.logo ? (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
      <PluginLogo logo={entry.logo} />
    </div>
  ) : (
    <MarkIcon />
  );
  const actions = entry.installed ? (
    entry.needsAccount ? (
      <Button
        render={(props) => (
          <Link {...props} to="/settings/connected-accounts" />
        )}
        size="sm"
        variant="outline"
      >
        {label.connect}
      </Button>
    ) : (
      <InstalledMark label={label.installed} />
    )
  ) : isAdmin ? (
    <InstallButton
      label={{ install: label.install, pending: label.pending }}
      onClick={install}
      pending={pending}
    />
  ) : (
    <span className="text-muted-foreground text-xs">
      {label.contactAdmin}
    </span>
  );
  return (
    <MarketCard
      actions={actions}
      description={entry.description}
      icon={icon}
      tags={entry.categories.slice(0, 3).map((category) => (
        <TagChip key={category}>{category}</TagChip>
      ))}
      title={entry.title}
    />
  );
}

function ConnectorSection({
  title,
  cards,
  install,
  pending,
  isAdmin,
  label,
}: {
  title: string;
  cards: ConnectorCardData[];
  install: (entry: ConnectorCardData) => void;
  pending: boolean;
  isAdmin: boolean;
  label: {
    install: string;
    installed: string;
    pending: string;
    connect: string;
    contactAdmin: string;
    empty: string;
  };
}) {
  return (
    <section>
      <h2 className="font-medium text-sm">{title}</h2>
      {cards.length === 0 ? (
        <p className="mt-2 text-muted-foreground text-sm">{label.empty}</p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((entry) => (
            <ConnectorCard
              entry={entry}
              install={() => install(entry)}
              isAdmin={isAdmin}
              key={`${entry.source}-${entry.key}`}
              label={label}
              pending={pending}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GridEmpty({ label }: { label: string }) {
  return (
    <Empty className="mt-4 h-[220px] border border-dashed">
      <EmptyHeader>
        <EmptyTitle className="text-muted-foreground">{label}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function MarketPage() {
  const { t } = useTranslation("market");
  const [tab, setTab] = React.useState<Tab>("experts");
  const [search, setSearch] = React.useState("");
  const [installedOnly, setInstalledOnly] = React.useState(false);
  const [category, setCategory] = React.useState<string>("all");
  // Broker directories take the term server-side; it follows debounce like the admin picker, one
  // round trip per settled term rather than per keystroke.
  const [brokerQuery, setBrokerQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setBrokerQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const marketplace = useQuery(marketplaceQueryOptions());
  const plugins = useQuery(pluginsPageQueryOptions());
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
  // Which keys are mid-request, tracked beside one shared mutation per kind — the same shape the
  // admin picker uses, because one observer cannot describe more than the most recent press.
  //
  // THE SETTLED HANDLER HERE IS THE WHOLE REFETCH, NOT ONLY THE BOOKKEEPING. Spreading `track()`
  // over mutation options replaces their `onSettled` rather than running beside it (the exact trap
  // the admin picker's comment warns about), so the refetch the factories carry has to happen
  // HERE: without it, a press succeeded at the server and the card never heard about it.
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const track = (key: string) => ({
    onMutate: () => {
      setActionError(null);
      setBusy((held) => new Set(held).add(key));
    },
    onError: (thrown: Error) => setActionError(thrown.message),
    onSettled: async () => {
      setBusy((held) => {
        const left = new Set(held);
        left.delete(key);
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
  const matches = (...fields: (string | null | undefined)[]) =>
    term.length === 0 ||
    fields.some((field) => (field ?? "").toLowerCase().includes(term));

  const experts = (marketplace.data?.experts ?? [])
    .filter((expert) => !installedOnly || expert.installed)
    .filter((expert) => category === "all" || expert.category === category)
    .filter((expert) =>
      matches(expert.name, expert.tagline, expert.description, ...expert.tags),
    );

  const skills = (marketplace.data?.skills ?? [])
    .filter((skill) => !installedOnly || skill.installed)
    .filter((skill) => category === "all" || skill.category === category)
    .filter((skill) => matches(skill.title, skill.summary, skill.slug));

  const addedServers = new Set((plugins.data?.servers ?? []).map((s) => s.id));
  const catalogueCards: ConnectorCardData[] = (
    plugins.data?.catalogue ?? []
  )
    .filter((entry) => !installedOnly || addedServers.has(entry.key))
    .filter((entry) => matches(entry.title, entry.summary, entry.vendor))
    .map((entry) => ({
      key: entry.key,
      title: entry.title,
      description: entry.summary,
      categories: [],
      logo: null,
      installed: addedServers.has(entry.key),
      needsAccount: false,
      source: "catalogue" as const,
    }));

  const brokerCards = (
    apps: ComposioApp[] | undefined,
    source: "open-connector" | "composio",
  ): ConnectorCardData[] =>
    (apps ?? [])
      .filter((app) => !installedOnly || app.enabled)
      .filter((app) => category === "all" || app.categories.includes(category))
      .filter((app) => matches(app.name, app.description))
      .map((app) => ({
        key: app.slug,
        title: app.name,
        description: app.description,
        categories: app.categories,
        logo: app.logo,
        installed: app.enabled,
        needsAccount: false,
        source,
      }));

  const openConnectorCards = brokerCards(
    openConnector.data?.apps,
    "open-connector",
  );
  const composioCards = brokerCards(composio.data?.apps, "composio");

  const installConnector = (entry: ConnectorCardData) => {
    if (entry.source === "catalogue") {
      addCurated.mutate({ key: entry.key });
      return;
    }
    if (entry.source === "open-connector") {
      enableOpenConnector.mutate({ slug: entry.key });
      return;
    }
    enableComposio.mutate({ slug: entry.key });
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "experts", label: t("tab.experts") },
    { key: "skills", label: t("tab.skills") },
    { key: "connectors", label: t("tab.connectors") },
  ];

  const cardLabel = {
    install: t("install"),
    installed: t("installed"),
    pending: t("installing"),
    uninstall: t("uninstall"),
    connect: t("connect"),
    contactAdmin: t("contactAdmin"),
  };
  const pending = marketplace.isPending || plugins.isPending;

  return (
    <PageShell description={t("description")} title={t("title")}>
      {actionError ? (
        <p className="text-destructive text-sm" role="alert">
          {actionError}
        </p>
      ) : null}

      {/*
       * The shelf switcher, the search and the installed filter on one row, the way the reference
       * marketplace draws them: the tabs are the page's primary navigation and the two narrowing
       * controls sit at the far edge where a mouse already is.
       */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-1">
          {tabs.map((entry) => (
            <button
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                tab === entry.key
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              key={entry.key}
              onClick={() => {
                setTab(entry.key);
                setSearch("");
                setCategory("all");
              }}
              type="button"
            >
              {entry.key === "connectors" ? (
                <IconPlug className="size-4" />
              ) : (
                <IconShoppingBag className="size-4" />
              )}
              {entry.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("searchAria")}
            className="w-56 pl-8"
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
        <Button
          onClick={() => setInstalledOnly((held) => !held)}
          size="sm"
          variant={installedOnly ? "default" : "outline"}
        >
          {t("installedOnly")}
        </Button>
      </div>

      {activeCategories.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <button
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              category === "all"
                ? "bg-foreground font-medium text-background"
                : "border border-border text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setCategory("all")}
            type="button"
          >
            {t("category.all")}
          </button>
          {activeCategories.map((entry) => (
            <button
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                category === entry
                  ? "bg-foreground font-medium text-background"
                  : "border border-border text-muted-foreground hover:text-foreground"
              }`}
              key={entry}
              onClick={() => setCategory(entry)}
              type="button"
            >
              {entry}
            </button>
          ))}
        </div>
      ) : null}

      {pending ? null : marketplace.error ? (
        <p className="mt-6 text-destructive text-sm" role="alert">
          {marketplace.error.message || t("loadError")}
        </p>
      ) : (
        <div className="mt-5">
          {tab === "experts" ? (
            experts.length === 0 ? (
              <GridEmpty label={t("empty.experts")} />
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {experts.map((expert) => (
                  <ExpertCard
                    expert={expert}
                    install={() => installExpert.mutate(expert.slug)}
                    key={expert.slug}
                    label={{
                      ...cardLabel,
                      chat: t("chat"),
                    }}
                    pending={busy.has("expert")}
                    uninstall={() => uninstallExpert.mutate(expert.slug)}
                  />
                ))}
              </div>
            )
          ) : tab === "skills" ? (
            skills.length === 0 ? (
              <GridEmpty label={t("empty.skills")} />
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {skills.map((skill) => (
                  <SkillCard
                    install={() => installSkill.mutate(skill.slug)}
                    key={skill.slug}
                    label={cardLabel}
                    pending={busy.has("skill")}
                    skill={skill}
                    uninstall={() => uninstallSkill.mutate(skill.slug)}
                  />
                ))}
              </div>
            )
          ) : (
            <div className="space-y-6">
              {catalogueCards.length > 0 ? (
                <ConnectorSection
                  cards={catalogueCards}
                  install={installConnector}
                  isAdmin={isAdmin === true}
                  label={{ ...cardLabel, empty: t("empty.connectors") }}
                  pending={busy.has("connector")}
                  title={t("section.builtin")}
                />
              ) : null}
              {isAdmin ? (
                <>
                  <ConnectorSection
                    cards={openConnectorCards}
                    install={installConnector}
                    isAdmin
                    label={{
                      ...cardLabel,
                      empty: openConnector.isPending
                        ? t("loading")
                        : t("empty.search", { query: brokerQuery.trim() }),
                    }}
                    pending={busy.has("connector")}
                    title={t("section.openConnector")}
                  />
                  <ConnectorSection
                    cards={composioCards}
                    install={installConnector}
                    isAdmin
                    label={{
                      ...cardLabel,
                      empty: composio.isPending
                        ? t("loading")
                        : t("empty.search", { query: brokerQuery.trim() }),
                    }}
                    pending={busy.has("connector")}
                    title={t("section.composio")}
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("connectors.adminHint")}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
