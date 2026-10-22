import {
  IconAlertTriangle,
  IconCheck,
  IconLink,
  IconPlug,
  IconSettings,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  WbAddButton,
  WbCard,
  WbCategoryChips,
  WbDesc,
  WbEmpty,
  WbIconSlot,
  WbIdRow,
  WbName,
  WbPrimaryButton,
  WbSectionTitle,
  WbStatsRow,
  WbTag,
} from "@/components/market/wb";
import { PluginLogo } from "@/components/plugins/plugin-logo";
import { ButtonLink } from "@/components/ui/router-link";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type {
  CatalogueItem,
  ComposioApp,
  PluginServer,
} from "@/lib/plugins/queries";

/**
 * The 连接器 shelf in WorkBuddy's connector layout: a flat three-column grid of icon cards, one
 * affordance in each top-right corner, detail on click.
 *
 * THE MAPPING IT PRESENTS: an OpenBot plugin (an MCP server) IS a WorkBuddy connector. What the
 * grid does keep from OpenBot is the governance the plugins screens already put around connectors —
 * adding one carries a deployment credential, so install affordances draw for an administrator
 * only, and everybody else sees what the deployment has with a pointer to who can add more.
 */

export type ConnectorSubject =
  | { kind: "server"; server: PluginServer }
  | { kind: "catalogue"; item: CatalogueItem }
  | { kind: "broker"; app: ComposioApp; source: "open-connector" | "composio" };

function ConnectorCard({
  icon,
  title,
  desc,
  tags,
  footer,
  action,
  onOpen,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  tags?: React.ReactNode;
  footer?: React.ReactNode;
  action?: React.ReactNode;
  onOpen: () => void;
}) {
  return (
    <WbCard
      className="w-full"
      interactive
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div className="relative flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1 pr-8">
          <WbName>{title}</WbName>
          <div className="mt-0.5">
            <WbDesc>{desc}</WbDesc>
          </div>
        </div>
        {action ? <div className="absolute top-0 right-0">{action}</div> : null}
      </div>
      {tags ? <div className="flex flex-wrap gap-1.5">{tags}</div> : null}
      {footer ? (
        <div className="mt-auto flex items-center gap-1.5 text-sm text-foreground/50">
          {footer}
        </div>
      ) : null}
    </WbCard>
  );
}

