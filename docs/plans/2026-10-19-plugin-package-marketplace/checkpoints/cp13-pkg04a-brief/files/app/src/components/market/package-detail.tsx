import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PackageGrantsSection } from "@/components/market/package-grants";
import { WbIdRow, WbStatsRow, WbTag } from "@/components/market/wb";
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
  type PluginPackageScope,
  pluginPackageDetailQueryOptions,
} from "@/lib/plugin-packages/queries";
import type {
  PackageBlocker,
  PackageInstallDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The package detail dialog: identity, verified digest, the resources the package declares and
 * the reasons any of them cannot be used yet.
 *
 * PKG02 ADDS TWO READ-ONLY FACTS. A catalogue detail stays exactly what the catalogue publishes;
 * the trusted scope's install facts arrive from the list (or the install read) and are drawn
 * beside it. The preview verb is drawn only when the caller says the person is a company
 * administrator and the package is installable — and even then the server refuses on its own;
 * hiding a button has never been authorization. Non-administrators see the real install state,
 * never an action.
 *
 * Installation is not authority: whenever an install needs a grant, the dialog says so in words.
 */

const BLOCKER_REASON = {
  ARTIFACT_MISSING: "packages.blocker.ARTIFACT_MISSING",
  ARTIFACT_INVALID: "packages.blocker.ARTIFACT_INVALID",
  PACKAGE_UNLISTED: "packages.blocker.PACKAGE_UNLISTED",
  PACKAGE_UNSUPPORTED: "packages.blocker.PACKAGE_UNSUPPORTED",
  RESOURCE_UNAVAILABLE: "packages.blocker.RESOURCE_UNAVAILABLE",
  NEEDS_CONNECTION: "packages.blocker.NEEDS_CONNECTION",
  NEEDS_GRANT: "packages.blocker.NEEDS_GRANT",
} as const;

const RESOURCE_KIND = {
  skill: "packages.detail.kind.skill",
  expertTemplate: "packages.detail.kind.expertTemplate",
  managedConnector: "packages.detail.kind.managedConnector",
} as const;

const INSTALL_STATUS = {
  enabled: "packages.install.status.enabled",
  disabled: "packages.install.status.disabled",
  uninstalled: "packages.install.status.uninstalled",
} as const;

const INSTALL_READINESS = {
  ready: "packages.install.readiness.ready",
  needs_connection: "packages.install.readiness.needs_connection",
  needs_grant: "packages.install.readiness.needs_grant",
  unavailable: "packages.install.readiness.unavailable",
} as const;

/*
 * Unknown wire values still reach here: the contract is closed, but a newer server or a trimmed
 * test fixture must read as a sentence, not as the string "undefined". The fallbacks are the
 * generic reason and the generic resource label.
 */
type BlockerReasonKey =
  | (typeof BLOCKER_REASON)[keyof typeof BLOCKER_REASON]
  | "packages.blocker.UNKNOWN";

type ResourceKindKey =
  | (typeof RESOURCE_KIND)[keyof typeof RESOURCE_KIND]
  | "packages.detail.kind.unknown";

function blockerReasonKey(code: string): BlockerReasonKey {
  return (
    (BLOCKER_REASON as Record<string, BlockerReasonKey>)[code] ??
    "packages.blocker.UNKNOWN"
  );
}

function resourceKindKey(kind: string): ResourceKindKey {
  return (
    (RESOURCE_KIND as Record<string, ResourceKindKey>)[kind] ??
    "packages.detail.kind.unknown"
  );
}

/** The kind label a preview row and the catalogue dialog both draw. */
export function packageResourceKindKey(kind: string): ResourceKindKey {
  return resourceKindKey(kind);
}

type InstallStatusKey =
  | (typeof INSTALL_STATUS)[keyof typeof INSTALL_STATUS]
  | "packages.install.status.uninstalled";

type InstallReadinessKey =
  | (typeof INSTALL_READINESS)[keyof typeof INSTALL_READINESS]
  | "packages.install.readiness.unavailable";

/** The localized status label for install facts. */
export function packageInstallStatusKey(status: string): InstallStatusKey {
  return (
    (INSTALL_STATUS as Record<string, InstallStatusKey>)[status] ??
    "packages.install.status.uninstalled"
  );
}

/** The localized readiness label for install facts. */
export function packageInstallReadinessKey(
  readiness: string,
): InstallReadinessKey {
  return (
    (INSTALL_READINESS as Record<string, InstallReadinessKey>)[readiness] ??
    "packages.install.readiness.unavailable"
  );
}

/** One human-readable blocker line, shared by the card and the dialog. */
export function PackageBlockerLine({ blocker }: { blocker: PackageBlocker }) {
  const { t } = useTranslation("market");
  return (
    <li className="flex items-start gap-1.5 text-sm text-destructive">
      <IconAlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>
        {t(blockerReasonKey(blocker.code))}
        {blocker.resourceId ? (
          <code className="ml-1.5 font-mono text-xs text-foreground/50">
            {blocker.resourceId}
          </code>
        ) : null}
      </span>
    </li>
  );
}

/** The blocker list a card and the dialog both draw, with its own accessible name. */
export function PackageBlockerList({
  blockers,
}: {
  blockers: PackageBlocker[];
}) {
  const { t } = useTranslation("market");
  if (blockers.length === 0) return null;
  return (
    <ul aria-label={t("packages.blockers")} className="flex flex-col gap-1">
      {blockers.map((blocker) => (
        <PackageBlockerLine
          blocker={blocker}
          key={`${blocker.code}:${blocker.resourceId ?? ""}`}
        />
      ))}
    </ul>
  );
}

/**
 * One installation's real, read-only facts: version, revision, status, readiness and blockers.
 *
 * `notice` is on whenever the install still needs a Bot grant. The sentence is not decoration:
 * the package being installed says nothing about whether any Bot may execute its tools.
 */
export function PackageInstallFacts({
  install,
  notice = true,
  showVersion = true,
}: {
  install: PackageInstallDTO;
  notice?: boolean;
  /** A card already carries the version chip; the dialog repeats it inside these facts. */
  showVersion?: boolean;
}) {
  const { t } = useTranslation("market");
  const needsGrant =
    install.readiness === "needs_grant" ||
    install.blockers.some((blocker) => blocker.code === "NEEDS_GRANT");
  return (
    <section
      aria-label={t("packages.detail.installState")}
      className="flex flex-col gap-2 rounded-xl bg-foreground/[0.03] p-3"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <WbTag>{t("packages.install.installed")}</WbTag>
        {showVersion ? <WbTag>{`v${install.version}`}</WbTag> : null}
        <WbTag>{`r${install.revision}`}</WbTag>
        <WbTag>{t(packageInstallStatusKey(install.status))}</WbTag>
        <WbTag
          className={
            install.readiness === "ready" ? undefined : "text-destructive"
          }
        >
          {t(packageInstallReadinessKey(install.readiness))}
        </WbTag>
      </div>
      <PackageBlockerList blockers={install.blockers} />
      {notice && needsGrant ? (
        <p className="text-xs leading-5 text-foreground/60">
          {t("packages.install.grantNotice")}
        </p>
      ) : null}
    </section>
  );
}

/** The identity the pane already holds; the dialog reads the rest from the detail endpoint. */
export type PackageDetailSubject = {
  publisher: string;
  name: string;
  displayName: string;
  summary: string;
};

/** What the preview dialog needs from the detail the person is looking at. */
export type PackagePreviewSubject = {
  packageKey: string;
  version: string;
  displayName: string;
};

export function PackageDetailWb({
  scope,
  subject,
  install = null,
  canInstall = false,
  onPreview,
  onClose,
}: {
  scope: PluginPackageScope;
  subject: PackageDetailSubject;
  /** The trusted scope's install for this package, when the list already knows one. */
  install?: PackageInstallDTO | null;
  /** The caller's reading of the company-administrator role; the server still decides. */
  canInstall?: boolean;
  onPreview?: (subject: PackagePreviewSubject) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("market");
  const detail = useQuery(
    pluginPackageDetailQueryOptions(scope, subject.publisher, subject.name),
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="max-w-[640px] gap-0 rounded-2xl p-6">
        <DialogHeader>
          <DialogTitle>{subject.displayName}</DialogTitle>
          <DialogDescription>{subject.summary}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 gap-5">
          {detail.isPending ? (
            <p className="text-sm text-foreground/50">
              {t("packages.detail.loading")}
            </p>
          ) : detail.isError ? (
            <div className="flex flex-col items-start gap-3" role="alert">
              <p className="text-destructive text-sm">
                {t("packages.detail.loadError")}
              </p>
              <Button
                onClick={() => void detail.refetch()}
                size="sm"
                variant="outline"
              >
                {t("packages.detail.retry")}
              </Button>
            </div>
          ) : (
            <>
              <WbStatsRow
                stats={[
                  {
                    value: detail.data.publisher,
                    label: t("packages.detail.publisher"),
                  },
                  {
                    value: detail.data.name,
                    label: t("packages.detail.name"),
                  },
                  {
                    value: detail.data.version,
                    label: t("packages.detail.version"),
                  },
                ]}
              />
              <WbIdRow
                id={detail.data.artifactDigest}
                label={t("packages.detail.digest")}
              />
              {install ? <PackageInstallFacts install={install} /> : null}
              {/*
               * The grant surface is the company administrator's alone, and only an
               * install that still exists can manage grants. The wire contract declares
               * an `allowedActions` array on every install, but no server build names a
               * grant action in it yet, so the gate is the install's own lifecycle
               * state; the server re-authorizes every write regardless.
               */}
              {canInstall &&
              install !== null &&
              install.status !== "uninstalled" ? (
                <PackageGrantsSection install={install} scope={scope} />
              ) : null}
              <section>
                <h3 className="text-sm font-medium text-foreground">
                  {t("packages.detail.resources")}
                </h3>
                {detail.data.resources.length === 0 ? (
                  <p className="mt-2 text-sm text-foreground/50">
                    {t("packages.detail.noResources")}
                  </p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {detail.data.resources.map((resource) => (
                      <li
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2"
                        key={resource.id}
                      >
                        <WbTag>{t(resourceKindKey(resource.kind))}</WbTag>
                        <code className="min-w-0 truncate font-mono text-xs text-foreground/70">
                          {resource.id}
                        </code>
                        <span className="ml-auto text-xs text-foreground/50">
                          {resource.available
                            ? t("packages.detail.available")
                            : t("packages.detail.unavailable")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {detail.data.blockers.length > 0 ? (
                <section>
                  <h3 className="text-sm font-medium text-foreground">
                    {t("packages.detail.blockers")}
                  </h3>
                  <div className="mt-2">
                    <PackageBlockerList blockers={detail.data.blockers} />
                  </div>
                </section>
              ) : null}
            </>
          )}
        </DialogBody>
        {canInstall &&
        !install &&
        onPreview !== undefined &&
        detail.data?.installable === true ? (
          <DialogFooter className="mt-4">
            <Button
              onClick={() => {
                if (!detail.data) return;
                onPreview({
                  packageKey: detail.data.packageKey,
                  version: detail.data.version,
                  displayName: subject.displayName,
                });
              }}
              type="button"
            >
              {t("packages.install.previewAction")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
