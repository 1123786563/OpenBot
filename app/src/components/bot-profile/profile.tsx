import {
  IconBell,
  IconMessage,
  IconPlayerPause,
  IconRefresh,
  IconRoute,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { AbstractAvatar } from "@/components/agents/abstract-avatar";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { SharedAppNotice } from "@/components/plugins/shared-app-notice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { AgentProfile } from "@/lib/agents/queries";
import {
  resetBotMutationOptions,
  setBotNotifyMutationOptions,
  setBotPausedMutationOptions,
  setUpdateRoutingMutationOptions,
} from "@/lib/bot-lifecycle/mutations";
import {
  type BotNotify,
  botLifecycleQueryOptions,
  botResetPlanQueryOptions,
  type ResetPlan,
  type UpdateKind,
  type UpdateTransport,
  updateRoutingQueryOptions,
} from "@/lib/bot-lifecycle/queries";
import { queryClient } from "@/query-client";
import { BotActivitySections } from "./activity";
import { BotPausedBanner } from "./pause-banner";

/* Key literals stay literal (`as const satisfies`) so `t(...)` sees a known key, not `string`. */
const NOTIFY_LABEL = {
  all: "profile.notify.all",
  needs_input: "profile.notify.needsInput",
  none: "profile.notify.none",
} as const satisfies Record<BotNotify, string>;

const KIND_LABEL = {
  progress: {
    title: "profile.updateKind.progress.title",
    description: "profile.updateKind.progress.description",
  },
  decision: {
    title: "profile.updateKind.decision.title",
    description: "profile.updateKind.decision.description",
  },
  question: {
    title: "profile.updateKind.question.title",
    description: "profile.updateKind.question.description",
  },
} as const satisfies Record<UpdateKind, { title: string; description: string }>;

const TRANSPORTS = [
  { id: "push", label: "profile.transport.push" },
  { id: "slack", label: "profile.transport.slack" },
  { id: "teams", label: "profile.transport.teams" },
  { id: "sms", label: "profile.transport.sms" },
] as const satisfies readonly { id: UpdateTransport; label: string }[];

const selectClass = "h-8 rounded-md border bg-background px-2 text-sm";

/** Each count the notice lists, in the words the person reads, skipping the kinds with nothing. */
function resetLines(plan: ResetPlan) {
  const lines = [
    [plan.conversations, "profile.resetItems.conversations"],
    [plan.memorySources, "profile.resetItems.memorySources"],
    [plan.memories, "profile.resetItems.memories"],
    [plan.routines, "profile.resetItems.routines"],
    [plan.responsibilities, "profile.resetItems.responsibilities"],
    [plan.followUps, "profile.resetItems.followUps"],
    [plan.formedMemories, "profile.resetItems.formedMemories"],
    [plan.backgroundResearch, "profile.resetItems.backgroundResearch"],
    [plan.standingApprovals, "profile.resetItems.standingApprovals"],
  ] as const;
  return lines
    .filter(([count]) => count > 0)
    .map(([count, key]) => ({ count, key }));
}

function ResetDialog({
  agent,
  onOpenChange,
  open,
}: {
  agent: AgentProfile;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { t } = useTranslation("computer");
  const plan = useQuery({
    ...botResetPlanQueryOptions(agent.id),
    enabled: open,
  });
  const reset = useMutation(resetBotMutationOptions(queryClient));
  const lines = plan.data ? resetLines(plan.data) : [];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("profile.reset.title", { name: agent.name })}
          </DialogTitle>
          <DialogDescription>
            {t("profile.reset.description", { name: agent.name })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          {plan.isPending ? null : plan.error ? (
            <p className="text-destructive text-sm" role="alert">
              {t("profile.reset.countError")}
            </p>
          ) : reset.isSuccess ? (
            <p className="text-sm">
              {t("profile.reset.done", { name: agent.name })}
            </p>
          ) : (
            <div className="grid gap-2 text-sm">
              {lines.length === 0 ? (
                <p>{t("profile.reset.nothingToDelete")}</p>
              ) : (
                <>
                  <p>{t("profile.reset.willDelete")}</p>
                  <ul className="list-disc pl-5">
                    {lines.map((line) => (
                      <li key={line.key}>
                        {t(line.key, { count: line.count })}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {plan.data.sharedConversationsKept > 0 ? (
                <p className="text-muted-foreground">
                  {t("profile.reset.sharedKept", {
                    count: plan.data.sharedConversationsKept,
                  })}
                </p>
              ) : null}
              <p className="text-muted-foreground">
                {t("profile.reset.ownMemoriesKept")}
              </p>
            </div>
          )}
          {reset.error ? (
            <p className="mt-2 text-destructive text-sm" role="alert">
              {reset.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            {reset.isSuccess
              ? t("profile.reset.close")
              : t("profile.reset.cancel")}
          </Button>
          {reset.isSuccess ? null : (
            <Button
              disabled={!plan.data || lines.length === 0 || reset.isPending}
              onClick={() => reset.mutate(agent.id)}
              size="sm"
              variant="destructive"
            >
              {reset.isPending
                ? t("profile.reset.resetting")
                : t("profile.reset.deleteAndReset")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UpdateRoutingSection() {
  const { t } = useTranslation("computer");
  const routing = useQuery(updateRoutingQueryOptions());
  const save = useMutation(setUpdateRoutingMutationOptions(queryClient));
  return (
    <PageSection
      description={t("profile.routing.description")}
      title={t("profile.routing.title")}
    >
      {routing.isPending ? null : routing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("profile.routing.loadError")}
        </p>
      ) : (
        <PageRows>
          {(Object.keys(KIND_LABEL) as UpdateKind[]).map((kind, index) => {
            const current = routing.data[kind];
            const allowed = (transport: UpdateTransport) =>
              current === "all" || current.includes(transport);
            return (
              <Fragment key={kind}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRoute />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{t(KIND_LABEL[kind].title)}</ItemTitle>
                    <ItemDescription>
                      {t(KIND_LABEL[kind].description)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemFooter className="gap-4 pl-8">
                    {TRANSPORTS.map((transport) => (
                      <div
                        className="flex items-center gap-2 text-sm"
                        key={transport.id}
                      >
                        <Switch
                          aria-label={t("profile.transportAria", {
                            kind: t(KIND_LABEL[kind].title),
                            transport: t(transport.label),
                          })}
                          checked={allowed(transport.id)}
                          disabled={save.isPending}
                          onCheckedChange={(checked) => {
                            const next = TRANSPORTS.map((t) => t.id).filter(
                              (id) =>
                                id === transport.id ? checked : allowed(id),
                            );
                            save.mutate({
                              kind,
                              transports:
                                next.length === TRANSPORTS.length
                                  ? "all"
                                  : next,
                            });
                          }}
                          size="sm"
                        />
                        {t(transport.label)}
                      </div>
                    ))}
                  </ItemFooter>
                </Item>
              </Fragment>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

/** A Bot's own page: its state for you, what it is doing, and the lifecycle controls. */
export function BotProfile({ agent }: { agent: AgentProfile }) {
  const { t } = useTranslation("computer");
  const lifecycle = useQuery(botLifecycleQueryOptions(agent.id));
  const pause = useMutation(setBotPausedMutationOptions(queryClient));
  const notify = useMutation(setBotNotifyMutationOptions(queryClient));
  const [resetOpen, setResetOpen] = useState(false);
  const [permission, setPermission] = useState<string>(() => {
    try {
      return typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission;
    } catch {
      return "unsupported";
    }
  });

  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <AbstractAvatar name={agent.name} seed={agent.avatarSeed} size={40} />
        <div className="min-w-0">
          <p className="truncate font-medium">{agent.title}</p>
          <p className="line-clamp-2 text-muted-foreground text-sm">
            {agent.roleDescription}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <BotPausedBanner agentId={agent.id} />
      </div>

      <PageSection title={t("profile.forYou")}>
        {agent.canManage ? (
          <SharedAppNotice botId={agent.id} reason="publish" />
        ) : null}
        {lifecycle.isPending ? null : lifecycle.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("profile.stateLoadError")}
          </p>
        ) : (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPlayerPause />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("profile.paused.title")}</ItemTitle>
                <ItemDescription>
                  {lifecycle.data.paused
                    ? t("profile.paused.on")
                    : t("profile.paused.off")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={t("profile.paused.title")}
                  checked={lifecycle.data.paused}
                  disabled={pause.isPending}
                  onCheckedChange={(paused) =>
                    pause.mutate({ agentId: agent.id, paused })
                  }
                />
              </ItemActions>
            </Item>
            <Separator />
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBell />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("profile.notifications.title")}</ItemTitle>
                <ItemDescription>
                  {t(NOTIFY_LABEL[lifecycle.data.notify])}.{" "}
                  {t("profile.notifications.badgesAlways")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <select
                  aria-label={t("profile.notifications.title")}
                  className={selectClass}
                  disabled={notify.isPending}
                  onChange={(event) =>
                    notify.mutate({
                      agentId: agent.id,
                      notify: event.target.value as BotNotify,
                    })
                  }
                  value={lifecycle.data.notify}
                >
                  {(Object.keys(NOTIFY_LABEL) as BotNotify[]).map((value) => (
                    <option key={value} value={value}>
                      {t(NOTIFY_LABEL[value])}
                    </option>
                  ))}
                </select>
              </ItemActions>
            </Item>
            {permission === "default" ? (
              <>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBell />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {t("profile.browserNotifications.title")}
                    </ItemTitle>
                    <ItemDescription>
                      {t("profile.browserNotifications.off")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={async () => {
                        try {
                          setPermission(await Notification.requestPermission());
                        } catch {
                          setPermission("unsupported");
                        }
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {t("profile.browserNotifications.turnOn")}
                    </Button>
                  </ItemActions>
                </Item>
              </>
            ) : null}
            <Separator />
            <Item
              render={<Link to="/channel/new" search={{ agent: agent.id }} />}
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconMessage />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {t("profile.message.title", { name: agent.name })}
                </ItemTitle>
                <ItemDescription>
                  {t("profile.message.description")}
                </ItemDescription>
              </ItemContent>
            </Item>
            <Separator />
            <Item
              render={
                <button onClick={() => setResetOpen(true)} type="button" />
              }
              size="sm"
            >
              <ItemMedia variant="icon">
                <IconRefresh />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("profile.resetEntry.title")}</ItemTitle>
                <ItemDescription>
                  {t("profile.resetEntry.description")}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        )}
      </PageSection>

      <BotActivitySections agentId={agent.id} />
      <UpdateRoutingSection />
      <ResetDialog agent={agent} onOpenChange={setResetOpen} open={resetOpen} />
    </>
  );
}
