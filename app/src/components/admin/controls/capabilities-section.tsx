import {
  IconChevronRight,
  IconSparkles,
  IconToggleRight,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { capabilityChangesPreviewQueryOptions } from "@/lib/capability-changes/queries";
import type { CapabilityChange } from "@/lib/capability-changes/translate";
import { setCapabilityMutationOptions } from "@/lib/enterprise/mutations";
import {
  type EnterpriseOverview,
  enterpriseKeys,
} from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";
import { ControlsSection } from "./controls-section";
import { PermissionsPreview } from "./describe-capabilities";

type Capability = EnterpriseOverview["capabilities"][number];
type OverrideScope =
  | { kind: "role"; id: "admin" | "user"; label: string }
  | { kind: "group"; id: string; label: string };

function usePermissionConfirmation() {
  const [changeToPreview, setChangeToPreview] = useState<CapabilityChange>();
  const preview = useQuery({
    ...capabilityChangesPreviewQueryOptions(
      changeToPreview ? [changeToPreview] : [],
    ),
    enabled: changeToPreview !== undefined,
    staleTime: 0,
  });
  const check = preview.data?.check;
  const ready = preview.isSuccess && preview.fetchStatus === "idle";
  const { requestConfirmation, confirmation } = useActionConfirmation({
    content:
      ready && check && !check.ok ? (
        <p className="text-destructive text-sm" role="alert">
          {check.problems[0]?.message ?? check.error}
        </p>
      ) : (
        <PermissionsPreview compact preview={preview} />
      ),
    ready: ready && check?.ok === true,
    onClose: () => setChangeToPreview(undefined),
  });
  const save = useMutation(setCapabilityMutationOptions(queryClient));

  function confirmPermission({
    capability,
    scope,
    allowed,
    trigger,
  }: {
    capability: Capability;
    scope: OverrideScope | { kind: "organization"; id: ""; label: string };
    allowed: boolean | null;
    trigger?: HTMLElement | undefined;
  }) {
    const expected =
      scope.kind === "organization"
        ? capability.organization
        : scope.kind === "role"
          ? (capability.roles[scope.id] ?? null)
          : (capability.groups[scope.id] ?? null);
    if (expected === allowed) return;

    const next = {
      scopeKind: scope.kind,
      scopeId: scope.id,
      capability: capability.capability,
      allowed,
    };
    const change =
      allowed === null ? "Remove override" : allowed ? "Enable" : "Disable";
    const impact =
      scope.kind === "organization"
        ? "This sets the default across the organization. Role and group overrides still apply."
        : scope.kind === "role"
          ? "This changes access for people with this role. Group grants still apply."
          : "This changes access for members of this group. Access granted by other scopes still applies.";
    setChangeToPreview(next);
    requestConfirmation({
      title: `${change} ${capability.title}?`,
      description: `${scope.label}. ${impact}`,
      confirmLabel: change,
      pendingLabel: "Saving permission…",
      failureMessage: "Couldn't save this permission. Try again.",
      successMessage: "Permission saved.",
      variant: allowed === true ? "default" : "destructive",
      trigger,
      refresh: () =>
        queryClient.invalidateQueries({ queryKey: enterpriseKeys.all }),
      run: () => save.mutateAsync({ ...next, expected }),
    });
  }

  return { confirmation, confirmPermission };
}

/**
 * Admin, Permissions: what people may do, for the whole organization, with the row that opens the
 * overrides for roles and directory groups.
 */
export function CapabilitiesSection() {
  const [overridesOpen, setOverridesOpen] = useState(false);
  const { confirmation, confirmPermission } = usePermissionConfirmation();
  return (
    <ControlsSection
      description="Roles can override these defaults. Directory groups can grant additional permissions."
      title="Organization defaults"
    >
      {({ data }) => {
        const overrideCount = data.capabilities.reduce(
          (count, capability) =>
            count +
            Object.keys(capability.roles).length +
            Object.keys(capability.groups).length,
          0,
        );
        return (
          <>
            <PageRows>
              {data.capabilities.map((capability) => {
                const effective = capability.organization ?? capability.default;
                return (
                  <Fragment key={capability.capability}>
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconToggleRight />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{capability.title}</ItemTitle>
                        <ItemDescription className="line-clamp-none text-sm">
                          {capability.description}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Switch
                          aria-label={capability.title}
                          checked={effective}
                          onCheckedChange={(checked, details) => {
                            const target = details.event.target;
                            const trigger =
                              target instanceof Element
                                ? target.closest<HTMLElement>("[role=switch]")
                                : null;
                            confirmPermission({
                              capability,
                              scope: {
                                kind: "organization",
                                id: "",
                                label: "Organization",
                              },
                              allowed: checked,
                              trigger: trigger ?? undefined,
                            });
                          }}
                        />
                      </ItemActions>
                    </Item>
                    <Separator />
                  </Fragment>
                );
              })}
              <Item
                render={
                  <button
                    onClick={() => setOverridesOpen(true)}
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconUsersGroup />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Role and group overrides</ItemTitle>
                  <ItemDescription>
                    {overrideCount === 0
                      ? "None. Everybody gets the switches above"
                      : `${overrideCount} set`}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              <Separator />
              <Item
                render={<Link to="/admin/permissions/describe" />}
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconSparkles />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Describe it in words</ItemTitle>
                  <ItemDescription>
                    Say who may use what, and your model writes the changes.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
            <OverridesDialog
              data={data}
              onOpenChange={setOverridesOpen}
              open={overridesOpen}
            />
            {confirmation}
          </>
        );
      }}
    </ControlsSection>
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
  const { confirmation, confirmPermission } = usePermissionConfirmation();
  const scopes: OverrideScope[] = [
    { kind: "role", id: "admin", label: "Admins" },
    { kind: "role", id: "user", label: "Members" },
    ...data.groups.map(
      (group): OverrideScope => ({
        kind: "group",
        id: group,
        label: `Group: ${group}`,
      }),
    ),
  ];
  const [scopeKey, setScopeKey] = useState("role:admin");
  const scope =
    scopes.find((item) => `${item.kind}:${item.id}` === scopeKey) ?? scopes[0];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Role and group overrides</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-4 overflow-y-auto">
          <Select
            onValueChange={(value) => value && setScopeKey(value)}
            value={scope ? `${scope.kind}:${scope.id}` : null}
          >
            <SelectTrigger
              aria-label="Scope"
              className="min-h-12 w-full whitespace-normal data-[size=default]:h-auto *:data-[slot=select-value]:line-clamp-none"
            >
              <SelectValue className="min-w-0 wrap-anywhere">
                {scope?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scopes.map((candidate) => (
                  <SelectItem
                    className="min-h-12 *:first:min-w-0 *:first:shrink *:first:wrap-anywhere *:first:whitespace-normal"
                    key={`${candidate.kind}:${candidate.id}`}
                    value={`${candidate.kind}:${candidate.id}`}
                  >
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-sm">
            {scope?.kind === "group"
              ? "Allowed grants this permission to group members. No grant leaves access to the other rules."
              : "Allowed or Blocked overrides the organization default. Use default follows it. Group grants still apply."}
          </p>
          {scope &&
            data.capabilities.map((capability) => (
              <PermissionOverrideRow
                capability={capability}
                confirmPermission={confirmPermission}
                key={capability.capability}
                scope={scope}
              />
            ))}
          {confirmation}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            className="min-h-12"
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermissionOverrideRow({
  capability,
  confirmPermission,
  scope,
}: {
  capability: Capability;
  confirmPermission: ReturnType<
    typeof usePermissionConfirmation
  >["confirmPermission"];
  scope: OverrideScope;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const stored =
    scope.kind === "role"
      ? capability.roles[scope.id]
      : capability.groups[scope.id];
  const value: Tri = stored === undefined ? "inherit" : stored ? "on" : "off";
  const inherit = scope.kind === "group" ? "No grant" : "Use default";
  const labels = { inherit, on: "Allowed", off: "Blocked" };

  return (
    <Item size="sm">
      <ItemContent>
        <Label className="wrap-anywhere">{capability.title}</Label>
      </ItemContent>
      <ItemActions>
        <Select<Tri>
          onValueChange={(next) => {
            if (!next) return;
            confirmPermission({
              scope,
              capability,
              allowed: next === "inherit" ? null : next === "on",
              trigger: trigger.current ?? undefined,
            });
          }}
          value={value}
        >
          <SelectTrigger
            aria-label={`${capability.title} for ${scope.label}`}
            className="min-h-12 w-28"
            ref={trigger}
          >
            <SelectValue>{labels[value]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="inherit">{inherit}</SelectItem>
              <SelectItem value="on">{labels.on}</SelectItem>
              {scope.kind === "role" && (
                <SelectItem value="off">{labels.off}</SelectItem>
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
      </ItemActions>
    </Item>
  );
}
