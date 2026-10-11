import { IconArrowLeft, IconPlus, IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import * as React from "react";
import { AgentCardWb } from "@/components/market/experts-pane";
import {
  WbEmpty,
  WbPrimaryLink,
  WbSegmentTabs,
} from "@/components/market/wb";
import type { AgentProfile } from "@/lib/agents/queries";
import { isSharedWithYou } from "@/lib/agents/queries";

/**
 * WorkBuddy's 「我的专家」 sub-page, carrying OpenBot's agents.
 *
 * Its two rosters map directly: 我创建的 agents are WB's 专家 (mine), and agents shared with you
 * are WB's 专家团 — a collective somebody else published. Same anatomy as WB: a back arrow over
 * count tabs and a 我创建的/共享给我的 segment, a search box and a create verb on the right, the
 * expert-card grid below, and the centered glyph empty state when a roster is genuinely empty.
 */
export function MyExpertsView({
  agents,
  onBack,
  onOpenAgent,
}: {
  agents: AgentProfile[];
  onBack: () => void;
  onOpenAgent: (agent: AgentProfile) => void;
}) {
  const { t } = useTranslation("market");
  const [roster, setRoster] = React.useState<"mine" | "shared">("mine");
  const [term, setTerm] = React.useState("");

  const needle = term.trim().toLowerCase();
  const matches = (agent: AgentProfile) =>
    needle.length === 0 ||
    [agent.name, agent.title, agent.roleDescription].some((field) =>
      (field ?? "").toLowerCase().includes(needle),
    );

  const mine = agents.filter((agent) => agent.mine && matches(agent));
  const shared = agents.filter((agent) => isSharedWithYou(agent) && matches(agent));
  const list = roster === "mine" ? mine : shared;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          aria-label={t("wb.backToList")}
          className="-ml-2 flex size-8 items-center justify-center rounded-lg text-foreground transition-colors hover:bg-foreground/[0.04]"
          onClick={onBack}
          type="button"
        >
          <IconArrowLeft className="size-5" />
        </button>
        <h1 className="text-xl leading-7 font-semibold text-foreground">{t("wb.myExperts")}</h1>
        <div className="relative ml-auto">
          <IconSearch className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-foreground/40" />
          <input
            aria-label={t("wb.searchMine")}
            className="h-9 w-56 rounded-lg border border-transparent bg-foreground/[0.04] pl-8 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-foreground/40 focus-visible:border-foreground/20 focus-visible:bg-card"
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t("wb.searchMine")}
            value={term}
          />
        </div>
        <WbPrimaryLink search={{ new: true }} to="/agents">
          <IconPlus className="size-4" />
          {t("wb.createExpert")}
        </WbPrimaryLink>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <WbSegmentTabs<"mine" | "shared">
          onChange={setRoster}
          tabs={[
            { key: "mine", label: t("wb.countExperts"), count: mine.length },
            { key: "shared", label: t("wb.countTeams"), count: shared.length },
          ]}
          value={roster}
        />
        <WbSegmentTabs<"mine" | "shared">
          onChange={setRoster}
          tabs={[
            { key: "mine", label: t("wb.segmentMine") },
            { key: "shared", label: t("wb.segmentShared") },
          ]}
          value={roster}
        />
      </div>

      {list.length === 0 ? (
        roster === "mine" ? (
          <WbEmpty
            glyph="😴"
            hint={t("wb.empty.mineHint")}
            title={t("wb.empty.mine")}
            action={
              <WbPrimaryLink search={{ new: true }} to="/agents">
                <IconPlus className="size-4" />
                {t("wb.createExpert")}
              </WbPrimaryLink>
            }
          />
        ) : (
          <WbEmpty glyph="👥" title={t("wb.empty.shared")} />
        )
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((agent) => (
            <AgentCardWb agent={agent} key={agent.id} onOpen={onOpenAgent} />
          ))}
        </div>
      )}
    </div>
  );
}
