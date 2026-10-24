import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { WbSecondaryButton, WbTag } from "@/components/market/wb";
import { ClientResponseError } from "@/lib/client";
import {
  usePackageGrant,
  usePackageGrantRevoke,
} from "@/lib/plugin-packages/mutations";
import {
  type PluginPackageScope,
  pluginPackageInstallDetailQueryOptions,
} from "@/lib/plugin-packages/queries";
import type { PackageInstallDTO } from "../../../../shared/enterprise/plugin-package-contracts";

/**
 * The Bot grant management section of the install detail, PKG03 slice C.
 *
 * WHAT A GRANT IS. Installing a package grants nothing ("安装≠授权"); a grant is what authorizes
 * ONE Bot to use the install's pinned skill resources in runs. This section draws the
 * install's active grants (per Bot, with its revision) and the two verbs that change them: grant
 * skill resources of the CURRENT revision to a Bot, and revoke. The server re-authorizes every
 * write and derives the scope from the trusted headers; this screen only ever hides verbs.
 *
 * SUPERSEDE SEMANTICS drive the form. A grant PUT replaces the Bot's whole resource set — the
 * server revokes the active rows and writes the new set at the next generation — so when the
 * typed Bot already holds a grant its resources arrive pre-selected, and granting can never
 * silently revoke something the administrator did not see. The CAS target travels with the write:
 * the revision this screen read, or null for a first grant.
 *
 * THE BOT IS NAMED BY ID, not picked from a roster: the package surface has no Bot-roster read,
 * and the server answers unknown and cross-team bots with one identical 404.
 */

