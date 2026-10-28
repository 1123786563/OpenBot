import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { companyConfigQueryOptions } from "@/lib/enterprise/tenant/company-admin";
import {
  companyCommandAdapter,
  type DirectoryFailureKind,
  type DirectoryScope,
  directoryFailureKind,
} from "@/lib/enterprise/tenant/directory";
import {
  selectionKeys,
  type WorkspaceScopeCompany,
} from "@/lib/enterprise/tenant/selection";

/*
 * The fixed registry's company profile cards (T04.09), OpenBot's adaptation of the pinned
 * source's src/components/organization/organization-settings-cards.tsx.
 *
 * WHAT THIS CARD WILL NOT DO. The pinned source's settings cards suspend, delete and impersonate
 * through the native client; here those controls do not exist — the status row is read-only text
 * (from the admin-gated config projection, asked for only when the listing's capabilities say
 * this member manages the company, so a plain member's page issues no gated read at all), and
 * closing a company is a reviewed platform request, stated as a sentence rather than a button.
 * The one write is the profile: name, slug and logo, through the Directory command adapter, and
 * only when the listing row both carries the BA binding and names `company:manage`. A legacy row
 * (no binding fields) renders the read-only profile it always did.
 */
export function OrganizationSettingsCards({
  scope,
  company,
}: {
  scope: DirectoryScope;
  company: WorkspaceScopeCompany;
}): ReactElement {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const nameId = useId();
  const slugId = useId();
  const logoId = useId();

  // The listing's own capability answer decides (interfaces §4): derived from the member's role
  // row by the server, carried here verbatim. The binding field is the write's address — a
  // legacy row has none, so no control for it can render.
  const canWrite =
    company.organizationId !== undefined &&
    (company.capabilities ?? []).includes("company:manage");

  const config = useQuery({
    ...companyConfigQueryOptions(queryClient, scope),
    // A member the listing does not call a company manager asks for no admin-gated read.
    enabled: canWrite,
  });

  const [name, setName] = useState(company.name);
  const [slug, setSlug] = useState("");
  const [logo, setLogo] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<DirectoryFailureKind | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (failure !== null) alertRef.current?.focus();
  }, [failure]);

  const save = async () => {
    setPending(true);
    setFailure(null);
    try {
      await companyCommandAdapter(company).updateProfile({
        name,
        slug,
        logo,
      });
      // The profile the listing shows (the switcher's face) and this scope's answers both move.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: selectionKeys.listing(scope.userId),
        }),
        queryClient.invalidateQueries({ queryKey: scope.prefix }),
      ]);
    } catch (error) {
      setFailure(directoryFailureKind(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <PageSection
      title={t("organization.profile.title")}
      description={t("organization.profile.description")}
    >
      {canWrite ? (
        <div className="mt-4 max-w-sm space-y-4">
          <div className="space-y-2">
            <Label htmlFor={nameId}>{t("organization.profile.name")}</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={slugId}>{t("organization.profile.slug")}</Label>
            <Input
              id={slugId}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={logoId}>{t("organization.profile.logo")}</Label>
            <Input
              id={logoId}
              value={logo}
              onChange={(event) => setLogo(event.target.value)}
              autoComplete="off"
            />
          </div>
          <Button size="sm" disabled={pending} onClick={() => void save()}>
            {t("organization.profile.save")}
          </Button>
        </div>
      ) : (
        <div className="mt-4 max-w-prose space-y-2">
          <p className="text-sm">
            <span className="text-muted-foreground">
              {t("organization.profile.name")}
              {": "}
            </span>
            {company.name}
          </p>
          <p className="text-muted-foreground text-sm">
            {t("organization.profile.readOnly")}
          </p>
        </div>
      )}
      <p className="mt-6 max-w-prose text-sm">
        <span className="text-muted-foreground">
          {t("organization.profile.status")}
          {": "}
        </span>
        {canWrite && config.data !== undefined
          ? config.data.status
          : t("organization.profile.statusUnavailable")}
      </p>
      <p className="mt-1 max-w-prose text-muted-foreground text-sm">
        {t("organization.profile.statusReadOnly")}
      </p>
      <p className="mt-4 max-w-prose text-muted-foreground text-sm">
        {t("organization.profile.deletion")}
      </p>
      {failure !== null ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="mt-4 max-w-prose rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm outline-none"
        >
          {t(`organization.profile.${failure}`)}
        </div>
      ) : null}
    </PageSection>
  );
}
