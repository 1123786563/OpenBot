import { IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useRef } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";

export function CredentialsPage() {
  const paths = useManagePaths();
  const addButton = useRef<HTMLAnchorElement>(null);
  const { requestConfirmation, confirmation } = useActionConfirmation();
  // Called Keys in the personal edition, which links here from Connections too.
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const revokeCredential = useMutation(
    revokeCredentialMutationOptions(queryClient),
  );

  return (
    <PageShell
      action={
        // Its own screen, `credentials_.new.tsx`, which says why the form is not on this page.
        <Button
          render={(props) => (
            <Link {...props} {...paths.newCredential()} ref={addButton} />
          )}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          Add credential
        </Button>
      }
      description={
        personal
          ? "API keys and tokens your apps and models use. A saved key can't be viewed again."
          : "Manage this deployment’s keys and tokens. Saved secrets cannot be viewed again."
      }
      title={paths.credentialsLabel}
    >
      <PageSection title="Saved credentials">
        {confirmation}
        {credentials.isPending ? (
          <p role="status">Loading credentials…</p>
        ) : credentials.error && !credentials.data ? (
          <>
            <p className="mt-4 text-destructive text-sm" role="alert">
              Couldn't load credentials.
            </p>
            <Button
              onClick={() => void credentials.refetch()}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </>
        ) : credentials.data?.length === 0 ? (
          <PageEmpty
            action={
              <Button
                render={(props) => (
                  <Link {...props} {...paths.newCredential()} />
                )}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add credential
              </Button>
            }
            icon={IconKey}
            title="No credentials yet"
          >
            Keys and tokens for models and connectors are kept here.
          </PageEmpty>
        ) : (
          <PageRows>
            {credentials.data?.map((credential, index) => (
              <StaggerItem index={index} key={credential.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{credential.provider}</ItemTitle>
                    <ItemDescription>
                      {credential.kind} · {credential.keyId} ·{" "}
                      {credential.revokedAt ? "revoked" : "active"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Revoke ${credential.keyId} for ${credential.provider}`}
                      disabled={Boolean(credential.revokedAt)}
                      onClick={(event) =>
                        requestConfirmation({
                          title: `Revoke ${credential.keyId} for ${credential.provider}?`,
                          description: personal
                            ? "Apps or models using this credential may stop working. Revocation is permanent. Add a replacement credential to restore access."
                            : "This revokes the credential for this deployment. Any apps or models using it may stop working. Revocation is permanent. Add a replacement credential to restore access.",
                          confirmLabel: "Revoke credential",
                          pendingLabel: "Revoking credential…",
                          failureMessage:
                            "Revocation could not be confirmed. Try again to check the credential’s status.",
                          successMessage: `${credential.keyId} was revoked.`,
                          trigger: event.currentTarget,
                          fallbackFocus: () => addButton.current,
                          refresh: () => credentials.refetch(),
                          run: async () => {
                            const latest = await credentials.refetch({
                              throwOnError: true,
                            });
                            const current = latest.data?.find(
                              (item) => item.id === credential.id,
                            );
                            if (!current || current.revokedAt) {
                              throw new ActionUnavailable(
                                "This credential is missing or already revoked. Close this dialog and review the list.",
                              );
                            }
                            await revokeCredential.mutateAsync(credential.id);
                          },
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Revoke
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (credentials.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
