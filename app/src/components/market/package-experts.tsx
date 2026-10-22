import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { WbIdRow, WbSecondaryButton, WbTag } from "@/components/market/wb";
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
import { useInstantiateExpert } from "@/lib/plugin-packages/mutations";
import {
  type PluginPackageScope,
  pluginPackageInstallDetailQueryOptions,
} from "@/lib/plugin-packages/queries";
import {
  PACKAGE_EXPERT_TEMPLATE_LIMITS,
  type PackageExpertCreatedDTO,
  type PackageInstallDTO,
} from "../../../../shared/enterprise/plugin-package-contracts";
import type { PackageDetailSubject } from "./package-detail";

/**
 * The expert-creation section of the install detail, PKG04 slice B.
 *
 * WHAT CREATION IS. Each `expertTemplate` resource of the installed revision can become one Bot
 * of this team: a wizard dialog collects the display name and shows the profile READ-ONLY — not
 * as values but as its source (the server pins the summary/system prompt from the installed
 * revision's VERIFIED template file, whose content never crosses the wire) — while the POST
 * carries ONLY identity + CAS revision + name — the server writes the Bot's profile from that
 * template file and derives creator and ownership
 * from the trusted scope, so no owner/scope field exists anywhere in this UI and no connector,
 * account or publishing affordance ever appears. Creation grants exactly the skills the template
 * declares (`PackageExpertTemplateSchema.skills`) — a subset of the installed revision's skill
 * resources. The wire contract's resource summaries carry no template→skill mapping, so the
 * client cannot enumerate the granted subset in advance: the wizard lists the revision's skill
 * resources as the superset, states the subset rule, and the success view shows the server's
 * actual granted set (`PackageExpertCreatedDTO.resources`). Installing alone grants no
 * capability.
 *
 * THE IDEMPOTENCY KEY IS PER INTENT, not per attempt: it is generated once when the dialog opens
 * and reused for every retry of the same creation, so a retry after an ambiguous failure can
 * never create a second Bot (the server replays the same agentId or refuses with a 409).
 *
 * SUCCESS NAMES THE BOT: the created agentId is shown as copyable text with a link to the Bot's
 * own detail route (`/bots/$agentId` exists in the route tree). The created Bot later behaves
 * like any other Bot — a package upgrade or uninstall never rewrites it.
 */

