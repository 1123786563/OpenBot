import { IconKey, IconLockOff, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 *
 * Under Settings. The personal edition calls it Saved logins, and links to it from Connections too.
 */
export function PasswordsPage() {
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const logins = useQuery(savedLoginsQueryOptions());
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title={personal ? "Saved logins" : "Passwords"}
      description="Manage saved website logins. Bots cannot see your passwords, and you approve each use."
    >
      <PageSection title={personal ? undefined : "Saved logins"}>
        {confirmation}
        {logins.isPending ? (
          <p role="status">Loading saved logins…</p>
        ) : logins.error && !logins.data ? (
          <>
            <p className="text-destructive text-sm" role="alert">
              Couldn't load your saved logins.
            </p>
            <Button
              onClick={() => void logins.refetch()}
              size="sm"
              variant="outline"
            >
              Try again
            </Button>
          </>
        ) : !logins.data?.passwordManager ? (
          <PageEmpty icon={IconLockOff} title="Saved passwords are off">
            An admin turned them off. Your logins are kept but won't be offered.
          </PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty icon={IconKey} title="No saved logins yet">
            Choose Save to Passwords when you sign a Bot in to a website.
          </PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <Fragment key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.origin}</ItemTitle>
                    <ItemDescription>
                      {login.username}
                      {login.lastUsedAt
                        ? ` · last used ${new Date(login.lastUsedAt).toLocaleDateString()}`
                        : " · never used"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={`Delete saved login for ${login.username} at ${login.origin}`}
                      size="sm"
                      variant="ghost"
                      onClick={(event) =>
                        requestConfirmation({
                          title: `Delete saved login for ${login.origin}?`,
                          description: `OpenBot will stop offering the saved login for ${login.username} at this site. You can save the login again the next time you sign in.`,
                          confirmLabel: "Delete saved login",
                          pendingLabel: "Deleting saved login…",
                          failureMessage:
                            "Deletion could not be confirmed. Try again to check whether this login is still saved.",
                          successMessage: `Saved login for ${login.origin} deleted.`,
                          trigger: event.currentTarget,
                          refresh: () => logins.refetch(),
                          run: async () => {
                            const latest = await logins.refetch({
                              throwOnError: true,
                            });
                            const current = latest.data?.logins.find(
                              (item) => item.id === login.id,
                            );
                            if (
                              !latest.data?.passwordManager ||
                              !current ||
                              current.username !== login.username ||
                              current.origin !== login.origin ||
                              current.updatedAt !== login.updatedAt
                            ) {
                              throw new ActionUnavailable(
                                "The saved login or password manager settings changed. Close this dialog and review your saved logins.",
                              );
                            }
                            await remove.mutateAsync(login.id);
                          },
                        })
                      }
                    >
                      <IconTrash />
                      Delete
                    </Button>
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