export function ConnectorDialogWb({
  subject,
  isAdmin,
  pending,
  onInstall,
  onClose,
  label,
}: {
  subject: ConnectorSubject | null;
  isAdmin: boolean;
  pending: boolean;
  onInstall: (subject: ConnectorSubject) => void;
  onClose: () => void;
  label: {
    install: string;
    installing: string;
    installed: string;
    connect: string;
  };
}) {
  const { t } = useTranslation("market");
  if (!subject) return null;

  if (subject.kind === "server") {
    const { server } = subject;
    const needsAccount =
      server.accountMode === "shared" && !server.sharedVendorConnected;
    const source =
      server.provenance === "first-party"
        ? t("wb.stats.sourceBuiltin")
        : t("wb.stats.sourceCustom");
    return (
      <Dialog onOpenChange={(open) => !open && onClose()} open={!!subject}>
        <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
          <div className="flex items-start gap-4">
            <WbIconSlot>
              <PluginLogo logo={server.logo} />
            </WbIconSlot>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate text-xl leading-7 font-semibold text-foreground">
                  {server.title}
                </span>
                <span className="truncate text-base text-foreground/40">
                  {server.vendor}
                </span>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                {needsAccount ? (
                  <ButtonLink
                    to="/settings/connected-accounts"
                    size="sm"
                    className="h-8 rounded-lg px-4"
                  >
                    {label.connect}
                  </ButtonLink>
                ) : isAdmin ? (
                  <ButtonLink
                    params={{ key: server.id }}
                    to="/admin/plugins/$key"
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-lg px-4"
                  >
                    <IconSettings className="size-4" />
                    {t("wb.manage")}
                  </ButtonLink>
                ) : (
                  <span className="flex items-center gap-1 text-sm text-foreground/50">
                    <IconCheck className="size-4 text-foreground/70" />
                    {label.installed}
                  </span>
                )}
              </div>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-foreground/80">
            {server.summary}
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <WbTag>{source}</WbTag>
            {server.authScheme ? <WbTag>{server.authScheme}</WbTag> : null}
          </div>
          <div className="mt-5 border-t border-border pt-5">
            <WbStatsRow
              stats={[
                { value: server.tools.length, label: t("wb.stats.tools") },
                {
                  value: server.hasCredential
                    ? t("wb.stats.configured")
                    : t("wb.stats.notConfigured"),
                  label: t("wb.stats.credential"),
                },
                { value: source, label: t("wb.stats.origin") },
              ]}
            />
          </div>
          {server.withdrawn.length > 0 ? (
            <p className="mt-4 flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 text-sm dark:text-amber-400">
              <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
              {t("wb.withdrawn", { count: server.withdrawn.length })}
            </p>
          ) : null}
          <div className="mt-5">
            <WbIdRow id={server.id} label="ID:" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (subject.kind === "catalogue") {
    const { item } = subject;
    return (
      <Dialog onOpenChange={(open) => !open && onClose()} open={!!subject}>
        <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
          <div className="flex items-start gap-4">
            <WbIconSlot>
              <IconPlug className="size-5 text-foreground/70" />
            </WbIconSlot>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="truncate text-xl leading-7 font-semibold text-foreground">
                  {item.title}
                </span>
                <span className="truncate text-base text-foreground/40">
                  {item.vendor}
                </span>
              </div>
              {isAdmin ? (
                <div className="mt-2.5">
                  <WbPrimaryButton
                    className="h-8 px-4"
                    disabled={pending}
                    onClick={() => onInstall(subject)}
                  >
                    {pending ? label.installing : label.install}
                  </WbPrimaryButton>
                </div>
              ) : null}
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-foreground/80">
            {item.summary}
          </p>
          <div className="mt-5 border-t border-border pt-5">
            <WbStatsRow
              stats={[
                {
                  value: t(`wb.auth.${item.auth}`),
                  label: t("wb.stats.credential"),
                },
                {
                  value: item.perInstance
                    ? t("wb.perInstance.yes")
                    : t("wb.perInstance.no"),
                  label: t("wb.stats.perInstance"),
                },
                { value: t("section.builtin"), label: t("wb.stats.origin") },
              ]}
            />
          </div>
          <div className="mt-5">
            <WbIdRow id={item.key} label="ID:" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const { app, source } = subject;
  const sourceLabel =
    source === "open-connector"
      ? t("section.openConnector")
      : t("section.composio");
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!subject}>
      <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <WbIconSlot>
            {app.logo ? (
              <PluginLogo logo={app.logo} />
            ) : (
              <IconPlug className="size-5 text-foreground/70" />
            )}
          </WbIconSlot>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-xl leading-7 font-semibold text-foreground">
                {app.name}
              </span>
              <span className="text-base text-foreground/40">
                {sourceLabel}
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              {app.enabled ? (
                <span className="flex items-center gap-1 text-sm text-foreground/50">
                  <IconCheck className="size-4 text-foreground/70" />
                  {label.installed}
                </span>
              ) : isAdmin ? (
                <WbPrimaryButton
                  className="h-8 px-4"
                  disabled={pending}
                  onClick={() => onInstall(subject)}
                >
                  {pending ? label.installing : label.install}
                </WbPrimaryButton>
              ) : (
                <span className="text-sm text-foreground/50">
                  {t("contactAdmin")}
                </span>
              )}
            </div>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-foreground/80">
          {app.description}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {app.categories.slice(0, 4).map((category) => (
            <WbTag key={category}>{category}</WbTag>
          ))}
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <WbStatsRow
            stats={[
              { value: app.actionCount, label: t("wb.stats.actions") },
              {
                value: app.categories.length,
                label: t("wb.stats.categoriesCount"),
              },
              { value: sourceLabel, label: t("wb.stats.origin") },
            ]}
          />
        </div>
        <div className="mt-5">
          <WbIdRow id={app.slug} label="ID:" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ServerCard({
  server,
  onOpen,
  label,
}: {
  server: PluginServer;
  onOpen: () => void;
  label: { installed: string; connect: string; tools: (n: number) => string };
}) {
  const needsAccount =
    server.accountMode === "shared" && !server.sharedVendorConnected;
  return (
    <ConnectorCard
      action={
        needsAccount ? (
          <ButtonLink
            onClick={(event) => event.stopPropagation()}
            to="/settings/connected-accounts"
            size="xs"
            variant="outline"
          >
            {label.connect}
          </ButtonLink>
        ) : (
          <span
            aria-label={label.installed}
            className="flex size-6 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/70"
            role="img"
            title={label.installed}
          >
            <IconCheck className="size-3.5" />
          </span>
        )
      }
      desc={server.summary}
      footer={
        <>
          <span className="truncate">{server.vendor}</span>
          {server.tools.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              {label.tools(server.tools.length)}
            </>
          ) : null}
        </>
      }
      icon={
        <WbIconSlot>
          <PluginLogo logo={server.logo} />
        </WbIconSlot>
      }
      onOpen={onOpen}
      title={server.title}
    />
  );
}

function CatalogueCard({
  item,
  isAdmin,
  pending,
  onInstall,
  onOpen,
  label,
}: {
  item: CatalogueItem;
  isAdmin: boolean;
  pending: boolean;
  onInstall: () => void;
  onOpen: () => void;
  label: { install: string; pending: string; contactAdmin: string };
}) {
  return (
    <ConnectorCard
      action={
        isAdmin ? (
          <WbAddButton
            installedLabel=""
            label={label.install}
            onClick={onInstall}
            pending={pending}
          />
        ) : (
          <span className="text-xs text-foreground/40">
            {label.contactAdmin}
          </span>
        )
      }
      desc={item.summary}
      footer={<span className="truncate">{item.vendor}</span>}
      icon={
        <WbIconSlot>
          <IconPlug className="size-5 text-foreground/70" />
        </WbIconSlot>
      }
      onOpen={onOpen}
      title={item.title}
    />
  );
}

function BrokerCard({
  app,
  source,
  isAdmin,
  pending,
  onInstall,
  onOpen,
  label,
}: {
  app: ComposioApp;
  source: "open-connector" | "composio";
  isAdmin: boolean;
  pending: boolean;
  onInstall: () => void;
  onOpen: () => void;
  label: {
    install: string;
    pending: string;
    installed: string;
    contactAdmin: string;
  };
}) {
  return (
    <ConnectorCard
      action={
        app.enabled ? (
          <span
            aria-label={label.installed}
            className="flex size-6 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/70"
            role="img"
            title={label.installed}
          >
            <IconCheck className="size-3.5" />
          </span>
        ) : isAdmin ? (
          <WbAddButton
            installedLabel={label.installed}
            label={label.install}
            onClick={onInstall}
            pending={pending}
          />
        ) : (
          <span className="text-xs text-foreground/40">
            {label.contactAdmin}
          </span>
        )
      }
      desc={app.description}
      footer={
        <>
          <IconLink className="size-4 shrink-0" />
          {app.actionCount > 0 ? (
            <>
              {app.actionCount}
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span className="truncate">
            {source === "open-connector" ? "OpenConnector" : "Composio"}
          </span>
        </>
      }
      icon={
        <WbIconSlot>
          {app.logo ? (
            <PluginLogo logo={app.logo} />
          ) : (
            <IconPlug className="size-5 text-foreground/70" />
          )}
        </WbIconSlot>
      }
      onOpen={onOpen}
      title={app.name}
    />
  );
}

function Section({
  title,
  count,
  chips,
  children,
}: {
  title: string;
  count?: number;
  chips?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <WbSectionTitle>
        {title}
        {count !== undefined ? (
          <span className="text-sm font-normal text-foreground/40">
            {count}
          </span>
        ) : null}
      </WbSectionTitle>
      {chips ? <div className="mt-3">{chips}</div> : null}
      <div className={chips ? "mt-4" : "mt-3"}>{children}</div>
    </section>
  );
}

export function ConnectorsPane({
  servers,
  catalogue,
  openConnectorApps,
  composioApps,
  categories,
  category,
  onCategory,
  isAdmin,
  pending,
  onInstall,
  onOpen,
}: {
  servers: PluginServer[];
  catalogue: CatalogueItem[];
  openConnectorApps: ComposioApp[];
  composioApps: ComposioApp[];
  categories: string[];
  category: string;
  onCategory: (next: string) => void;
  isAdmin: boolean;
  pending: boolean;
  onInstall: (subject: ConnectorSubject) => void;
  onOpen: (subject: ConnectorSubject) => void;
}) {
  const { t } = useTranslation("market");
  const addedServers = new Set(servers.map((server) => server.id));

  // The grid answer WB's flat page gives; the sections keep OpenBot's three sources apart because
  // an install means a different thing in each. The page container has already applied the search
  // term; what is left here is the category row over the broker directories.
  const catalogueLeft = catalogue.filter((item) => !addedServers.has(item.key));
  const openConnectorLeft = openConnectorApps
    .filter((app) => !app.enabled)
    .filter((app) => category === "all" || app.categories.includes(category));
  const composioLeft = composioApps
    .filter((app) => !app.enabled)
    .filter((app) => category === "all" || app.categories.includes(category));

  const cardLabel = {
    install: t("install"),
    pending: t("installing"),
    installed: t("installed"),
    connect: t("connect"),
    contactAdmin: t("contactAdmin"),
    tools: (n: number) => t("wb.toolsN", { count: n }),
  };

  return (
    <div className="space-y-8">
      <Section count={servers.length} title={t("wb.section.connected")}>
        {servers.length === 0 ? (
          <WbEmpty glyph="🔌" title={t("empty.connectors")} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                label={cardLabel}
                onOpen={() => onOpen({ kind: "server", server })}
                server={server}
              />
            ))}
          </div>
        )}
      </Section>

      {isAdmin ? (
        <>
          {catalogueLeft.length > 0 ? (
            <Section count={catalogueLeft.length} title={t("section.builtin")}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {catalogueLeft.map((item) => (
                  <CatalogueCard
                    isAdmin={isAdmin}
                    item={item}
                    key={item.key}
                    label={cardLabel}
                    onInstall={() => onInstall({ kind: "catalogue", item })}
                    onOpen={() => onOpen({ kind: "catalogue", item })}
                    pending={pending}
                  />
                ))}
              </div>
            </Section>
          ) : null}
          {openConnectorLeft.length > 0 ? (
            <Section
              chips={
                <WbCategoryChips
                  allLabel={t("category.all")}
                  categories={categories}
                  onChange={onCategory}
                  value={category}
                />
              }
              count={openConnectorLeft.length}
              title={t("section.openConnector")}
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {openConnectorLeft.map((app) => (
                  <BrokerCard
                    app={app}
                    isAdmin={isAdmin}
                    key={`open-connector-${app.slug}`}
                    label={cardLabel}
                    onInstall={() =>
                      onInstall({
                        kind: "broker",
                        app,
                        source: "open-connector",
                      })
                    }
                    onOpen={() =>
                      onOpen({ kind: "broker", app, source: "open-connector" })
                    }
                    pending={pending}
                    source="open-connector"
                  />
                ))}
              </div>
            </Section>
          ) : null}
          {composioLeft.length > 0 ? (
            <Section count={composioLeft.length} title={t("section.composio")}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {composioLeft.map((app) => (
                  <BrokerCard
                    app={app}
                    isAdmin={isAdmin}
                    key={`composio-${app.slug}`}
                    label={cardLabel}
                    onInstall={() =>
                      onInstall({ kind: "broker", app, source: "composio" })
                    }
                    onOpen={() =>
                      onOpen({ kind: "broker", app, source: "composio" })
                    }
                    pending={pending}
                    source="composio"
                  />
                ))}
              </div>
            </Section>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-foreground/50">
          {t("connectors.adminHint")}
        </p>
      )}
    </div>
  );
}
