import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  PackageBlockerList,
  PackageInstallFacts,
  packageResourceKindKey,
} from "@/components/market/package-detail";
import {
  WbIdRow,
  WbSecondaryButton,
  WbStatsRow,
  WbTag,
} from "@/components/market/wb";
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
import { useDateTime } from "@/lib/i18n/datetime";
import {
  packageApplyMutationOptions,
  packagePlanMutationOptions,
} from "@/lib/plugin-packages/mutations";
import type { PluginPackageScope } from "@/lib/plugin-packages/queries";
import {
  PACKAGE_CONFIG_LIMITS,
  type PackageConfig,
  type PackageInstallDTO,
  type PackagePlanDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The install preview and confirm dialog, PKG02.
 *
 * THE PLAN IS THE SCREEN. Opening the dialog asks the server for a ten-minute plan against the
 * exact package version, and the dialog draws only what that plan answered: digest, team,
 * resources, declared tools with their effect, blockers and expiry. Confirm sends the server's
 * plan id plus one idempotency key; the server, not this component, decides whether a second
 * press creates anything.
 *
 * CONFIGURATION IS FLAT AND NON-SECRET. A key that looks like a credential is refused here as
 * well as in the wire contract, and the hint says where credentials actually live. Editing any
 * configuration field discards the preview, so a stale plan can never be confirmed by accident.
 *
 * SCOPE IS CAPTURED AT OPEN. The dialog is remounted when the shelf's team changes, and the
 * mutations carry the scope they were opened under; a late apply answer invalidates only that
 * scope's keys. An expired plan drops the plan id while keeping every non-secret input, and 409
 * and 403 answers each get a sentence the person can act on.
 */

type ConfigType = "string" | "number" | "boolean";

type ConfigRow = {
  id: string;
  key: string;
  value: string;
  type: ConfigType;
};

/** The wire contract's closed rule, repeated so the form can refuse before a request is sent. */
const SECRET_LOOKING_KEY =
  /(secret|token|passw|credential|api[-_]?key|private[-_]?key|authori[sz]ation|bearer|envelope|plaintext|cookie|session)/i;

let rowCounter = 0;
function nextRowId(): string {
  rowCounter += 1;
  return `config-row-${rowCounter}`;
}

/** One key per confirm attempt; UUID where the runtime offers it, an ASCII fallback otherwise. */
function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function statusOf(error: unknown): number | null {
  return error instanceof ClientResponseError ? error.status : null;
}

/** The server's own refusal sentence, when the transport captured one. */
function serverMessageOf(error: unknown): string | null {
  return error instanceof ClientResponseError ? error.serverMessage : null;
}

export type PackageInstallSubject = {
  packageKey: string;
  version: string;
  displayName: string;
};

export function PackageInstallDialog({
  scope,
  subject,
  onClose,
}: {
  scope: PluginPackageScope;
  subject: PackageInstallSubject;
  onClose: () => void;
}) {
  const { t } = useTranslation("market");
  const { formatTime } = useDateTime();
  const queryClient = useQueryClient();
  const planMutation = useMutation(packagePlanMutationOptions());
  const applyMutation = useMutation(packageApplyMutationOptions(queryClient));

  const [rows, setRows] = React.useState<ConfigRow[]>([]);
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<PackagePlanDTO | null>(null);
  const [planError, setPlanError] = React.useState<string | null>(null);
  const [planning, setPlanning] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [installed, setInstalled] = React.useState<PackageInstallDTO | null>(
    null,
  );
  // A plan answer is only accepted while its request is still the current one.
  const planToken = React.useRef(0);
  const applyingRef = React.useRef(false);
  const started = React.useRef(false);

  const discardPlan = React.useCallback(() => {
    planToken.current += 1;
    // The dropped request will never answer `planning`; this call owns clearing it, or the
    // dialog would keep saying "Creating preview…" with no request left to wait for.
    setPlanning(false);
    setPlan(null);
    setPlanError(null);
    setApplyError(null);
  }, []);

  const buildConfig = React.useCallback((): PackageConfig | null => {
    const config: PackageConfig = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key === "") continue;
      if (SECRET_LOOKING_KEY.test(key)) {
        setConfigError(t("packages.install.configInvalidKey"));
        return null;
      }
      if (Object.hasOwn(config, key)) {
        setConfigError(t("packages.install.configDuplicateKey"));
        return null;
      }
      // The rest of PackageConfigSchema's wire boundaries, mirrored from the
      // shared constants so client pre-validation cannot drift from the wire.
      if (Object.keys(config).length >= PACKAGE_CONFIG_LIMITS.maxKeys) {
        setConfigError(t("packages.install.configTooManyKeys"));
        return null;
      }
      if (
        key.length > PACKAGE_CONFIG_LIMITS.maxKeyLength ||
        (row.type === "string" &&
          row.value.length > PACKAGE_CONFIG_LIMITS.maxValueLength)
      ) {
        setConfigError(t("packages.install.configTooLong"));
        return null;
      }
      if (row.type === "number") {
        const value = Number(row.value);
        if (row.value.trim() === "" || !Number.isFinite(value)) {
          setConfigError(
            t("packages.install.configInvalidNumber", { value: row.value }),
          );
          return null;
        }
        config[key] = value;
      } else if (row.type === "boolean") {
        config[key] = row.value === "true";
      } else {
        config[key] = row.value;
      }
    }
    setConfigError(null);
    return config;
  }, [rows, t]);

  const startPlan = React.useCallback(() => {
    const config = buildConfig();
    if (config === null) return;
    const token = planToken.current + 1;
    planToken.current = token;
    setPlan(null);
    setPlanError(null);
    setApplyError(null);
    setPlanning(true);
    planMutation.mutate(
      {
        scope,
        packageKey: subject.packageKey,
        version: subject.version,
        config,
      },
      {
        onSuccess: (answer) => {
          if (planToken.current !== token) return;
          setPlanning(false);
          setPlan(answer);
        },
        onError: (error) => {
          if (planToken.current !== token) return;
          setPlanning(false);
          const status = statusOf(error);
          if (status === 403) {
            setPlanError(t("packages.install.forbidden"));
          } else if (status === 503) {
            setPlanError(t("packages.install.unavailable"));
          } else {
            // A refusal the dialog did not special-case still carries the
            // server's sentence (e.g. INPUT_INVALID detail); show it rather
            // than trapping the admin in an unexplained retry loop.
            const serverMessage = serverMessageOf(error);
            setPlanError(
              serverMessage ?? t("packages.install.planError"),
            );
          }
        },
      },
    );
  }, [
    buildConfig,
    planMutation,
    scope,
    subject.packageKey,
    subject.version,
    t,
  ]);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    startPlan();
  }, [startPlan]);

  const editRows = (change: (held: ConfigRow[]) => ConfigRow[]) => {
    // Any edit makes an existing preview stale: it is dropped, not confirmed.
    discardPlan();
    setConfigError(null);
    setRows(change);
  };

  const confirm = () => {
    if (plan === null || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    setApplyError(null);
    const idempotencyKey = newIdempotencyKey();
    applyMutation.mutate(
      { scope, planId: plan.planId, idempotencyKey },
      {
        onSuccess: (install) => {
          setInstalled(install);
          setPlan(null);
        },
        onError: (error) => {
          const status = statusOf(error);
          if (status === 410) {
            // Expired: the plan id is spent, every non-secret input stays.
            planToken.current += 1;
            setPlan(null);
            setApplyError(t("packages.install.applyExpired"));
          } else if (status === 409) {
            planToken.current += 1;
            setPlan(null);
            setApplyError(t("packages.install.applyConflict"));
          } else if (status === 403) {
            setApplyError(t("packages.install.applyForbidden"));
          } else {
            const serverMessage = serverMessageOf(error);
            setApplyError(
              serverMessage ?? t("packages.install.applyError"),
            );
          }
        },
        onSettled: () => {
          applyingRef.current = false;
          setApplying(false);
        },
      },
    );
  };

  // A malformed expiry is not a time to print: `Invalid Date` would reach the sentence.
  const expiresAt = plan === null ? null : new Date(plan.expiresAt);
  const expiryTime =
    expiresAt !== null && !Number.isNaN(expiresAt.getTime())
      ? formatTime(expiresAt)
      : null;

  const configEditor = (
    <section>
      <h3 className="text-sm font-medium text-foreground">
        {t("packages.install.config")}
      </h3>
      <p className="mt-1 text-xs leading-5 text-foreground/50">
        {t("packages.install.configHint")}
      </p>
      {rows.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map((row) => (
            <div className="flex flex-wrap items-center gap-2" key={row.id}>
              <input
                aria-label={t("packages.install.configKey")}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs"
                disabled={applying}
                onChange={(event) => {
                  const value = event.target.value;
                  editRows((held) =>
                    held.map((entry) =>
                      entry.id === row.id ? { ...entry, key: value } : entry,
                    ),
                  );
                }}
                value={row.key}
              />
              <select
                aria-label={t("packages.install.configType")}
                className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                disabled={applying}
                onChange={(event) => {
                  const value = event.target.value as ConfigType;
                  editRows((held) =>
                    held.map((entry) =>
                      entry.id === row.id
                        ? {
                            ...entry,
                            type: value,
                            value:
                              value === "boolean"
                                ? entry.value === "false"
                                  ? "false"
                                  : "true"
                                : entry.value,
                          }
                        : entry,
                    ),
                  );
                }}
                value={row.type}
              >
                <option value="string">
                  {t("packages.install.configTypeString")}
                </option>
                <option value="number">
                  {t("packages.install.configTypeNumber")}
                </option>
                <option value="boolean">
                  {t("packages.install.configTypeBoolean")}
                </option>
              </select>
              {row.type === "boolean" ? (
                <select
                  aria-label={t("packages.install.configValue")}
                  className="h-8 rounded-md border border-border bg-background px-2 text-xs"
                  disabled={applying}
                  onChange={(event) => {
                    const value = event.target.value;
                    editRows((held) =>
                      held.map((entry) =>
                        entry.id === row.id ? { ...entry, value } : entry,
                      ),
                    );
                  }}
                  value={row.value === "false" ? "false" : "true"}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  aria-label={t("packages.install.configValue")}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
                  disabled={applying}
                  onChange={(event) => {
                    const value = event.target.value;
                    editRows((held) =>
                      held.map((entry) =>
                        entry.id === row.id ? { ...entry, value } : entry,
                      ),
                    );
                  }}
                  value={row.value}
                />
              )}
              <Button
                aria-label={t("packages.install.removeConfigField")}
                disabled={applying}
                onClick={() =>
                  editRows((held) =>
                    held.filter((entry) => entry.id !== row.id),
                  )
                }
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                ×
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <WbSecondaryButton
        className="mt-2"
        disabled={applying}
        onClick={() =>
          editRows((held) => [
            ...held,
            { id: nextRowId(), key: "", value: "", type: "string" },
          ])
        }
        type="button"
      >
        {t("packages.install.addConfigField")}
      </WbSecondaryButton>
      {configError !== null ? (
        <p className="mt-2 text-destructive text-xs" role="alert">
          {configError}
        </p>
      ) : null}
    </section>
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent className="max-w-[680px] gap-0 rounded-2xl p-6">
        <DialogHeader>
          <DialogTitle>
            {t("packages.install.title", { name: subject.displayName })}
          </DialogTitle>
          <DialogDescription>
            {t("packages.install.description", { team: scope.workspaceId })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 gap-5">
          {installed !== null ? (
            <PackageInstallFacts install={installed} />
          ) : (
            <>
              {plan !== null ? (
                <>
                  <WbStatsRow
                    stats={[
                      {
                        value: scope.workspaceId,
                        label: t("packages.install.team"),
                      },
                      {
                        value: plan.version,
                        label: t("packages.install.version"),
                      },
                      {
                        value: String(plan.resources.length),
                        label: t("packages.install.resourceCount"),
                      },
                    ]}
                  />
                  <WbIdRow
                    id={plan.packageKey}
                    label={t("packages.install.packageKey")}
                  />
                  <WbIdRow
                    id={plan.artifactDigest}
                    label={t("packages.install.digest")}
                  />
                  <p className="text-xs leading-5 text-foreground/50">
                    {expiryTime === null
                      ? t("packages.install.expiryUnknown")
                      : t("packages.install.expiry", { time: expiryTime })}
                  </p>
                  <section>
                    <h3 className="text-sm font-medium text-foreground">
                      {t("packages.install.resources")}
                    </h3>
                    <ul className="mt-2 flex flex-col gap-2">
                      {plan.resources.map((resource) => (
                        <li
                          className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2"
                          key={resource.id}
                        >
                          <WbTag>
                            {t(packageResourceKindKey(resource.kind))}
                          </WbTag>
                          <code className="min-w-0 truncate font-mono text-xs text-foreground/70">
                            {resource.id}
                          </code>
                        </li>
                      ))}
                    </ul>
                  </section>
                  <section>
                    <h3 className="text-sm font-medium text-foreground">
                      {t("packages.install.tools")}
                    </h3>
                    {plan.addedTools.length === 0 ? (
                      <p className="mt-2 text-sm text-foreground/50">
                        {t("packages.install.noTools")}
                      </p>
                    ) : (
                      <ul className="mt-2 flex flex-col gap-2">
                        {plan.addedTools.map((tool) => (
                          <li
                            className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2"
                            key={tool.ref}
                          >
                            <code className="min-w-0 truncate font-mono text-xs text-foreground/70">
                              {tool.ref}
                            </code>
                            <WbTag className="ml-auto">
                              {t(
                                tool.effect === "write"
                                  ? "packages.install.toolEffect.write"
                                  : "packages.install.toolEffect.read",
                              )}
                            </WbTag>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  {plan.blockers.length > 0 ? (
                    <section>
                      <h3 className="text-sm font-medium text-foreground">
                        {t("packages.install.blockers")}
                      </h3>
                      <div className="mt-2">
                        <PackageBlockerList blockers={plan.blockers} />
                      </div>
                    </section>
                  ) : null}
                  <p className="text-xs leading-5 text-foreground/60">
                    {t("packages.install.previewGrantNotice")}
                  </p>
                </>
              ) : planning ? (
                <p className="text-sm text-foreground/50">
                  {t("packages.install.creating")}
                </p>
              ) : null}

              {configEditor}

              {planError !== null ? (
                <div className="flex flex-col items-start gap-2" role="alert">
                  <p className="text-destructive text-sm">{planError}</p>
                  <WbSecondaryButton onClick={startPlan} type="button">
                    {t("packages.install.retryPreview")}
                  </WbSecondaryButton>
                </div>
              ) : null}

              {applyError !== null ? (
                <p className="text-destructive text-sm" role="alert">
                  {applyError}
                </p>
              ) : null}

              {plan === null && !planning && planError === null ? (
                <WbSecondaryButton onClick={startPlan} type="button">
                  {t("packages.install.previewAction")}
                </WbSecondaryButton>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          {installed !== null ? (
            <Button onClick={onClose} type="button">
              {t("packages.install.close")}
            </Button>
          ) : (
            <>
              <WbSecondaryButton onClick={onClose} type="button">
                {t("packages.install.close")}
              </WbSecondaryButton>
              {plan !== null ? (
                <Button
                  disabled={planning || applying}
                  onClick={confirm}
                  type="button"
                >
                  {applying
                    ? t("packages.install.confirming")
                    : t("packages.install.confirm")}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
