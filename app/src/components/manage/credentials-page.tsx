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
import { ReadError, ReadStatus } from "@/components/layout/read-status";
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
import { canKeepCachedRead } from "@/lib/client";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";
import { useManagePaths } from "@/lib/manage-paths";

export function CredentialsPage() {
  const paths = useManagePaths();
  const addButton = useRef<HTMLAnchorElement>(null);
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const personal = paths.edition === "personal";
  const entry = personal ? "key" : "credential";
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const entries = canKeepCachedRead(credentials.error)
    ? credentials.data
    : undefined;
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
          className="min-h-11"
          variant="ghost"
        >
          <IconPlus />
          Add {entry}
        </Button>
      }
      description={
        personal
          ? "API keys and tokens your apps and models use. A saved key can't be viewed again."
          : "Manage this deployment’s keys and tokens. Saved secrets cannot be viewed again."
      }
      title={paths.credentialsLabel}
    >
      <PageSection title={personal ? "Saved keys" : "Saved credentials"}>
        {confirmation}
        {credentials.isPending ? (
          <ReadStatus kind="loading" message={`Loading ${entry}s…`} />
        ) : credentials.isError ? (
          <ReadError
            description={
              entries?.length
                ? "Showing the last list we could load."
                : undefined
            }
            message={`Couldn't load ${entry}s.`}
            retry={credentials.refetch}
            retryBelow
            retrying={credentials.isFetching}
          />
        ) : null}
        {credentials.isSuccess && entries?.length === 0 ? (
          <PageEmpty icon={IconKey} title={`No ${entry}s yet`}>
            Use Add {entry} to save an API key or token.
          </PageEmpty>
        ) : entries?.length ? (
          <PageRows>
            {entries.map((credential, index) => (
              <StaggerItem index={index} key={credential.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle className="wrap-anywhere">
                      {credential.provider}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none wrap-anywhere">
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
                          confirmLabel: `Revoke ${entry}`,
                          pendingLabel: `Revoking ${entry}…`,
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
                      className="min-h-11"
                      variant="outline"
                    >
                      Revoke
                    </Button>
                  </ItemActions>
                </Item>
                {index !== entries.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
