import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  decideSharedUseMutationOptions,
  describeApproval,
  type SharedUseRequestReason,
  sharedUseRequestsQueryOptions,
} from "@/lib/plugins/shared-use";

const WHY = {
  refused_call: "sharedUse.why.refusedCall",
  publish: "sharedUse.why.publish",
  trigger: "sharedUse.why.trigger",
  grant: "sharedUse.why.grant",
} as const satisfies Record<SharedUseRequestReason, string>;

export function SharedUseRequests() {
  const { t } = useTranslation("approvals");
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const isAdmin = me?.role === "admin";
  const requests = useQuery(sharedUseRequestsQueryOptions(isAdmin));
  const decide = useMutation(decideSharedUseMutationOptions(queryClient));
  if (!isAdmin || !requests.data?.length) return null;

  return (
    <div className="space-y-3">
      <h2 className="font-medium">{t("sharedUse.title")}</h2>
      {decide.error ? (
        <p className="text-destructive text-sm" role="alert">
          {decide.error.message}
        </p>
      ) : null}
      {requests.data.map((request) => {
        const whyKey = WHY[request.reason as SharedUseRequestReason];
        return (
          <article className="space-y-2 rounded-lg border p-4" key={request.id}>
            <h3 className="font-medium text-sm">
              {t("sharedUse.wantsAccount", {
                bot: request.botName,
                account: request.title,
              })}
            </h3>
            <p className="text-muted-foreground text-sm">
              {whyKey ? t(whyKey) : request.reason}
            </p>
            <p className="text-sm">
              {t("sharedUse.nowLabel")}{" "}
              {request.current
                ? describeApproval(request.current)
                : t("sharedUse.notApproved")}
            </p>
            <p className="text-sm">
              {t("sharedUse.askedLabel")} {describeApproval(request.proposed)}
            </p>
            <div className="flex gap-2">
              <Button
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: request.id, decision: "approve" })
                }
                size="sm"
              >
                {t("sharedUse.approve")}
              </Button>
              <Button
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: request.id, decision: "decline" })
                }
                size="sm"
                variant="outline"
              >
                {t("sharedUse.decline")}
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
