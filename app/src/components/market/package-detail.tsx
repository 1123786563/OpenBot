import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { PackageDispatchesSection } from "@/components/market/package-dispatches";
import { PackageExpertsSection } from "@/components/market/package-experts";
import { PackageGrantsSection } from "@/components/market/package-grants";
import {
  type PackageLifecycleAction,
  PackageLifecycleDialog,
} from "@/components/market/package-lifecycle-dialog";
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
  pluginPackageInstallDetailQueryOptions,
} from "@/lib/plugin-packages/queries";
import type {
  PackageBlocker,
  PackageCatalogueDetail,
  PackageInstallDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The package detail dialog: identity, verified digest, the resources the package declares and
 * the reasons any of them cannot be used yet.
 *
 * PKG02 ADDS TWO READ-ONLY FACTS. A catalogue detail stays exactly what the catalogue publishes;
 * the trusted scope's install facts are drawn beside it, read from the install-detail query —
 * the single source a grant, revoke or expert creation invalidates — with the list row's copy
 * as the first-render placeholder only. The preview verb is drawn only when the caller says the person is a company
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
  PACKAGE_WITHDRAWN: "packages.blocker.PACKAGE_WITHDRAWN",
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

/**
 * PKG06 (#465): the version-management face of an installed package — the
 * current install's version and revision, the newest published release, and
 * an exact target picker whose entry opens the operation-aware preview
 * dialog with the CAS revision the caller just read. A package with no other
 * published release says it is up to date instead of offering a no-op.
 */
function PackageVersionSection({
  detail,
  install,
  onPreview,
  displayName,
  packageKey,
  targetVersion,
  onTargetChange,
}: {
  detail: PackageCatalogueDetail | null;
  install: PackageInstallDTO | null;
  onPreview?: (subject: PackagePreviewSubject) => void;
  displayName: string;
  packageKey: string;
  targetVersion: string | null;
  onTargetChange: (version: string | null) => void;
}) {
  const { t } = useTranslation("market");
  if (install === null) return null;
  const published = (detail?.versions ?? []).filter(
    (entry) => entry.verified && entry.listed,
  );
  const targets = published.filter(
    (entry) => entry.version !== install.version,
  );
  const latest = published[0]?.version ?? null;
  const upgradable =
    latest !== null && comparePackageVersions(install.version, latest) < 0;
  const selected = targetVersion ?? targets[0]?.version ?? null;

  const open = () => {
    if (onPreview === undefined || selected === null) return;
    const operation: "upgrade" | "rollback" =
      comparePackageVersions(selected, install.version) > 0
        ? "upgrade"
        : "rollback";
    onPreview({
      packageKey,
      version: selected,
      displayName,
      operation,
      expectedRevision: install.revision,
    });
  };

  return (
    <section aria-label={t("packages.upgrade.sectionTitle")}>
      <h3 className="text-sm font-medium text-foreground">
        {t("packages.upgrade.sectionTitle")}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <WbTag>{`v${install.version}`}</WbTag>
        <WbTag>{`r${install.revision}`}</WbTag>
        {upgradable ? (
          <WbTag className="text-primary">
            {t("packages.upgrade.upgradable")}
          </WbTag>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-5 text-foreground/60">
        {latest === null
          ? t("packages.upgrade.publishedUnknown")
          : t("packages.upgrade.publishedLatest", { version: latest })}
      </p>
      {targets.length === 0 ? (
        <p className="mt-1 text-xs leading-5 text-foreground/50">
          {t("packages.upgrade.upToDate")}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={t("packages.upgrade.targetLabel")}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs"
            onChange={(event) => onTargetChange(event.target.value)}
            value={selected ?? ""}
          >
            {targets.map((entry) => (
              <option key={entry.version} value={entry.version}>
                {`v${entry.version}`}
              </option>
            ))}
          </select>
          {onPreview !== undefined ? (
            <Button onClick={open} size="sm" type="button">
              {selected !== null &&
              comparePackageVersions(selected, install.version) < 0
                ? t("packages.upgrade.openRollback")
                : t("packages.upgrade.openUpgrade")}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * PKG07 (#466): the lifecycle face of an installed package. The verbs are drawn
 * from the server's own `allowedActions` — never from this screen's guess — so a
 * disabled install offers "Turn on" (grants revoked, nothing revived), an
 * uninstalled tombstone offers only "Reinstall", and an enabled install offers
 * the ways out. A member's install carries no actions and this section renders
 * nothing at all.
 */
function PackageLifecycleSection({
  install,
  onPick,
}: {
  install: PackageInstallDTO;
  onPick: (action: PackageLifecycleAction) => void;
}) {
  const { t } = useTranslation("market");
  const verbs: Array<{ action: PackageLifecycleAction; label: string }> = [];
  if (install.allowedActions.includes("disable")) {
    verbs.push({
      action: "disable",
      label: t("packages.lifecycle.openDisable"),
    });
  }
  if (install.allowedActions.includes("enable")) {
    verbs.push({
      action: "enable",
      label:
        install.status === "uninstalled"
          ? t("packages.lifecycle.openReinstall")
          : t("packages.lifecycle.openEnable"),
    });
  }
  if (install.allowedActions.includes("uninstall")) {
    verbs.push({
      action: "uninstall",
      label: t("packages.lifecycle.openUninstall"),
    });
  }
  if (verbs.length === 0) return null;
  return (
    <section aria-label={t("packages.lifecycle.sectionTitle")}>
      <h3 className="text-sm font-medium text-foreground">
        {t("packages.lifecycle.sectionTitle")}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <WbTag>{t(`packages.install.status.${install.status}`)}</WbTag>
        {verbs.map((verb) => (
          <Button
            key={verb.action}
            onClick={() => onPick(verb.action)}
            size="sm"
            type="button"
            variant={verb.action === "uninstall" ? "outline" : undefined}
          >
            {verb.label}
          </Button>
        ))}
      </div>
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
  /**
   * PKG06 (#465): present when the detail screen hands over an upgrade or
   * rollback — the exact target version plus the install revision the caller
   * read (the plan's CAS). Absent means a first install.
   */
  operation?: "install" | "upgrade" | "rollback";
  expectedRevision?: number | null;
};

/**
 * Three-part semantic-version compare, client-side only for choosing the
 * VERB (upgrade vs rollback) and the upgradable hint. The server compares
 * and re-validates on its own; this never decides authority.
 */
export function comparePackageVersions(left: string, right: string): number {
  const parts = (value: string) => value.split(".").map(Number);
  const [aMajor, aMinor, aPatch] = parts(left);
  const [bMajor, bMinor, bPatch] = parts(right);
  for (const pair of [
    [aMajor, bMajor],
    [aMinor, bMinor],
    [aPatch, bPatch],
  ] as const) {
    if (pair[0] !== pair[1]) {
      return (pair[0] ?? 0) < (pair[1] ?? 0) ? -1 : 1;
    }
  }
  return 0;
}

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
  /**
   * The trusted scope's install for this package, when the list already knows one — the
   * first-render placeholder; the facts block reads the install-detail query once it answers.
   */
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
  /*
   * PKG06: the admin's target-version choice for an upgrade or rollback. The
   * published versions come from the catalogue detail read (the server's own
   * published facts, newest first); the verb is derived by comparison — the
   * server decides everything again at plan and apply.
   */
  const [targetVersion, setTargetVersion] = React.useState<string | null>(null);
  /*
   * The install facts' single source is the install-detail read — the very entry a grant,
   * revoke or expert creation invalidates — so a write made inside this dialog shows in the
   * facts block the moment its refetch lands, instead of the list row's cached copy
   * contradicting the refreshed sections below it. The read is subscribed exactly where those
   * writes exist (an administrator of an install that can be managed — the same gate the
   * sections render under); a member's dialog never mutates, so it keeps drawing the list
   * row and issues no request of its own. The list row's install is otherwise the
   * first-render placeholder; until the read answers, the facts show what the list knew.
   * Same key as the sections' own subscription, so this adds no second request.
   */
  /*
   * PKG07 (#466): a lifecycle change (turn off / turn on / uninstall /
   * reinstall) belongs to a company administrator on ANY install state — the
   * detail read is what keeps its facts and associated assets live, so it is
   * subscribed for the whole lifecycle surface. The version / grant / expert
   * sections stay behind an ENABLED install: the server refuses those writes
   * from any other state, and this screen never offers a verb it knows will be
   * refused.
   */
  const canManageLifecycle = canInstall && install !== null;
  const managesEnabledInstall =
    canInstall && install !== null && install.status === "enabled";
  const installDetail = useQuery({
    ...pluginPackageInstallDetailQueryOptions(scope, install?.installId ?? ""),
    enabled: canManageLifecycle,
  });
  const installFacts = installDetail.data ?? install;
  /** The lifecycle verb whose confirmation dialog is open (one at a time). */
  const [lifecycleAction, setLifecycleAction] =
    React.useState<PackageLifecycleAction | null>(null);

  return (
    <>
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
                {installFacts ? (
                  <PackageInstallFacts install={installFacts} />
                ) : null}
                {/*
                 * The version / grant / expert surfaces are the company
                 * administrator's alone and need an ENABLED install: an upgrade,
                 * grant or expert creation from a disabled/uninstalled install is
                 * refused by the server. PKG07's lifecycle verbs are drawn
                 * separately below, on every install state, from the server's own
                 * `allowedActions`. The server re-authorizes every write
                 * regardless.
                 */}
                {managesEnabledInstall ? (
                  <>
                    <PackageVersionSection
                      detail={detail.data ?? null}
                      install={installFacts ?? install}
                      onPreview={onPreview}
                      displayName={subject.displayName}
                      packageKey={
                        detail.data?.packageKey ??
                        `${subject.publisher}/${subject.name}`
                      }
                      targetVersion={targetVersion}
                      onTargetChange={setTargetVersion}
                    />
                    <PackageGrantsSection install={install} scope={scope} />
                    <PackageExpertsSection
                      install={install}
                      scope={scope}
                      subject={subject}
                    />
                  </>
                ) : null}
                {canManageLifecycle && installFacts ? (
                  <PackageLifecycleSection
                    install={installFacts}
                    onPick={setLifecycleAction}
                  />
                ) : null}
                {/*
                 * PKG10 (#469): the dispatch ledger rides the install detail
                 * for every eligible member, not only admins — an unknown
                 * effect is the caller's fact. It renders in every install
                 * state; rows survive disable, uninstall and withdrawal.
                 */}
                {install ? (
                  <PackageDispatchesSection install={install} scope={scope} />
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
      {/*
       * PKG07: the confirmation surface is a sibling dialog, opened by one of
       * the lifecycle verbs above. It closes on its own after a successful
       * write; the captured scope's cache invalidation then refreshes the
       * facts, the allowed actions and the shelf behind both dialogs.
       */}
      {lifecycleAction !== null && installFacts !== null && install ? (
        <PackageLifecycleDialog
          action={lifecycleAction}
          detail={installDetail.data ?? null}
          displayName={subject.displayName}
          install={installFacts}
          onClose={() => setLifecycleAction(null)}
          scope={scope}
        />
      ) : null}
    </>
  );
}
