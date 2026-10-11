import {
  IconChartBar,
  IconChevronRight,
  IconDeviceDesktop,
  IconFingerprint,
  IconKey,
  IconNetwork,
  IconPlug,
  IconShieldLock,
  IconTerminal2,
  IconToggleRight,
  IconUsersGroup,
  IconWorld,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { TableSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  removeNetworkPolicyMutationOptions,
  setCapabilityMutationOptions,
  setEnterpriseSettingMutationOptions,
  setNetworkPolicyMutationOptions,
  terminateInactiveComputersMutationOptions,
} from "@/lib/enterprise/mutations";
import {
  actionRecordsQueryOptions,
  type CapabilitySetting,
  type EgressRule,
  type EnterpriseOverview,
  enterpriseOverviewQueryOptions,
  modelUsageQueryOptions,
  type NetworkMode,
  type NetworkPolicy,
} from "@/lib/enterprise/queries";
import { useDateTime } from "@/lib/i18n/datetime";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/enterprise")({
  component: EnterprisePage,
});

const MODE_NAMES = {
  allow_all: "enterprise.network.modes.allowAll",
  defaults_plus_allowlist: "enterprise.network.modes.defaultsPlusAllowlist",
  allowlist_only: "enterprise.network.modes.allowlistOnly",
} as const satisfies Record<NetworkMode, string>;

/** One rule per line: `example.com`, `*.corp.example`, or `10.0.0.0/8 443,8443`. */
function rulesFromText(text: string): EgressRule[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [value = "", ports] = line.split(/\s+/, 2);
      return /^[\d.:a-fA-F]+(\/\d+)?$/.test(value) &&
        /[\d]/.test(value) &&
        /[.:]/.test(value)
        ? { type: "cidr" as const, value, ...(ports ? { ports } : {}) }
        : { type: "domain" as const, value };
    });
}

function rulesToText(rules: EgressRule[]): string {
  return rules
    .map((rule) =>
      rule.type === "domain"
        ? rule.value
        : `${rule.value}${rule.ports ? ` ${rule.ports}` : ""}`,
    )
    .join("\n");
}

function summarizePolicy(
  policy: NetworkPolicy | undefined,
  t: TFunction<"admin">,
): string {
  if (!policy) return t("enterprise.network.noPolicy");
  return `${t(MODE_NAMES[policy.mode])} · ${t("enterprise.network.ruleCount", {
    count: policy.rules.length,
  })}${policy.locked ? ` · ${t("enterprise.network.locked")}` : ""}`;
}

function EnterprisePage() {
  const { t } = useTranslation("admin");
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const setSetting = useMutation(
    setEnterpriseSettingMutationOptions(queryClient),
  );
  const failure = setCapability.error ?? setSetting.error;

  return (
    <PageShell
      description={t("enterprise.description")}
      title={t("enterprise.title")}
    >
      {failure ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {failure.message}
        </p>
      ) : null}
      {overview.isPending ? (
        <TableSkeleton />
      ) : overview.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {t("enterprise.loadError")}
        </p>
      ) : (
        <EnterpriseSections
          data={overview.data}
          onCapability={(capability, allowed) =>
            setCapability.mutate({
              scopeKind: "organization",
              scopeId: "",
              capability,
              allowed,
            })
          }
          onSetting={(key, value) => setSetting.mutate({ key, value })}
          saving={setCapability.isPending || setSetting.isPending}
        />
      )}
    </PageShell>
  );
}

