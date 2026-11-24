import { IconKey, IconLockOff, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  SettingsListSearch,
  settingsSearchTerms,
} from "@/components/settings/settings-list-search";
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
import { canKeepCachedRead } from "@/lib/client";
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
  const firstMatch = useRef<HTMLDivElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const [search, setSearch] = useState("");
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const logins = useQuery(savedLoginsQueryOptions());
  const saved = canKeepCachedRead(logins.error) ? logins.data : undefined;
  const entries = saved?.passwordManager ? saved.logins : [];
  const terms = settingsSearchTerms(search);
  const matches = entries.filter(({ origin, username }) => {
    const searchable = `${origin} ${username}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      headingRef={pageHeading}
      title={personal ? "Saved logins" : "Passwords"}
      description="Manage saved website logins. Bots cannot see your passwords, and you approve each use."
    >
      <PageSection title={personal ? undefined : "Saved logins"}>
        {confirmation}
        {logins.isPending ? (
          <ReadStatus kind="loading" message="Loading saved logins…" />
        ) : logins.isError ? (
          <ReadError
            description={
              saved?.passwordManager && saved.logins.length
                ? "Showing the last list we could load."
                : undefined
            }
            message="Couldn't load your saved logins."
            retry={logins.refetch}
            retryBelow
            retrying={logins.isFetching}
          />
        ) : null}
        {entries.length ? (
          <SettingsListSearch
            noun="saved logins"
            placeholder="Website or username"
            value={search}
            onChange={setSearch}
            onEnter={() => firstMatch.current?.focus()}
            matches={matches.length}
            total={entries.length}
          />
        ) : null}
        {logins.isSuccess && saved && !saved.passwordManager ? (
          <PageEmpty icon={IconLockOff} title="Saving website logins is off">
            Your saved logins are kept. OpenBot will offer them during sign-in
            when saving is turned back on.
          </PageEmpty>
        ) : logins.isSuccess && saved?.logins.length === 0 ? (
          <PageEmpty icon={IconKey} title="No saved logins yet">
            Select “Save this login” when you sign a Bot in to a website.
          </PageEmpty>
        ) : matches.length > 0 ? (
          <PageRows>
            {matches.map((login, index) => (
              <Fragment key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent style={{ minInlineSize: 0 }}>
                    <ItemTitle
                      className="wrap-anywhere"
                      ref={index === 0 ? firstMatch : undefined}
                      tabIndex={-1}
                    >
                      {login.origin}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none wrap-anywhere">
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
                      className="min-h-11"
                      variant="ghost"
                      disabled={!logins.isSuccess}
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
                          fallbackFocus: () =>
                            firstMatch.current ?? pageHeading.current,
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
        ) : null}
      </PageSection>
    </PageShell>
  );
}