/** One key per dialog open; UUID where the runtime offers it, an ASCII fallback otherwise. */
function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `pkg-expert-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function statusOf(error: unknown): number | null {
  return error instanceof ClientResponseError ? error.status : null;
}

/** The server's own refusal sentence, when the transport captured one. */
function serverMessageOf(error: unknown): string | null {
  return error instanceof ClientResponseError ? error.serverMessage : null;
}

/**
 * The wizard dialog for one expertTemplate resource. Opens with an idempotency key that lives as
 * long as the dialog does, the editable display-name draft, the READ-ONLY profile block, and the
 * read-only list of the installed revision's skill resources — the superset the template's
 * granted subset is declared from.
 *
 * THE PROFILE BLOCK NAMES ITS SOURCE instead of echoing profile values: the server writes the
 * created Bot's summary and system prompt from the installed revision's VERIFIED template file,
 * and that content never crosses the wire (the resource summaries carry no template fields and
 * no template-content read endpoint exists). The list row's display summary is a DIFFERENT
 * string — the package's marketing copy — so showing it here would misrepresent what the server
 * will write. The block therefore renders the same packageKey/resourceId ref the server's
 * provenance records, read from this dialog's own install-detail query; when that read stops
 * declaring the template (revision drift mid-dialog), it says so instead of substituting copy.
 */
function ExpertWizardDialog({
  scope,
  install,
  resourceId,
  subject,
  onClose,
}: {
  scope: PluginPackageScope;
  install: PackageInstallDTO;
  resourceId: string;
  subject: PackageDetailSubject;
  onClose: () => void;
}) {
  const { t } = useTranslation("market");
  const queryClient = useQueryClient();
  const detail = useQuery(
    pluginPackageInstallDetailQueryOptions(scope, install.installId),
  );
  const expertMutation = useInstantiateExpert(queryClient);

  // One key per dialog open, reused on every retry of this creation intent.
  const [idempotencyKey] = React.useState(newIdempotencyKey);
  const [nameDraft, setNameDraft] = React.useState(subject.displayName);
  const [error, setError] = React.useState<string | null>(null);

  const expert: PackageExpertCreatedDTO | undefined = expertMutation.data;
  const skillResources =
    detail.data?.resources.filter((resource) => resource.kind === "skill") ??
    [];
  // The profile display's source, from the same install-detail read the section listed this
  // wizard from: the expertTemplate resource of the installed revision. The ref it names —
  // packageKey/resourceId — is exactly the `expertTemplateRef` the server records when the
  // creation writes the profile from the verified template file.
  const templateResource = detail.data?.resources.find(
    (resource) =>
      resource.kind === "expertTemplate" && resource.id === resourceId,
  );
  const templateRef = `${install.packageKey}/${resourceId}`;
  const canSubmit = nameDraft.trim() !== "" && !expertMutation.isPending;

  const submit = () => {
    if (!canSubmit) return;
    setError(null);
    expertMutation.mutate(
      {
        scope,
        installId: install.installId,
        resourceId,
        expectedRevision: install.revision,
        name: nameDraft,
        idempotencyKey,
      },
      {
        onError: (mutationError) => {
          const status = statusOf(mutationError);
          const serverMessage = serverMessageOf(mutationError);
          // 400 (TEMPLATE_FIELD_REJECTED, INPUT_INVALID) and 409 (IDEMPOTENCY_CONFLICT,
          // REVISION_CONFLICT, PLAN_CHANGED) carry the contract's own sentences — they surface
          // verbatim so the refusal names the exact wire verdict.
          if (status === 403) {
            setError(t("packages.experts.forbidden"));
          } else if (status === 503) {
            setError(t("packages.experts.unavailable"));
          } else {
            setError(serverMessage ?? t("packages.experts.error"));
          }
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
          <DialogTitle>{t("packages.experts.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("packages.experts.dialogDescription", { resource: resourceId })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 gap-4">
          {expert ? (
            <>
              <p className="text-sm font-medium text-foreground">
                {t("packages.experts.successTitle")}
              </p>
              <WbIdRow
                id={expert.agentId}
                label={t("packages.experts.agentIdLabel")}
              />
              {/* The server's receipt is the granted set's authority: exactly the skills the
               * template declared, which the wizard could only describe as a subset up front. */}
              {expert.resources.length > 0 ? (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="text-xs leading-5 text-foreground/50">
                    {t("packages.experts.grantedSkillsLabel")}
                  </legend>
                  <ul className="flex flex-wrap gap-1.5">
                    {expert.resources.map((resource) => (
                      <li key={resource.resourceId}>
                        <WbTag>
                          <code className="font-mono">
                            {resource.resourceId}
                          </code>
                        </WbTag>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ) : null}
              <p className="text-xs leading-5 text-foreground/60">
                {t("packages.experts.successHint")}
              </p>
              {/* The Bot detail route exists (`/bots/$agentId`), so creation hands off there —
               * through the router's own Link (the agent-card.tsx pattern), keeping the handoff
               * a client-side navigation instead of a full page reload. */}
              <div>
                <Button
                  render={
                    <Link
                      params={{ agentId: expert.agentId }}
                      to="/bots/$agentId"
                    />
                  }
                >
                  {t("packages.experts.openBot")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t("packages.experts.nameLabel")}
                </span>
                <input
                  aria-label={t("packages.experts.nameLabel")}
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                  disabled={expertMutation.isPending}
                  maxLength={PACKAGE_EXPERT_TEMPLATE_LIMITS.maxNameLength}
                  onChange={(event) => setNameDraft(event.target.value)}
                  placeholder={t("packages.experts.namePlaceholder")}
                  value={nameDraft}
                />
              </label>
              {/* READ-ONLY profile display, sourced from the install detail's expertTemplate
               * resource — the same source the server writes the profile from. No edit
               * affordance exists and nothing but the name ever travels on the wire. */}
              {templateResource ? (
                <div className="flex flex-col gap-1.5 rounded-lg bg-foreground/[0.03] px-3 py-2">
                  <span className="text-xs font-medium text-foreground">
                    {t("packages.experts.profileLabel")}
                  </span>
                  <p className="text-xs leading-5 text-foreground/60">
                    {t("packages.experts.profileSource")}
                  </p>
                  <code className="min-w-0 truncate font-mono text-xs text-foreground/80">
                    {templateRef}
                  </code>
                </div>
              ) : (
                /* The read no longer declares this template (revision drift mid-dialog, or the
                 * read is not answered yet): the block says so rather than substituting the
                 * list row's display copy. The server re-validates the template on its side. */
                <p className="text-xs leading-5 text-foreground/50">
                  {t("packages.experts.profileFallback")}
                </p>
              )}
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-xs leading-5 text-foreground/50">
                  {t("packages.experts.skillsLabel")}
                </legend>
                {skillResources.length === 0 ? (
                  <p className="text-xs leading-5 text-foreground/50">
                    {t("packages.experts.noSkills")}
                  </p>
                ) : (
                  <>
                    <ul className="flex flex-wrap gap-1.5">
                      {skillResources.map((resource) => (
                        <li key={resource.id}>
                          <WbTag>
                            <code className="font-mono">{resource.id}</code>
                          </WbTag>
                        </li>
                      ))}
                    </ul>
                    {/* The template's declared subset is server-side knowledge (the resource
                     * summaries carry no template→skill mapping), so the wizard names the rule
                     * instead of enumerating a grant it cannot see yet. */}
                    <p className="text-xs leading-5 text-foreground/50">
                      {t("packages.experts.skillsSubsetNote")}
                    </p>
                  </>
                )}
              </fieldset>
              {error !== null ? (
                <p className="text-destructive text-xs" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </DialogBody>
        {expert ? null : (
          <DialogFooter className="mt-4">
            <WbSecondaryButton
              disabled={!canSubmit}
              onClick={submit}
              type="button"
            >
              {expertMutation.isPending
                ? t("packages.experts.creating")
                : t("packages.experts.create")}
            </WbSecondaryButton>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The per-template creation section. Renders nothing at all when the installed revision declares
 * no expertTemplate resource — no heading, no shell, no requests beside the shared detail read.
 */
export function PackageExpertsSection({
  scope,
  install,
  subject,
}: {
  scope: PluginPackageScope;
  install: PackageInstallDTO;
  subject: PackageDetailSubject;
}) {
  const { t } = useTranslation("market");
  const detail = useQuery(
    pluginPackageInstallDetailQueryOptions(scope, install.installId),
  );
  const [wizardResource, setWizardResource] = React.useState<string | null>(
    null,
  );

  if (detail.isPending) {
    return (
      <section aria-label={t("packages.experts.title")}>
        <h3 className="text-sm font-medium text-foreground">
          {t("packages.experts.title")}
        </h3>
        <p className="mt-2 text-sm text-foreground/50">
          {t("packages.experts.loading")}
        </p>
      </section>
    );
  }

  if (detail.isError || detail.data === undefined) {
    return (
      <section aria-label={t("packages.experts.title")}>
        <h3 className="text-sm font-medium text-foreground">
          {t("packages.experts.title")}
        </h3>
        <div className="mt-2 flex flex-col items-start gap-2" role="alert">
          <p className="text-destructive text-sm">
            {t("packages.experts.loadError")}
          </p>
          <WbSecondaryButton
            onClick={() => void detail.refetch()}
            type="button"
          >
            {t("packages.experts.retry")}
          </WbSecondaryButton>
        </div>
      </section>
    );
  }

  const expertTemplates = detail.data.resources.filter(
    (resource) => resource.kind === "expertTemplate",
  );
  if (expertTemplates.length === 0) return null;

  return (
    <section aria-label={t("packages.experts.title")}>
      <h3 className="text-sm font-medium text-foreground">
        {t("packages.experts.title")}
      </h3>
      <p className="mt-1 text-xs leading-5 text-foreground/50">
        {t("packages.experts.hint")}
      </p>
      <ul
        aria-label={t("packages.experts.title")}
        className="mt-2 flex flex-col gap-2"
      >
        {expertTemplates.map((resource) => (
          <li
            className="flex flex-wrap items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2"
            key={resource.id}
          >
            <code className="min-w-0 truncate font-mono text-xs text-foreground/80">
              {resource.id}
            </code>
            <WbSecondaryButton
              aria-label={t("packages.experts.createAria", {
                resource: resource.id,
              })}
              className="ml-auto"
              onClick={() => setWizardResource(resource.id)}
              type="button"
            >
              {t("packages.experts.createFromTemplate")}
            </WbSecondaryButton>
          </li>
        ))}
      </ul>
      {wizardResource !== null ? (
        <ExpertWizardDialog
          install={install}
          onClose={() => setWizardResource(null)}
          resourceId={wizardResource}
          scope={scope}
          subject={subject}
        />
      ) : null}
    </section>
  );
}