function EnterpriseSections({
  data,
  onCapability,
  onSetting,
  saving,
}: {
  data: EnterpriseOverview;
  onCapability: (
    capability: CapabilitySetting["capability"],
    allowed: boolean,
  ) => void;
  onSetting: (
    key: keyof EnterpriseOverview["settings"],
    value: unknown,
  ) => void;
  saving: boolean;
}) {
  const { t } = useTranslation("admin");
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [networkScope, setNetworkScope] = useState<
    { scopeKind: "organization" | "group"; scopeId: string } | undefined
  >();
  const [modelsOpen, setModelsOpen] = useState(false);
  const [daysOpen, setDaysOpen] = useState(false);
  const { settings } = data;
  const overrideCount = data.capabilities.reduce(
    (count, capability) =>
      count +
      Object.keys(capability.roles).length +
      Object.keys(capability.groups).length,
    0,
  );
  const organizationPolicy = data.network.find(
    (row) => row.scopeKind === "organization",
  );
  const groupPolicies = data.network.filter((row) => row.scopeKind === "group");

  return (
    <>
      <PageSection
        description={t("enterprise.signIn.description")}
        title={t("enterprise.signIn.title")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.signIn.requireSso")}</ItemTitle>
              <ItemDescription>
                {settings.ssoRequired
                  ? t("enterprise.signIn.ssoOn")
                  : t("enterprise.signIn.ssoOff")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("enterprise.signIn.requireSso")}
                checked={settings.ssoRequired}
                disabled={saving}
                onCheckedChange={(checked) => onSetting("ssoRequired", checked)}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconFingerprint />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.scim.title")}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {data.scim.configured
                  ? t("enterprise.scim.configured", {
                      url:
                        data.scim.baseUrl ??
                        t("enterprise.scim.setBetterAuthUrl"),
                    })
                  : t("enterprise.scim.off")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.scim.configured
                  ? t("enterprise.on")
                  : t("enterprise.off")}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description={t("enterprise.capabilities.description")}
        title={t("enterprise.capabilities.title")}
      >
        <PageRows>
          {data.capabilities.map((capability) => {
            const effective = capability.organization ?? capability.default;
            return (
              <div key={capability.capability}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconToggleRight />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{capability.title}</ItemTitle>
                    <ItemDescription>
                      {effective
                        ? capability.description
                        : t("enterprise.capabilities.nobodyMay")}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={capability.title}
                      checked={effective}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onCapability(capability.capability, checked)
                      }
                    />
                  </ItemActions>
                </Item>
                <Separator />
              </div>
            );
          })}
          <Item
            render={
              <button onClick={() => setOverridesOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconUsersGroup />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.overrides.title")}</ItemTitle>
              <ItemDescription>
                {overrideCount === 0
                  ? t("enterprise.overrides.none")
                  : t("enterprise.overrides.count", {
                      number: overrideCount,
                    })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>

      <PageSection
        description={t("enterprise.network.description")}
        title={t("enterprise.network.title")}
      >
        <PageRows>
          <Item
            render={
              <button
                onClick={() =>
                  setNetworkScope({ scopeKind: "organization", scopeId: "" })
                }
                type="button"
              />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconWorld />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.network.organization")}</ItemTitle>
              <ItemDescription>
                {summarizePolicy(organizationPolicy, t)}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
          {groupPolicies.map((policy) => (
            <div key={policy.scopeId}>
              <Separator />
              <Item
                render={
                  <button
                    onClick={() =>
                      setNetworkScope({
                        scopeKind: "group",
                        scopeId: policy.scopeId,
                      })
                    }
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconNetwork />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {t("enterprise.network.group", { name: policy.scopeId })}
                  </ItemTitle>
                  <ItemDescription>
                    {summarizePolicy(policy, t)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </div>
          ))}
        </PageRows>
        {data.groups.length > 0 ? (
          <Button
            className="mt-4"
            onClick={() => setNetworkScope({ scopeKind: "group", scopeId: "" })}
            size="sm"
            variant="outline"
          >
            {t("enterprise.network.addGroupPolicy")}
          </Button>
        ) : null}
      </PageSection>

      <PageSection
        description={t("enterprise.mcp.description")}
        title={t("enterprise.mcp.title")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconPlug />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.mcp.onlyApproved")}</ItemTitle>
              <ItemDescription>
                {settings.mcpAllowlist.enabled
                  ? t("enterprise.mcp.approvedCount", {
                      number: settings.mcpAllowlist.servers.length,
                    })
                  : t("enterprise.mcp.off")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("enterprise.mcp.onlyApprovedAria")}
                checked={settings.mcpAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("mcpAllowlist", {
                    ...settings.mcpAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          {data.mcpServers.map((server) => {
            const approved = settings.mcpAllowlist.servers.includes(server.id);
            return (
              <div key={server.id}>
                <Separator />
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{server.title}</ItemTitle>
                    <ItemDescription>{server.url}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Switch
                      aria-label={t("enterprise.mcp.approveAria", {
                        title: server.title,
                      })}
                      checked={approved}
                      disabled={saving}
                      onCheckedChange={(checked) =>
                        onSetting("mcpAllowlist", {
                          ...settings.mcpAllowlist,
                          servers: checked
                            ? [...settings.mcpAllowlist.servers, server.id]
                            : settings.mcpAllowlist.servers.filter(
                                (id) => id !== server.id,
                              ),
                        })
                      }
                    />
                  </ItemActions>
                </Item>
              </div>
            );
          })}
        </PageRows>
      </PageSection>

      <PageSection
        description={t("enterprise.models.description", {
          model: data.builtInModel ?? t("enterprise.models.configuredDefault"),
        })}
        title={t("enterprise.models.title")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconShieldLock />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.models.allowlistTitle")}</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.enabled
                  ? t("enterprise.models.allowlistOn")
                  : t("enterprise.models.allowlistOff")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("enterprise.models.allowlistTitle")}
                checked={settings.modelAllowlist.enabled}
                disabled={saving}
                onCheckedChange={(enabled) =>
                  onSetting("modelAllowlist", {
                    ...settings.modelAllowlist,
                    enabled,
                  })
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={
              <button onClick={() => setModelsOpen(true)} type="button" />
            }
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconKey />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.models.allowed")}</ItemTitle>
              <ItemDescription>
                {settings.modelAllowlist.models.length === 0
                  ? t("enterprise.models.noneListed")
                  : settings.modelAllowlist.models.join(", ")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <ModelUsage />
      </PageSection>

      <PageSection
        description={t("enterprise.recording.description")}
        title={t("enterprise.recording.title")}
      >
        <PageRows>
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconTerminal2 />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.recording.actionRecording")}</ItemTitle>
              <ItemDescription>
                {settings.actionRecording
                  ? t("enterprise.recording.on", {
                      days: data.actionRecordRetentionDays,
                    })
                  : t("enterprise.recording.off")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={t("enterprise.recording.actionRecording")}
                checked={settings.actionRecording}
                disabled={saving}
                onCheckedChange={(checked) =>
                  onSetting("actionRecording", checked)
                }
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.recording.otel")}</ItemTitle>
              <ItemDescription>
                {data.otel.configured
                  ? t("enterprise.recording.otelOn")
                  : t("enterprise.recording.otelOff")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {data.otel.configured
                  ? t("enterprise.on")
                  : t("enterprise.off")}
              </span>
            </ItemActions>
          </Item>
        </PageRows>
        {settings.actionRecording ? <RecordedActions /> : null}
      </PageSection>

      <PageSection
        description={t("enterprise.computers.description")}
        title={t("enterprise.computers.title")}
      >
        <PageRows>
          <Item
            render={<button onClick={() => setDaysOpen(true)} type="button" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconDeviceDesktop />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("enterprise.computers.stopInactive")}</ItemTitle>
              <ItemDescription>
                {settings.inactiveComputerDays === 0
                  ? t("enterprise.off")
                  : t("enterprise.computers.afterDays", {
                      days: settings.inactiveComputerDays,
                    })}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <IconChevronRight className="size-4 text-muted-foreground" />
            </ItemActions>
          </Item>
        </PageRows>
        <SweepNow />
      </PageSection>

      <OverridesDialog
        data={data}
        onOpenChange={setOverridesOpen}
        open={overridesOpen}
      />
      {networkScope ? (
        <NetworkDialog
          data={data}
          initial={networkScope}
          onClose={() => setNetworkScope(undefined)}
        />
      ) : null}
      <ListDialog
        description={t("enterprise.models.listHint")}
        initial={settings.modelAllowlist.models}
        onClose={() => setModelsOpen(false)}
        onSave={(models) =>
          onSetting("modelAllowlist", { ...settings.modelAllowlist, models })
        }
        open={modelsOpen}
        title={t("enterprise.models.allowed")}
      />
      <DaysDialog
        initial={settings.inactiveComputerDays}
        onClose={() => setDaysOpen(false)}
        onSave={(days) => onSetting("inactiveComputerDays", days)}
        open={daysOpen}
      />
    </>
  );
}

function ModelUsage() {
  const { t } = useTranslation("admin");
  const { formatDate } = useDateTime();
  const usage = useQuery(modelUsageQueryOptions(30));
  if (usage.isPending) return null;
  if (usage.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {t("enterprise.models.usageError")}
      </p>
    );
  if (usage.data.summary.length === 0)
    return <PageEmpty>{t("enterprise.models.usageEmpty")}</PageEmpty>;
  return (
    <PageRows>
      {usage.data.summary.map((row, index) => (
        <div key={`${row.model}-${row.source}`}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemMedia variant="icon">
              <IconChartBar />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{row.model}</ItemTitle>
              <ItemDescription>
                {t("enterprise.models.usageLine", {
                  runs: row.runs,
                  count: row.people,
                })}
                {row.refused > 0
                  ? t("enterprise.models.offAllowlist", {
                      number: row.refused,
                    })
                  : ""}{" "}
                · {row.source}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <span className="text-muted-foreground text-sm">
                {formatDate(row.lastUsedAt)}
              </span>
            </ItemActions>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

function RecordedActions() {
  const { t } = useTranslation("admin");
  const { formatDateTime } = useDateTime();
  const actions = useQuery(actionRecordsQueryOptions());
  if (actions.isPending) return null;
  if (actions.error)
    return (
      <p className="mt-4 text-destructive text-sm" role="alert">
        {t("enterprise.recording.loadError")}
      </p>
    );
  if (actions.data.length === 0)
    return <PageEmpty>{t("enterprise.recording.noCommands")}</PageEmpty>;
  return (
    <PageRows>
      {actions.data.map((action, index) => (
        <div key={action.id}>
          {index > 0 ? <Separator /> : null}
          <Item size="sm">
            <ItemContent>
              <ItemTitle className="font-mono text-xs">
                {action.command}
              </ItemTitle>
              <ItemDescription>
                {action.surface === "local"
                  ? t("enterprise.recording.membersMachine")
                  : t("enterprise.recording.botMachine", {
                      botId: action.botId ?? "?",
                    })}
                {" · "}
                {action.outcome} · {formatDateTime(action.createdAt)}
              </ItemDescription>
            </ItemContent>
          </Item>
        </div>
      ))}
    </PageRows>
  );
}

function SweepNow() {
  const { t } = useTranslation("admin");
  const sweep = useMutation(terminateInactiveComputersMutationOptions());
  return (
    <div className="mt-4 flex items-center gap-3">
      <Button
        disabled={sweep.isPending}
        onClick={() => sweep.mutate()}
        size="sm"
        variant="outline"
      >
        {sweep.isPending
          ? t("enterprise.computers.stopping")
          : t("enterprise.computers.stopNow")}
      </Button>
      {sweep.data ? (
        <span className="text-muted-foreground text-sm">
          {t("enterprise.computers.stoppedCount", {
            number: sweep.data.stopped.length,
          })}
        </span>
      ) : null}
      {sweep.error ? (
        <span className="text-destructive text-sm" role="alert">
          {sweep.error.message}
        </span>
      ) : null}
    </div>
  );
}

type Tri = "inherit" | "on" | "off";

function OverridesDialog({
  data,
  open,
  onOpenChange,
}: {
  data: EnterpriseOverview;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("admin");
  const setCapability = useMutation(setCapabilityMutationOptions(queryClient));
  const scopes: { kind: "role" | "group"; id: string; label: string }[] = [
    {
      kind: "role",
      id: "admin",
      label: t("enterprise.overrides.administrators"),
    },
    { kind: "role", id: "user", label: t("enterprise.overrides.members") },
    ...data.groups.map((group) => ({
      kind: "group" as const,
      id: group,
      label: t("enterprise.overrides.groupLabel", { name: group }),
    })),
  ];
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = scopes[scopeIndex] ?? scopes[0];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("enterprise.overrides.title")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Select
            onValueChange={(value) => setScopeIndex(Number(value))}
            value={String(scopeIndex)}
          >
            <SelectTrigger aria-label={t("enterprise.overrides.scopeAria")}>
              <SelectValue>{scope?.label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scopes.map((candidate, index) => (
                  <SelectItem
                    key={`${candidate.kind}:${candidate.id}`}
                    value={String(index)}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            {scope?.kind === "group"
              ? t("enterprise.overrides.groupHint")
              : t("enterprise.overrides.roleHint")}
          </p>
          {scope
            ? data.capabilities.map((capability) => {
                const stored =
                  scope.kind === "role"
                    ? capability.roles[scope.id as "admin" | "user"]
                    : capability.groups[scope.id];
                const value: Tri =
                  stored === undefined ? "inherit" : stored ? "on" : "off";
                return (
                  <div
                    className="flex items-center justify-between gap-4"
                    key={capability.capability}
                  >
                    <Label>{capability.title}</Label>
                    <Select
                      onValueChange={(next) =>
                        setCapability.mutate({
                          scopeKind: scope.kind,
                          scopeId: scope.id,
                          capability: capability.capability,
                          allowed: next === "inherit" ? null : next === "on",
                        })
                      }
                      value={value}
                    >
                      <SelectTrigger
                        aria-label={t("enterprise.overrides.capabilityFor", {
                          title: capability.title,
                          scope: scope.label,
                        })}
                        className="w-36"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="inherit">
                            {t("enterprise.overrides.inherit")}
                          </SelectItem>
                          <SelectItem value="on">
                            {scope.kind === "group"
                              ? t("enterprise.overrides.grant")
                              : t("enterprise.on")}
                          </SelectItem>
                          {scope.kind === "role" ? (
                            <SelectItem value="off">
                              {t("enterprise.off")}
                            </SelectItem>
                          ) : null}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })
            : null}
          {setCapability.error ? (
            <p className="text-destructive text-sm" role="alert">
              {setCapability.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => onOpenChange(false)} size="sm" type="button">
            {t("enterprise.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NetworkDialog({
  data,
  initial,
  onClose,
}: {
  data: EnterpriseOverview;
  initial: { scopeKind: "organization" | "group"; scopeId: string };
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const existing = data.network.find(
    (row) =>
      row.scopeKind === initial.scopeKind && row.scopeId === initial.scopeId,
  );
  const [group, setGroup] = useState(initial.scopeId || data.groups[0] || "");
  const [mode, setMode] = useState<NetworkMode>(
    existing?.mode ?? "defaults_plus_allowlist",
  );
  const [rules, setRules] = useState(rulesToText(existing?.rules ?? []));
  const [locked, setLocked] = useState(existing?.locked ?? false);
  const save = useMutation(setNetworkPolicyMutationOptions(queryClient));
  const remove = useMutation(removeNetworkPolicyMutationOptions(queryClient));
  const scopeId = initial.scopeKind === "group" ? group : "";

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {initial.scopeKind === "organization"
              ? t("enterprise.network.orgPolicyTitle")
              : t("enterprise.network.groupPolicyTitle")}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(
              {
                scopeKind: initial.scopeKind,
                scopeId,
                mode,
                rules: rulesFromText(rules),
                locked,
              },
              { onSuccess: onClose },
            );
          }}
        >
          <DialogBody className="mt-4 space-y-4 overflow-y-auto">
            {initial.scopeKind === "group" && !initial.scopeId ? (
              <div className="space-y-1.5">
                <Label>{t("enterprise.network.groupLabelShort")}</Label>
                <Select
                  onValueChange={(value) => setGroup(String(value))}
                  value={group}
                >
                  <SelectTrigger
                    aria-label={t("enterprise.network.groupLabelShort")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.groups.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>{t("enterprise.network.modeLabel")}</Label>
              <Select
                onValueChange={(value) => setMode(value as NetworkMode)}
                value={mode}
              >
                <SelectTrigger aria-label={t("enterprise.network.modeLabel")}>
                  <SelectValue>{t(MODE_NAMES[mode])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(Object.keys(MODE_NAMES) as NetworkMode[]).map(
                      (candidate) => (
                        <SelectItem key={candidate} value={candidate}>
                          {t(MODE_NAMES[candidate])}
                        </SelectItem>
                      ),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="network-rules">
                {t("enterprise.network.allowlistLabel")}
              </Label>
              <Textarea
                className="font-mono text-xs"
                id="network-rules"
                onChange={(event) => setRules(event.target.value)}
                placeholder={"example.com\n*.corp.example\n10.0.0.0/8 443,5432"}
                rows={8}
                value={rules}
              />
              <p className="text-muted-foreground text-xs">
                {t("enterprise.network.allowlistHint", {
                  defaults: data.defaultDestinations.slice(0, 4).join(", "),
                  more: data.defaultDestinations.length - 4,
                })}
              </p>
            </div>
            {initial.scopeKind === "organization" ? (
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="network-locked">
                  {t("enterprise.network.lockLabel")}
                </Label>
                <Switch
                  checked={locked}
                  id="network-locked"
                  onCheckedChange={setLocked}
                />
              </div>
            ) : null}
            {(save.error ?? remove.error) ? (
              <p className="text-destructive text-sm" role="alert">
                {(save.error ?? remove.error)?.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            {existing ? (
              <Button
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(
                    { scopeKind: initial.scopeKind, scopeId },
                    { onSuccess: onClose },
                  )
                }
                size="sm"
                type="button"
                variant="destructive"
              >
                {t("enterprise.network.removePolicy")}
              </Button>
            ) : null}
            <Button onClick={onClose} size="sm" type="button" variant="outline">
              {t("enterprise.cancel")}
            </Button>
            <Button
              disabled={
                save.isPending || (initial.scopeKind === "group" && !scopeId)
              }
              size="sm"
              type="submit"
            >
              {save.isPending ? t("enterprise.saving") : t("enterprise.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ListDialog({
  open,
  title,
  description,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  initial: string[];
  onSave: (values: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const [text, setText] = useState(initial.join("\n"));
  return (
    <Dialog
      onOpenChange={(next) => (next ? setText(initial.join("\n")) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2 overflow-y-auto">
          <Textarea
            className="font-mono text-xs"
            onChange={(event) => setText(event.target.value)}
            rows={8}
            value={text}
          />
          <p className="text-muted-foreground text-xs">{description}</p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("enterprise.cancel")}
          </Button>
          <Button
            onClick={() => {
              onSave(
                text
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              );
              onClose();
            }}
            size="sm"
            type="button"
          >
            {t("enterprise.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DaysDialog({
  open,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  initial: number;
  onSave: (days: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const [days, setDays] = useState(String(initial));
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 3650;
  return (
    <Dialog
      onOpenChange={(next) => (next ? setDays(String(initial)) : onClose())}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("enterprise.computers.stopInactive")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2">
          <Label htmlFor="inactive-days">
            {t("enterprise.computers.daysWithoutUse")}
          </Label>
          <Input
            id="inactive-days"
            inputMode="numeric"
            onChange={(event) => setDays(event.target.value)}
            value={days}
          />
          <p className="text-muted-foreground text-xs">
            {t("enterprise.computers.daysHint")}
          </p>
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" type="button" variant="outline">
            {t("enterprise.cancel")}
          </Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave(parsed);
              onClose();
            }}
            size="sm"
            type="button"
          >
            {t("enterprise.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
