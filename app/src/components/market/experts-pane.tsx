import {
  IconCheck,
  IconChevronRight,
  IconMessage,
  IconPlus,
  IconSparkles,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import {
  WbCard,
  WbCategoryChips,
  WbDesc,
  WbEmpty,
  WbIconSlot,
  WbIdRow,
  WbName,
  WbPrimaryButton,
  WbQuoteRow,
  WbSectionTitle,
  WbStatsRow,
  WbTag,
} from "@/components/market/wb";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { AgentProfile } from "@/lib/agents/queries";
import type { MarketExpert } from "@/lib/marketplace/queries";
import { cn } from "@/lib/utils";

/**
 * The 专家 shelf, laid out the way the WorkBuddy client draws its expert marketplace: a featured
 * scenario rail on top, the visitor's own experts as a card row, and the template centre below.
 *
 * THE MAPPING IT PRESENTS: an OpenBot Agent IS a WorkBuddy expert. The 「我的专家」 row renders the
 * signed-in person's agents with WorkBuddy's expert-card anatomy, and its dialog is WorkBuddy's
 * expert dialog with the agent's own fields in each slot. The marketplace templates sit below
 * because installing one is how a new agent is born.
 */

/** Soft header gradients rotating across scenario cards, in WorkBuddy's lavender/sage/blue/peach. */
const SCENE_STYLES = [
  "from-[#efe9ff] to-[#d9ccf7]",
  "from-[#e2f4e8] to-[#bfe6cb]",
  "from-[#e3eeff] to-[#c2d9fb]",
  "from-[#ffefe0] to-[#fcd9b8]",
];
const SCENE_GLYPHS = ["🎓", "✍️", "📊", "⚖️", "🛍️", "📈", "🧩", "🗂️", "🎨", "💻"];

function SceneCard({
  title,
  experts,
  onOpen,
  index,
}: {
  title: string;
  experts: MarketExpert[];
  onOpen: (expert: MarketExpert) => void;
  index: number;
}) {
  return (
    <div className="w-[340px] shrink-0 overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      <div
        className={cn(
          "relative flex h-24 items-end bg-gradient-to-r p-4",
          SCENE_STYLES[index % SCENE_STYLES.length],
        )}
      >
        <span aria-hidden="true" className="absolute right-4 bottom-3 text-4xl">
          {SCENE_GLYPHS[index % SCENE_GLYPHS.length]}
        </span>
        <span className="text-base font-medium text-foreground">{title}</span>
      </div>
      <div className="py-2">
        {experts.slice(0, 3).map((expert) => (
          <button
            className="flex w-full items-center justify-between px-5 py-2 text-left text-sm text-foreground/80 transition-colors hover:bg-foreground/[0.03] hover:text-foreground"
            key={expert.slug}
            onClick={() => onOpen(expert)}
            type="button"
          >
            <span className="truncate">{expert.name}</span>
            <IconChevronRight className="size-4 shrink-0 text-foreground/30" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** The card body shared by my-agents cards and template cards. */
function ExpertCardBody({
  icon,
  name,
  desc,
  tags,
  footer,
  action,
}: {
  icon: React.ReactNode;
  name: string;
  desc: string;
  tags: React.ReactNode;
  footer?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <WbName>{name}</WbName>
          <div className="mt-0.5">
            <WbDesc>{desc}</WbDesc>
          </div>
        </div>
        {action}
      </div>
      <div className="flex flex-wrap gap-1.5">{tags}</div>
      {footer ? (
        <div className="mt-auto flex items-center gap-1.5 text-sm text-foreground/50">
          {footer}
        </div>
      ) : null}
    </>
  );
}

export function AgentCardWb({
  agent,
  onOpen,
  className,
}: {
  agent: AgentProfile;
  onOpen: (agent: AgentProfile) => void;
  className?: string;
}) {
  const { t } = useTranslation("market");
  return (
    <WbCard
      aria-label={agent.name}
      className={cn("w-full", className)}
      interactive
      onClick={() => onOpen(agent)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(agent);
        }
      }}
    >
      <ExpertCardBody
        desc={agent.roleDescription || agent.title}
        footer={
          agent.title ? <span className="truncate">{agent.title}</span> : null
        }
        icon={
          <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={48} />
        }
        name={agent.name}
        tags={
          <>
            {agent.systemOwned ? <WbTag>{t("wb.badge.system")}</WbTag> : null}
            {agent.assignedToMe ? <WbTag>{t("wb.badge.team")}</WbTag> : null}
            <WbTag>
              {agent.visibility === "public"
                ? t("wb.stats.public")
                : t("wb.stats.private")}
            </WbTag>
          </>
        }
      />
    </WbCard>
  );
}

function TemplateCard({
  expert,
  pending,
  onInstall,
  onOpen,
  label,
}: {
  expert: MarketExpert;
  pending: boolean;
  onInstall: () => void;
  onOpen: (expert: MarketExpert) => void;
  label: {
    install: string;
    pending: string;
    installed: string;
    skills: (n: number) => string;
  };
}) {
  return (
    <WbCard
      className="w-full"
      interactive
      onClick={() => onOpen(expert)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(expert);
        }
      }}
    >
      <ExpertCardBody
        action={
          expert.installed ? (
            <span
              aria-label={label.installed}
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/70"
              role="img"
              title={label.installed}
            >
              <IconCheck className="size-3.5" />
            </span>
          ) : (
            <button
              aria-label={pending ? label.pending : label.install}
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground transition-colors hover:bg-foreground/[0.12]"
              onClick={(event) => {
                event.stopPropagation();
                onInstall();
              }}
              title={pending ? label.pending : label.install}
              type="button"
            >
              {pending ? (
                <span className="size-3.5 animate-spin rounded-full border border-foreground/30 border-t-foreground" />
              ) : (
                <IconPlus className="size-3.5" />
              )}
            </button>
          )
        }
        desc={expert.tagline || expert.description}
        footer={
          expert.skills.length > 0 ? (
            <>
              <IconSparkles className="size-4" />
              {label.skills(expert.skills.length)}
            </>
          ) : null
        }
        icon={<WbIconSlot>{expert.avatar}</WbIconSlot>}
        name={expert.name}
        tags={
          <>
            {expert.tags.slice(0, 2).map((tag) => (
              <WbTag key={tag}>{tag}</WbTag>
            ))}
            <WbTag>{expert.category}</WbTag>
          </>
        }
      />
    </WbCard>
  );
}

/** WorkBuddy's expert dialog, carrying an OpenBot agent's fields. */
export function AgentDialogWb({
  agent,
  onClose,
}: {
  agent: AgentProfile | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("market");
  if (!agent) return null;
  const kind = agent.systemOwned
    ? t("wb.stats.kindSystem")
    : agent.assignedToMe
      ? t("wb.stats.kindTeam")
      : agent.mine
        ? t("wb.stats.kindMine")
        : t("wb.stats.kindShared");
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!agent}>
      <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={48} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-xl leading-7 font-semibold text-foreground">
                {agent.name}
              </span>
              {agent.title ? (
                <span className="truncate text-base text-foreground/40">
                  {agent.title}
                </span>
              ) : null}
            </div>
            <div className="mt-2.5">
              <Button
                render={(props) => (
                  <Link {...props} search={{ agent: agent.id }} to="/agents" />
                )}
                size="sm"
                className="h-8 rounded-lg px-4"
              >
                <IconMessage className="size-4" />
                {t("wb.summon")}
              </Button>
            </div>
          </div>
        </div>
        {agent.roleDescription ? (
          <p className="mt-4 text-sm leading-relaxed text-foreground/80">
            {agent.roleDescription}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <WbTag>
            {agent.visibility === "public"
              ? t("wb.stats.public")
              : t("wb.stats.private")}
          </WbTag>
          {agent.systemOwned ? <WbTag>{t("wb.badge.system")}</WbTag> : null}
          {agent.assignedToMe ? <WbTag>{t("wb.badge.team")}</WbTag> : null}
          {agent.pinned ? <WbTag>{t("wb.badge.pinned")}</WbTag> : null}
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <WbStatsRow
            stats={[
              {
                value:
                  agent.visibility === "public"
                    ? t("wb.stats.public")
                    : t("wb.stats.private"),
                label: t("wb.stats.visibility"),
              },
              {
                value: agent.builtIn
                  ? t("wb.stats.builtin")
                  : t("wb.stats.selfHosted"),
                label: t("wb.stats.runsOn"),
              },
              { value: kind, label: t("wb.stats.kind") },
            ]}
          />
        </div>
        <p className="mt-5 flex items-center gap-1.5 text-base font-medium text-foreground">
          <IconSparkles className="size-4 text-foreground/60" />
          {t("wb.helpTitle")}
        </p>
        <div className="mt-3 space-y-2.5">
          <WbQuoteRow>{t("wb.helpHint")}</WbQuoteRow>
        </div>
        <div className="mt-5">
          <WbIdRow id={agent.id} label="ID:" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** WorkBuddy's expert dialog, carrying a marketplace template's fields. */
export function TemplateDialogWb({
  expert,
  pending,
  onInstall,
  onClose,
  label,
}: {
  expert: MarketExpert | null;
  pending: boolean;
  onInstall: (expert: MarketExpert) => void;
  onClose: () => void;
  label: {
    install: string;
    installing: string;
    installed: string;
    chat: string;
    uninstall: string;
  };
}) {
  const { t } = useTranslation("market");
  if (!expert) return null;
  const canChat = expert.installed && expert.agentId;
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!expert}>
      <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <WbIconSlot>{expert.avatar}</WbIconSlot>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-xl leading-7 font-semibold text-foreground">
                {expert.name}
              </span>
              <span className="text-base text-foreground/40">
                {t("wb.sourceMarket")}
              </span>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              {canChat ? (
                <Button
                  render={(props) => (
                    <Link
                      {...props}
                      search={{ agent: expert.agentId ?? undefined }}
                      to="/agents"
                    />
                  )}
                  size="sm"
                  className="h-8 rounded-lg px-4"
                >
                  <IconMessage className="size-4" />
                  {t("wb.summon")}
                </Button>
              ) : (
                <WbPrimaryButton
                  className="h-8 px-4"
                  disabled={pending}
                  onClick={() => onInstall(expert)}
                >
                  {pending
                    ? label.installing
                    : expert.installed
                      ? label.installed
                      : label.install}
                </WbPrimaryButton>
              )}
              {expert.installed && !canChat ? (
                <Button
                  disabled={pending}
                  onClick={() => onInstall(expert)}
                  size="sm"
                  variant="ghost"
                >
                  {label.uninstall}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-foreground/80">
          {expert.description}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {expert.tags.map((tag) => (
            <WbTag key={tag}>{tag}</WbTag>
          ))}
          <WbTag>{expert.category}</WbTag>
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <WbStatsRow
            stats={[
              { value: expert.category, label: t("wb.stats.category") },
              { value: expert.skills.length, label: t("wb.stats.skillsCount") },
              {
                value: expert.installed
                  ? t("installed")
                  : t("wb.stats.notInstalled"),
                label: t("wb.stats.status"),
              },
            ]}
          />
        </div>
        {expert.skills.length > 0 ? (
          <>
            <p className="mt-5 flex items-center gap-1.5 text-base font-medium text-foreground">
              <IconSparkles className="size-4 text-foreground/60" />
              {t("wb.skillsTitle")}
            </p>
            <div className="mt-3 space-y-2.5">
              {expert.skills.map((skill) => (
                <WbQuoteRow key={skill}>{skill}</WbQuoteRow>
              ))}
            </div>
          </>
        ) : null}
        <div className="mt-5">
          <WbIdRow id={expert.slug} label="ID:" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ExpertsPane({
  agents,
  experts,
  categories,
  category,
  onCategory,
  pendingInstall,
  onInstall,
  onUninstall,
  onOpenAgent,
  onOpenTemplate,
  onOpenMine,
  searching,
}: {
  agents: AgentProfile[];
  experts: MarketExpert[];
  categories: string[];
  category: string;
  onCategory: (next: string) => void;
  pendingInstall: boolean;
  onInstall: (slug: string) => void;
  onUninstall: (slug: string) => void;
  onOpenAgent: (agent: AgentProfile) => void;
  onOpenTemplate: (expert: MarketExpert) => void;
  onOpenMine: () => void;
  searching: boolean;
}) {
  const { t } = useTranslation("market");
  // Featured scenarios: the template categories that actually have entries, capped like
  // WorkBuddy's rail so the row stays scannable.
  const scenes = categories
    .map((name) => ({
      name,
      members: experts.filter((expert) => expert.category === name),
    }))
    .filter((scene) => scene.members.length > 0)
    .slice(0, 6);

  const filtered =
    category === "all"
      ? experts
      : experts.filter((expert) => expert.category === category);

  return (
    <div className="space-y-8">
      {scenes.length > 0 && !searching ? (
        <section>
          <WbSectionTitle>{t("wb.featured")}</WbSectionTitle>
          <div className="mt-3 flex gap-4 overflow-x-auto pb-1">
            {scenes.map((scene, index) => (
              <SceneCard
                experts={scene.members}
                index={index}
                key={scene.name}
                onOpen={onOpenTemplate}
                title={scene.name}
              />
            ))}
          </div>
        </section>
      ) : null}

      {agents.length > 0 && !searching ? (
        <section>
          <WbSectionTitle
            action={
              <button
                className="text-sm text-foreground/50 transition-colors hover:text-foreground"
                onClick={onOpenMine}
                type="button"
              >
                {t("wb.viewAll")}
              </button>
            }
          >
            {t("wb.myExperts")}
          </WbSectionTitle>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {agents.slice(0, 6).map((agent) => (
              <AgentCardWb agent={agent} key={agent.id} onOpen={onOpenAgent} />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <WbSectionTitle>{t("wb.expertCenter")}</WbSectionTitle>
        <div className="mt-3">
          <WbCategoryChips
            allLabel={t("category.all")}
            categories={categories}
            onChange={onCategory}
            value={category}
          />
        </div>
        {filtered.length === 0 ? (
          <WbEmpty glyph="🧭" title={t("empty.experts")} />
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((expert) => (
              <TemplateCard
                expert={expert}
                key={expert.slug}
                label={{
                  install: t("install"),
                  pending: t("installing"),
                  installed: t("installed"),
                  skills: (n) => t("wb.skillsCountN", { count: n }),
                }}
                onInstall={() =>
                  expert.installed
                    ? onUninstall(expert.slug)
                    : onInstall(expert.slug)
                }
                onOpen={onOpenTemplate}
                pending={pendingInstall}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
