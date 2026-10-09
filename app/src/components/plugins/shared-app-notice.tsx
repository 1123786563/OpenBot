import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  botSharedAppsQueryOptions,
  requestSharedUseMutationOptions,
} from "@/lib/plugins/shared-use";

/**
 * What changing who can reach a Bot means for the shared accounts it uses, said BEFORE the change.
 *
 * An administrator's change is its own approval, so they are told that and nothing is asked of them.
 * Anybody else is told plainly that the shared calls will be refused until an administrator agrees,
 * and is given the one button that asks — the alternative being that the first person to find out
 * is whoever the refused call was for.
 */
export function SharedAppNotice({
  botId,
  reason,
}: {
  botId: string;
  reason: "publish" | "trigger";
}) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const shared = useQuery(botSharedAppsQueryOptions(botId));
  const ask = useMutation(requestSharedUseMutationOptions(queryClient));
  const apps = shared.data?.apps ?? [];
  if (apps.length === 0) return null;

  if (me?.role === "admin") {
    return (
      <div className="space-y-1 text-sm">
        {apps.map((app) => (
          <p key={app.serverId}>
            {t("sharedNotice.savingApproves", { title: app.title })}
          </p>
        ))}
      </div>
    );
  }

  const waiting = new Set(
    (shared.data?.pending ?? []).map((request) => request.serverId),
  );
  return (
    <div className="space-y-2 text-sm">
      {apps.map((app) =>
        waiting.has(app.serverId) ? (
          <p className="text-muted-foreground" key={app.serverId}>
            {t("sharedNotice.waiting", { title: app.title })}
          </p>
        ) : app.covered ? null : (
          <div className="flex flex-wrap items-center gap-2" key={app.serverId}>
            <p className="text-amber-700 dark:text-amber-400">
              {t("sharedNotice.refused", { title: app.title })}
            </p>
            <Button
              aria-label={t("sharedNotice.requestAria", {
                title: app.title,
              })}
              disabled={ask.isPending}
              onClick={() =>
                ask.mutate({ botId, serverId: app.serverId, reason })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {t("sharedNotice.requestApproval")}
            </Button>
          </div>
        ),
      )}
      {ask.error ? (
        <p className="text-destructive" role="alert">
          {ask.error.message}
        </p>
      ) : null}
    </div>
  );
}
