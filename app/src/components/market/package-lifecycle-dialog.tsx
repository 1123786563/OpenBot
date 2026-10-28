import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { WbSecondaryButton, WbTag } from "@/components/market/wb";
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
import { ClientResponseError } from "@/lib/client";
import { usePackageLifecycle } from "@/lib/plugin-packages/mutations";
import type { PluginPackageScope } from "@/lib/plugin-packages/queries";
import type {
  PackageInstallDetailDTO,
  PackageInstallDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * PKG07 (#466): the install lifecycle confirmation surface.
 *
 * One dialog per decision — turn a package off, turn it back on, uninstall it,
 * or reinstall it from its tombstone. The screen states what the change does
 * BEFORE the person confirms: new tool calls stop (or resume), what happens to
 * Bot access, and which assets are involved. Those assets stay where they are —
 * Bots, edited skills, task results and connections belong to their own areas
 * and are never deleted by a package lifecycle change.
 *
 * THE SERVER DECIDES. The dialog sends exactly the wire contract — target
 * status plus the revision it read (the server's CAS) — with one idempotency
 * key per dialog open. A stale revision answers 409 and this screen says to
 * reopen instead of retrying blind; a forbidden caller answers 403; the server
 * re-authorizes the write regardless of what this button says.
 */

export type PackageLifecycleAction = "disable" | "enable" | "uninstall";

/** The install status an action targets. */
export function lifecycleTargetStatus(
  action: PackageLifecycleAction,
): PackageInstallDTO["status"] {
  switch (action) {
    case "disable":
      return "disabled";
    case "enable":
      return "enabled";
    default:
      return "uninstalled";
  }
}

/** One key per dialog open; UUID where the runtime offers it. */
function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `pkg-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function statusOf(error: unknown): number | null {
  return error instanceof ClientResponseError ? error.status : null;
}

export function PackageLifecycleDialog({
  scope,
  install,
  detail,
  action,
  displayName,
  onClose,
}: {
  scope: PluginPackageScope;
  install: PackageInstallDTO;
  /** The install-detail read: the current revision's resources and grants. */
  detail: PackageInstallDetailDTO | null;
  action: PackageLifecycleAction;
  displayName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("market");
  const queryClient = useQueryClient();
  const mutation = usePackageLifecycle(queryClient);
  // One key per dialog open, reused on every retry of this same intent.
  const [idempotencyKey] = React.useState(newIdempotencyKey);
  const [error, setError] = React.useState<string | null>(null);
  /*
   * A stale revision (409) is not retryable with this dialog's CAS: the
   * install moved since it was read. The confirm is disabled so the person
   * closes and opens the package again — a blind retry would answer 409 again.
   */
  const [stale, setStale] = React.useState(false);

  const target = lifecycleTargetStatus(action);
  const reinstall = action === "enable" && install.status === "uninstalled";
  const grantedBots = detail?.grants.length ?? 0;
  const resources = detail?.resources ?? [];
  const canSubmit = !mutation.isPending && !stale;

  /*
   * The copy keys stay literal unions (never template-built strings): the
   * i18n call sites are typed against the generated key union, so a composed
   * key would stop type-checking — and a key that drifted from the locale
   * files would render its own name.
   */
  const titleKey = reinstall
    ? "packages.lifecycle.titleReinstall"
    : action === "disable"
      ? "packages.lifecycle.titleDisable"
      : action === "enable"
        ? "packages.lifecycle.titleEnable"
        : "packages.lifecycle.titleUninstall";
  const descriptionKey = reinstall
    ? "packages.lifecycle.descriptionReinstall"
    : action === "disable"
      ? "packages.lifecycle.descriptionDisable"
      : action === "enable"
        ? "packages.lifecycle.descriptionEnable"
        : "packages.lifecycle.descriptionUninstall";
  const confirmKey = reinstall
    ? "packages.lifecycle.confirmReinstall"
    : action === "disable"
      ? "packages.lifecycle.confirmDisable"
      : action === "enable"
        ? "packages.lifecycle.confirmEnable"
        : "packages.lifecycle.confirmUninstall";

  type ImpactKey =
    | "packages.lifecycle.impactDisable1"
    | "packages.lifecycle.impactDisable2"
    | "packages.lifecycle.impactDisable3"
    | "packages.lifecycle.impactEnable1"
    | "packages.lifecycle.impactEnable2"
    | "packages.lifecycle.impactReinstall1"
    | "packages.lifecycle.impactReinstall2"
    | "packages.lifecycle.impactUninstall1"
    | "packages.lifecycle.impactUninstall2"
    | "packages.lifecycle.impactUninstall3";
  const impactKeys: ImpactKey[] = reinstall
    ? [
        "packages.lifecycle.impactReinstall1",
        "packages.lifecycle.impactReinstall2",
      ]
    : action === "disable"
      ? [
          "packages.lifecycle.impactDisable1",
          "packages.lifecycle.impactDisable2",
          "packages.lifecycle.impactDisable3",
        ]
      : action === "enable"
        ? [
            "packages.lifecycle.impactEnable1",
            "packages.lifecycle.impactEnable2",
          ]
        : [
            "packages.lifecycle.impactUninstall1",
            "packages.lifecycle.impactUninstall2",
            "packages.lifecycle.impactUninstall3",
          ];

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    mutation.mutate(
      {
        scope,
        installId: install.installId,
        status: target,
        expectedRevision: install.revision,
        idempotencyKey,
      },
      {
        onError: (mutationError) => {
          const status = statusOf(mutationError);
          if (status === 403) {
            setError(t("packages.lifecycle.errorForbidden"));
          } else if (status === 409) {
            setStale(true);
            setError(t("packages.lifecycle.errorConflict"));
          } else if (status === 422) {
            setError(t("packages.lifecycle.errorUnsupported"));
          } else {
            setError(t("packages.lifecycle.errorGeneric"));
          }
        },
        onSuccess: () => {
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent
        className="max-w-[560px] gap-0 rounded-2xl p-6"
        overlayClassName="bg-black/25 dark:bg-black/70"
      >
        <DialogHeader>
          <DialogTitle>{t(titleKey, { name: displayName })}</DialogTitle>
          <DialogDescription>{t(descriptionKey)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 gap-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <WbTag>{t("packages.lifecycle.statusLabel")}</WbTag>
            <WbTag>{t(`packages.install.status.${install.status}`)}</WbTag>
            <WbTag>{`→ ${t(`packages.install.status.${target}`)}`}</WbTag>
            <WbTag>{`v${install.version}`}</WbTag>
            <WbTag>{`r${install.revision}`}</WbTag>
            <WbTag>{`g${install.generation}`}</WbTag>
          </div>

          <section aria-label={t("packages.lifecycle.impactTitle")}>
            <h3 className="text-sm font-medium text-foreground">
              {t("packages.lifecycle.impactTitle")}
            </h3>
            <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-foreground/70">
              {impactKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>

          <section aria-label={t("packages.lifecycle.assetsTitle")}>
            <h3 className="text-sm font-medium text-foreground">
              {t("packages.lifecycle.assetsTitle")}
            </h3>
            <p className="mt-1 text-xs leading-5 text-foreground/60">
              {t("packages.lifecycle.assetsResources")}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {resources.map((resource) => (
                <li key={resource.id}>
                  <WbTag>
                    <code className="font-mono">{resource.id}</code>
                  </WbTag>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-5 text-foreground/60">
              {t("packages.lifecycle.assetsGrants", { count: grantedBots })}
            </p>
          </section>

          {error === null ? null : (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <WbSecondaryButton onClick={onClose} type="button">
            {t("packages.lifecycle.cancel")}
          </WbSecondaryButton>
          <Button disabled={!canSubmit} onClick={submit} type="button">
            {mutation.isPending
              ? t("packages.lifecycle.applying")
              : t(confirmKey)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
