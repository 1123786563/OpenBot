import { IconShieldCheck } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
import {
  accessGrantsQueryOptions,
  revokeAccessGrantMutationOptions,
} from "@/lib/model-access/mutations";

/**
 * The person's own model access authorizations (Bifrost #240, 04.7): one row per grant, the way
 * the server reports it — which Bot, which external identity, active or revoked, and when it was
 * confirmed — and a Revoke press on the active ones.
 *
 * Everything that makes this safe lives server-side and this component cannot un-live it: the
 * list endpoint answers only the session's own rows, and the revocation locates its grant by
 * grantId and that same session user, refusing anyone else's with the same silence as a
 * nonexistent one. What the screen owes is honesty about state: it renders the refetched server
 * truth after each revocation settles (the mutation invalidates the list), so a revoked grant
 * reads revoked the moment the server has committed it — and it never renders a press on a grant
 * the server already revoked.
 */
export function ModelAccessAuthorizations() {
  const { t } = useTranslation("settings");
  const { formatDateTime } = useDateTime();
  // The context's client: the same singleton the app mounts in production, and the one this tree
  // is rendered under anywhere else — the invalidation below must reach the query that drew this.
  const queryClient = useQueryClient();
  const list = useQuery(accessGrantsQueryOptions());
  const revoke = useMutation(revokeAccessGrantMutationOptions(queryClient));
  const error = list.error ?? revoke.error;

  return (
    <PageSection
      title={t("modelAccess.yourGrantsSection")}
      description={t("modelAccess.yourGrantsDescription")}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {list.isPending || !list.data ? null : list.data.length === 0 ? (
        <PageEmpty>{t("modelAccess.yourGrantsEmpty")}</PageEmpty>
      ) : (
        <PageRows>
          {list.data.map((grant, index) => (
            <Fragment key={grant.grantId}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{grant.botDisplayName}</ItemTitle>
                  <ItemDescription>
                    {t("modelAccess.grantIdentity", {
                      identity: grant.externalIdentity,
                    })}
                  </ItemDescription>
                  <ItemDescription>
                    {t("modelAccess.grantCreatedAt", {
                      date: formatDateTime(grant.createdAt),
                    })}
                  </ItemDescription>
                  <ItemDescription>
                    {grant.status === "active"
                      ? t("modelAccess.grantStatusActive")
                      : t("modelAccess.grantStatusRevoked")}
                  </ItemDescription>
                </ItemContent>
                {grant.status === "active" ? (
                  <ItemActions>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(grant.grantId)}
                    >
                      {revoke.isPending
                        ? t("modelAccess.revoking")
                        : t("modelAccess.revoke")}
                    </Button>
                  </ItemActions>
                ) : null}
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
