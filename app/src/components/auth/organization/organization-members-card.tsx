import { useQueryClient } from "@tanstack/react-query";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type DirectoryFailureKind,
  type DirectoryScope,
  directoryFailureKind,
  scopedTeamCommandAdapter,
} from "@/lib/enterprise/tenant/directory";
/*
 * The fixed registry's team members card (T04.09), OpenBot's adaptation of the pinned source's
 * src/components/organization/organization-members-card.tsx.
 *
 * THE ONE SURFACE A SCOPED TEAM MANAGER GETS. The two commands here are the scoped team routes
 * T04.08 owns, addressed by the OpenBot principalId the person types — never a BA member id, and
 * never a company-role or organization write: this card composes `scopedTeamCommandAdapter` and
 * nothing else, so a grant-holding plain member's page can only add and remove members of the
 * selected team. Who may actually do that is the server's call (company-role|team-grant, checked
 * inside the route, fail-closed); a refusal arrives as a status and becomes the recoverable
 * sentence with the focus on it. Roles and team-manager grants stay where T04.07 put them — a
 * note says so; no control here names them.
 */
export function OrganizationMembersCard({
  scope,
}: {
  scope: DirectoryScope;
}): ReactElement {
  const { t } = useTranslation("company-admin");
  const queryClient = useQueryClient();
  const principalIdId = useId();
  const [principalId, setPrincipalId] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<DirectoryFailureKind | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (failure !== null) alertRef.current?.focus();
  }, [failure]);

  const run = async (operation: "add" | "remove") => {
    const id = principalId.trim();
    if (id === "") return;
    setPending(true);
    setFailure(null);
    try {
      const adapter = scopedTeamCommandAdapter(scope);
      if (operation === "add") {
        await adapter.addMember(id);
      } else {
        await adapter.removeMember(id);
      }
      setPrincipalId("");
      // The scope's subtree answers for this team's facts; the next read asks again.
      await queryClient.invalidateQueries({ queryKey: scope.prefix });
    } catch (error) {
      setFailure(directoryFailureKind(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <PageSection
      title={t("organization.team.title")}
      description={t("organization.team.description")}
    >
      <div className="mt-4 max-w-sm space-y-2">
        <Label htmlFor={principalIdId}>
          {t("organization.team.principalId")}
        </Label>
        <Input
          id={principalIdId}
          value={principalId}
          onChange={(event) => setPrincipalId(event.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={pending || principalId.trim() === ""}
          onClick={() => void run("add")}
        >
          {t("organization.team.add")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || principalId.trim() === ""}
          onClick={() => void run("remove")}
        >
          {t("organization.team.remove")}
        </Button>
      </div>
      <p className="mt-3 max-w-prose text-muted-foreground text-sm">
        {t("organization.team.rolesNote")}
      </p>
      {failure !== null ? (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="mt-4 max-w-prose rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm outline-none"
        >
          {t(`organization.team.${failure}`)}
        </div>
      ) : null}
    </PageSection>
  );
}
