import { IconBolt, IconRefresh } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
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
  WbQuoteRow,
  WbSectionTitle,
  WbSegmentTabs,
  WbStatsRow,
  WbTag,
} from "@/components/market/wb";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { MarketSkill } from "@/lib/marketplace/queries";
import type { PluginSkill } from "@/lib/plugins/queries";

/**
 * The 技能 shelf in WorkBuddy's skills-market layout: a featured pair of wide cards with a
 * shuffle control, then the three shelves a skill can live on — the marketplace catalogue, the
 * person's own, and what the deployment provides — as text sub-tabs over a category chip row and
 * a two-column card grid.
 *
 * THE MAPPING IT PRESENTS: an OpenBot skill IS a WorkBuddy skill. Each card keeps the fields the
 * rest of the app already shows (/slug, summary, category, grant count) and each dialog is
 * WorkBuddy's skill dialog with those same fields.
 */

type Shelf = "market" | "mine" | "deployment";

export type SkillSubject =
  | { kind: "market"; skill: MarketSkill }
  | { kind: "mine" | "deployment"; skill: PluginSkill };

function SkillCard({
  skill,
  onOpen,
  action,
  footer,
}: {
  skill: {
    slug: string;
    title: string;
    summary: string;
    icon?: string | null;
    category?: string | null;
  };
  onOpen: () => void;
  action?: React.ReactNode;
  footer?: React.ReactNode;
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
        <WbIconSlot>{skill.icon || "🧩"}</WbIconSlot>
        <div className="min-w-0 flex-1 pr-8">
          <WbName>{skill.title}</WbName>
          <div className="mt-0.5">
            <WbDesc>{skill.summary || `/${skill.slug}`}</WbDesc>
          </div>
        </div>
        {action ? <div className="absolute top-0 right-0">{action}</div> : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <WbTag>
          <code className="font-mono text-foreground/60">/{skill.slug}</code>
        </WbTag>
        {skill.category ? <WbTag>{skill.category}</WbTag> : null}
      </div>
      {footer ? (
        <div className="mt-auto flex items-center gap-1.5 text-sm text-foreground/50">
          {footer}
        </div>
      ) : null}
    </WbCard>
  );
}

export function SkillDialogWb({
  subject,
  pendingInstall,
  onInstall,
  onClose,
  label,
}: {
  subject: SkillSubject | null;
  pendingInstall: boolean;
  onInstall: (slug: string) => void;
  onClose: () => void;
  label: { install: string; installing: string; installed: string };
}) {
  const { t } = useTranslation("market");
  if (!subject) return null;
  const { skill, kind } = subject;
  const source =
    kind === "market"
      ? t("wb.sourceMarket")
      : kind === "mine"
        ? t("wb.segment.mineSkills")
        : t("wb.segment.deployment");
  const icon = skill.icon ?? "";
  const category = skill.category ?? "";
  const granted = kind === "market" ? 0 : skill.grantedTo.length;
  const tools = kind === "market" ? 0 : skill.tools.length;
  const installed = kind === "market" ? skill.installed : true;
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!subject}>
      <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <WbIconSlot>{icon || "🧩"}</WbIconSlot>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-xl leading-7 font-semibold text-foreground">
                {skill.title}
              </span>
              <span className="text-base text-foreground/40">{source}</span>
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              {kind === "market" ? (
                installed ? (
                  <WbPrimaryButton className="h-8 px-4" disabled>
                    {label.installed}
                  </WbPrimaryButton>
                ) : (
                  <WbPrimaryButton
                    className="h-8 px-4"
                    disabled={pendingInstall}
                    onClick={() => onInstall(skill.slug)}
                  >
                    {pendingInstall ? label.installing : label.install}
                  </WbPrimaryButton>
                )
              ) : kind === "mine" ? (
                <Button
                  onClick={(event) => event.stopPropagation()}
                  render={(props) => (
                    <Link
                      {...props}
                      search={{ edit: skill.slug }}
                      to="/skills"
                    />
                  )}
                  size="sm"
                  variant="outline"
                  className="h-8 rounded-lg px-4"
                >
                  {t("wb.edit")}
                </Button>
              ) : null}
              <WbTag>
                <code className="font-mono text-foreground/60">
                  /{skill.slug}
                </code>
              </WbTag>
            </div>
          </div>
        </div>
        {skill.summary ? (
          <p className="mt-4 text-sm leading-relaxed text-foreground/80">
            {skill.summary}
          </p>
        ) : null}
        {category ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <WbTag>{category}</WbTag>
          </div>
        ) : null}
        {kind !== "market" ? (
          <>
            <div className="mt-5 border-t border-border pt-5">
              <WbStatsRow
                stats={[
                  { value: granted, label: t("wb.stats.grantedBots") },
                  { value: tools, label: t("wb.stats.tools") },
                  { value: category || "—", label: t("wb.stats.category") },
                ]}
              />
            </div>
            {skill.instructions ? (
              <>
                <p className="mt-5 flex items-center gap-1.5 text-base font-medium text-foreground">
                  <IconBolt className="size-4 text-foreground/60" />
                  {t("wb.instructionsTitle")}
                </p>
                <div className="mt-3">
                  <WbQuoteRow>
                    <span className="line-clamp-6 whitespace-pre-wrap">
                      {skill.instructions}
                    </span>
                  </WbQuoteRow>
                </div>
              </>
            ) : null}
            <div className="mt-5">
              <WbIdRow id={skill.id} label="ID:" />
            </div>
          </>
        ) : (
          <div className="mt-5">
            <WbIdRow id={skill.slug} label="ID:" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SkillsPane({
  marketSkills,
  mineSkills,
  deploymentSkills,
  categories,
  category,
  onCategory,
  pendingInstall,
  onToggle,
  onOpen,
  searching,
}: {
  marketSkills: MarketSkill[];
  mineSkills: PluginSkill[];
  deploymentSkills: PluginSkill[];
  categories: string[];
  category: string;
  onCategory: (next: string) => void;
  pendingInstall: boolean;
  /** Install, or uninstall when the caller already holds it (`mine`). */
  onToggle: (skill: MarketSkill) => void;
  onOpen: (subject: SkillSubject) => void;
  searching: boolean;
}) {
  const { t } = useTranslation("market");
  const [shelf, setShelf] = React.useState<Shelf>("market");
  // WorkBuddy's 换一批 walks a 4-wide window through the catalogue and wraps.
  const [offset, setOffset] = React.useState(0);
  const featuredCount = 4;
  const featured =
    marketSkills.length > 0
      ? Array.from(
          { length: Math.min(featuredCount, marketSkills.length) },
          (_, i) => marketSkills[(offset + i) % marketSkills.length],
        )
      : [];

  const marketCardAction = (skill: MarketSkill) =>
    skill.installed && !skill.mine ? (
      <WbAddButton installed installedLabel={t("installed")} label="" />
    ) : (
      <WbAddButton
        installedLabel={t("installed")}
        label={skill.installed ? t("uninstall") : t("install")}
        onClick={() => onToggle(skill)}
        pending={pendingInstall}
      />
    );

  const cardFooter = (installed: boolean) =>
    installed ? <span>{t("installed")}</span> : null;

  return (
    <div className="space-y-8">
      <WbSegmentTabs<Shelf>
        onChange={(next) => {
          setShelf(next);
          onCategory("all");
        }}
        tabs={[
          { key: "market", label: t("wb.segment.market") },
          {
            key: "mine",
            label: t("wb.segment.mineSkills"),
            count: mineSkills.length,
          },
          {
            key: "deployment",
            label: t("wb.segment.deployment"),
            count: deploymentSkills.length,
          },
        ]}
        value={shelf}
      />

      {shelf === "market" ? (
        <>
          {featured.length > 0 && !searching ? (
            <section>
              <WbSectionTitle
                action={
                  <button
                    className="flex items-center gap-1 text-sm text-foreground/50 transition-colors hover:text-foreground"
                    onClick={() =>
                      setOffset(
                        (held) => (held + featuredCount) % marketSkills.length,
                      )
                    }
                    type="button"
                  >
                    <IconRefresh className="size-4" />
                    {t("wb.shuffle")}
                  </button>
                }
              >
                {t("wb.featuredSkills")}
              </WbSectionTitle>
              <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
                {featured.map((skill) => (
                  <SkillCard
                    action={marketCardAction(skill)}
                    footer={cardFooter(skill.installed)}
                    key={skill.slug}
                    onOpen={() => onOpen({ kind: "market", skill })}
                    skill={skill}
                  />
                ))}
              </div>
            </section>
          ) : null}
          <WbCategoryChips
            allLabel={t("category.all")}
            categories={categories}
            onChange={onCategory}
            value={category}
          />
          {(() => {
            const filtered =
              category === "all"
                ? marketSkills
                : marketSkills.filter((skill) => skill.category === category);
            if (filtered.length === 0)
              return <WbEmpty glyph="🧩" title={t("empty.skills")} />;
            return (
              <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                {filtered.map((skill) => (
                  <SkillCard
                    action={marketCardAction(skill)}
                    footer={cardFooter(skill.installed)}
                    key={skill.slug}
                    onOpen={() => onOpen({ kind: "market", skill })}
                    skill={skill}
                  />
                ))}
              </div>
            );
          })()}
        </>
      ) : null}

      {shelf === "mine" ? (
        mineSkills.length === 0 ? (
          <WbEmpty
            glyph="🛠️"
            hint={t("wb.empty.mineHint")}
            title={t("wb.empty.skillsMine")}
            action={
              <Button
                render={(props) => (
                  <Link {...props} search={{ new: true }} to="/skills" />
                )}
                size="sm"
              >
                {t("wb.addSkill")}
              </Button>
            }
          />
        ) : (
          <div className="mt-1 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {mineSkills.map((skill) => (
              <SkillCard
                action={
                  <Button
                    onClick={(event) => event.stopPropagation()}
                    render={(props) => (
                      <Link
                        {...props}
                        search={{ edit: skill.slug }}
                        to="/skills"
                      />
                    )}
                    size="xs"
                    variant="ghost"
                  >
                    {t("wb.edit")}
                  </Button>
                }
                footer={
                  <>
                    <IconBolt className="size-4" />
                    {t("wb.grantedN", { count: skill.grantedTo.length })}
                  </>
                }
                key={skill.id}
                onOpen={() => onOpen({ kind: "mine", skill })}
                skill={skill}
              />
            ))}
          </div>
        )
      ) : null}

      {shelf === "deployment" ? (
        deploymentSkills.length === 0 ? (
          <WbEmpty glyph="🏢" title={t("wb.empty.skillsDeployment")} />
        ) : (
          <div className="mt-1 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {deploymentSkills.map((skill) => (
              <SkillCard
                footer={
                  <>
                    <IconBolt className="size-4" />
                    {t("wb.grantedN", { count: skill.grantedTo.length })}
                  </>
                }
                key={skill.id}
                onOpen={() => onOpen({ kind: "deployment", skill })}
                skill={skill}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