/** One key per attempt; UUID where the runtime offers it, an ASCII fallback otherwise. */
function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `pkg-grant-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function statusOf(error: unknown): number | null {
  return error instanceof ClientResponseError ? error.status : null;
}

/** The server's own refusal sentence, when the transport captured one. */
function serverMessageOf(error: unknown): string | null {
  return error instanceof ClientResponseError ? error.serverMessage : null;
}

export function PackageGrantsSection({
  scope,
  install,
}: {
  scope: PluginPackageScope;
  install: PackageInstallDTO;
}) {
  const { t } = useTranslation("market");
  const queryClient = useQueryClient();
  const detail = useQuery(
    pluginPackageInstallDetailQueryOptions(scope, install.installId),
  );
  const grantMutation = usePackageGrant(queryClient);
  const revokeMutation = usePackageGrantRevoke(queryClient);

  const [botIdDraft, setBotIdDraft] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [error, setError] = React.useState<string | null>(null);
  const trimmedBotId = botIdDraft.trim();

  const skillResources =
    detail.data?.resources.filter((resource) => resource.kind === "skill") ??
    [];
  /*
   * PKG05 (#464): connector resources and the tools their CURRENT revision
   * declares. A connector grant is exact per tool (never "this connector"),
   * so the form offers each declared tool by ref and the server re-derives
   * the schema digest/effect from the same manifest.
   */
  const connectorResources =
    detail.data?.resources.filter(
      (resource) => resource.kind === "managedConnector" && resource.available,
    ) ?? [];
  const [selectedTools, setSelectedTools] = React.useState<ReadonlySet<string>>(
    new Set(),
  );

  const activeGrant =
    detail.data?.grants.find((grant) => grant.botId === trimmedBotId) ?? null;

  /*
   * The selection follows the named Bot's active grant — but the reseed is keyed on the
   * grant's IDENTITY, never on object references: the Bot id, the typed Bot's own grant
   * revision (the contract's CAS counter — every committed grant or revoke of THAT Bot
   * moves it), the granted resource ids, and the install's generation. A refetch that
   * merely produces a new `detail.data` object — the invalidation ANOTHER Bot's grant,
   * revoke or expert creation triggers, a window refocus — changes none of them, so a
   * form in progress keeps its checked boxes. When the typed Bot's own grant identity
   * does change, the form re-syncs with what the server now reports, and typing a
   * different Bot reseeds from scratch.
   */
  const activeGrantRevision = activeGrant?.revision ?? null;
  const installGeneration = detail.data?.generation ?? null;
  const activeResourceKey =
    activeGrant === null
      ? ""
      : activeGrant.resources
          .map((resource) => resource.resourceId)
          .sort()
          .join("\u0000");
  const activeToolKey =
    activeGrant === null
      ? ""
      : activeGrant.resources
          .flatMap((resource) => resource.toolRefs ?? [])
          .sort()
          .join("\u0000");

  // biome-ignore lint/correctness/useExhaustiveDependencies: the three unread deps are the reseed SIGNAL, not reads — the body draws only the resource ids, but a new Bot id must clear the previous Bot's draft even when neither holds a grant, an install generation bump must reseed even when the granted set looks unchanged, and object references (the old `detail.data` dep) are deliberately absent: they change on every refetch and wiped in-progress selections for Bots whose own grant never moved.
  React.useEffect(() => {
    setSelected(
      new Set(
        activeResourceKey === "" ? [] : activeResourceKey.split("\u0000"),
      ),
    );
    // A tool grant's own selection: connector resources carry their granted
    // tool refs, reseeded on the same identity signal.
    setSelectedTools(
      new Set(activeToolKey === "" ? [] : activeToolKey.split("\u0000")),
    );
  }, [
    trimmedBotId,
    activeGrantRevision,
    activeResourceKey,
    activeToolKey,
    installGeneration,
  ]);

  const grantPending = grantMutation.isPending;
  const revokePending = revokeMutation.isPending;
  const canSubmit =
    trimmedBotId !== "" &&
    (selected.size > 0 || selectedTools.size > 0) &&
    !grantPending &&
    !revokePending;

  const submitGrant = () => {
    if (!canSubmit) return;
    setError(null);
    grantMutation.mutate(
      {
        scope,
        installId: install.installId,
        botId: trimmedBotId,
        expectedGrantRevision: activeGrant?.revision ?? null,
        resources: [
          ...skillResources
            .filter((resource) => selected.has(resource.id))
            .map((resource) => ({
              resourceId: resource.id,
              kind: "skill" as const,
            })),
          ...connectorResources
            .map((resource) => ({
              resourceId: resource.id,
              kind: "managedConnector" as const,
              toolRefs: (resource.tools ?? [])
                .map((tool) => tool.ref)
                .filter((ref) => selectedTools.has(ref)),
            }))
            .filter((resource) => resource.toolRefs.length > 0),
        ],
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onError: (mutationError) => {
          const status = statusOf(mutationError);
          const serverMessage = serverMessageOf(mutationError);
          if (status === 403) {
            setError(t("packages.grants.grantForbidden"));
          } else if (status === 409) {
            setError(t("packages.grants.grantConflict"));
          } else {
            setError(serverMessage ?? t("packages.grants.grantError"));
          }
        },
      },
    );
  };

  const revoke = (botId: string, expectedGrantRevision: number) => {
    setError(null);
    revokeMutation.mutate(
      {
        scope,
        installId: install.installId,
        botId,
        expectedGrantRevision,
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onError: (mutationError) => {
          const status = statusOf(mutationError);
          const serverMessage = serverMessageOf(mutationError);
          if (status === 403) {
            setError(t("packages.grants.revokeForbidden"));
          } else if (status === 409) {
            setError(t("packages.grants.revokeConflict"));
          } else {
            setError(serverMessage ?? t("packages.grants.revokeError"));
          }
        },
      },
    );
  };

  if (detail.isPending) {
    return (
      <section aria-label={t("packages.grants.title")}>
        <h3 className="text-sm font-medium text-foreground">
          {t("packages.grants.title")}
        </h3>
        <p className="mt-2 text-sm text-foreground/50">
          {t("packages.grants.loading")}
        </p>
      </section>
    );
  }

  if (detail.isError || detail.data === undefined) {
    return (
      <section aria-label={t("packages.grants.title")}>
        <h3 className="text-sm font-medium text-foreground">
          {t("packages.grants.title")}
        </h3>
        <div className="mt-2 flex flex-col items-start gap-2" role="alert">
          <p className="text-destructive text-sm">
            {t("packages.grants.loadError")}
          </p>
          <WbSecondaryButton
            onClick={() => void detail.refetch()}
            type="button"
          >
            {t("packages.grants.retry")}
          </WbSecondaryButton>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t("packages.grants.title")}>
      <h3 className="text-sm font-medium text-foreground">
        {t("packages.grants.title")}
      </h3>
      <p className="mt-1 text-xs leading-5 text-foreground/50">
        {t("packages.grants.hint")}
      </p>

      {detail.data.grants.length === 0 ? (
        <p className="mt-2 text-xs leading-5 text-foreground/60">
          {t("packages.grants.empty")}
        </p>
      ) : (
        <ul
          aria-label={t("packages.grants.title")}
          className="mt-2 flex flex-col gap-2"
        >
          {detail.data.grants.map((grant) => (
            <li
              className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2"
              key={grant.botId}
            >
              <code className="min-w-0 truncate font-mono text-xs text-foreground/80">
                {grant.botId}
              </code>
              {grant.resources.map((resource) =>
                resource.kind === "managedConnector" ? (
                  <code
                    className="min-w-0 truncate font-mono text-foreground/50 text-xs"
                    key={resource.resourceId}
                  >
                    {`${resource.resourceId} · ${(resource.toolRefs ?? []).join(", ")}`}
                  </code>
                ) : (
                  <code
                    className="min-w-0 truncate font-mono text-foreground/50 text-xs"
                    key={resource.resourceId}
                  >
                    {resource.resourceId}
                  </code>
                ),
              )}
              <WbTag className="ml-auto">{`r${grant.revision}`}</WbTag>
              <WbSecondaryButton
                aria-label={t("packages.grants.revokeAria", {
                  bot: grant.botId,
                })}
                disabled={revokePending || grantPending}
                onClick={() => revoke(grant.botId, grant.revision)}
                type="button"
              >
                {revokePending
                  ? t("packages.grants.revoking")
                  : t("packages.grants.revoke")}
              </WbSecondaryButton>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-col gap-2 rounded-xl bg-foreground/[0.03] p-3">
        <h4 className="text-xs font-medium text-foreground">
          {t("packages.grants.formTitle")}
        </h4>
        <input
          aria-label={t("packages.grants.botIdLabel")}
          className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs"
          disabled={grantPending || revokePending}
          onChange={(event) => setBotIdDraft(event.target.value)}
          placeholder={t("packages.grants.botIdPlaceholder")}
          value={botIdDraft}
        />
        {skillResources.length === 0 ? (
          <p className="text-xs leading-5 text-foreground/50">
            {t("packages.grants.noSkills")}
          </p>
        ) : (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs leading-5 text-foreground/50">
              {t("packages.grants.skillsLabel")}
            </legend>
            {skillResources.map((resource) => (
              <label
                className="flex items-center gap-2 text-xs text-foreground/70"
                key={resource.id}
              >
                <input
                  aria-label={resource.id}
                  checked={selected.has(resource.id)}
                  disabled={grantPending || revokePending}
                  onChange={(event) => {
                    setSelected((held) => {
                      const next = new Set(held);
                      if (event.target.checked) {
                        next.add(resource.id);
                      } else {
                        next.delete(resource.id);
                      }
                      return next;
                    });
                  }}
                  type="checkbox"
                />
                <code className="min-w-0 truncate font-mono">
                  {resource.id}
                </code>
              </label>
            ))}
          </fieldset>
        )}
        {connectorResources.length > 0 ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs leading-5 text-foreground/50">
              {t("packages.grants.toolsLabel")}
            </legend>
            {connectorResources.map((resource) => (
              <div className="flex flex-col gap-1" key={resource.id}>
                <code className="font-mono text-xs text-foreground/70">
                  {resource.id}
                </code>
                {(resource.tools ?? []).length === 0 ? (
                  <p className="text-xs text-foreground/50">
                    {t("packages.grants.noConnectorTools")}
                  </p>
                ) : (
                  (resource.tools ?? []).map((tool) => (
                    <label
                      className="ml-3 flex items-center gap-2 text-xs text-foreground/70"
                      key={tool.ref}
                    >
                      <input
                        aria-label={tool.ref}
                        checked={selectedTools.has(tool.ref)}
                        disabled={grantPending || revokePending}
                        onChange={(event) => {
                          setSelectedTools((held) => {
                            const next = new Set(held);
                            if (event.target.checked) {
                              next.add(tool.ref);
                            } else {
                              next.delete(tool.ref);
                            }
                            return next;
                          });
                        }}
                        type="checkbox"
                      />
                      <code className="min-w-0 truncate font-mono">
                        {tool.ref}
                      </code>
                      <span className="text-foreground/40">{tool.effect}</span>
                    </label>
                  ))
                )}
              </div>
            ))}
          </fieldset>
        ) : null}
        <div className="flex items-center gap-3">
          <WbSecondaryButton
            disabled={!canSubmit}
            onClick={submitGrant}
            type="button"
          >
            {grantPending
              ? t("packages.grants.granting")
              : t("packages.grants.grant")}
          </WbSecondaryButton>
        </div>
        {error !== null ? (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
