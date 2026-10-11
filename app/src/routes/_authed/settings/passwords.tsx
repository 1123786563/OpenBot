import { IconKey, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
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
import { useDateTime } from "@/lib/i18n/datetime";
import { deleteSavedLoginMutationOptions } from "@/lib/passwords/mutations";
import { savedLoginsQueryOptions } from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/settings/passwords")({
  component: PasswordsPage,
});

/**
 * The logins you saved from a private sign-in form.
 *
 * The site and username only: a password is write-only, and this page can delete one but never show
 * it. A saved login is used only when you confirm it in a sign-in form.
 */
function PasswordsPage() {
  const { t } = useTranslation("settings");
  const dateTime = useDateTime();
  const logins = useQuery(savedLoginsQueryOptions());
  const remove = useMutation(deleteSavedLoginMutationOptions(queryClient));
  return (
    <PageShell
      title={t("passwords.title")}
      description={t("passwords.description")}
    >
      <PageSection title={t("passwords.savedLogins")}>
        {logins.isPending ? (
          <PageRowsSkeleton />
        ) : logins.error ? (
          <p className="text-destructive text-sm" role="alert">
            {t("passwords.loadError")}
          </p>
        ) : !logins.data.passwordManager ? (
          <PageEmpty>{t("passwords.disabled")}</PageEmpty>
        ) : logins.data.logins.length === 0 ? (
          <PageEmpty>{t("passwords.empty")}</PageEmpty>
        ) : (
          <PageRows>
            {logins.data.logins.map((login, index) => (
              <div key={login.id}>
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
                        ? ` · ${t("passwords.lastUsed", {
                            date: dateTime.formatDate(login.lastUsedAt),
                          })}`
                        : ` · ${t("passwords.neverUsed")}`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={t("passwords.deleteAria", {
                        origin: login.origin,
                      })}
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(login.id)}
                    >
                      <IconTrash />
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        )}
        {remove.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
