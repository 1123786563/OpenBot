import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  issueCallbackTokenMutationOptions,
  revokeCallbackTokenMutationOptions,
} from "@/lib/agents/mutations";

/**
 * The credential this coworker presents when it calls a tool back.
 *
 * Only for a coworker that runs somewhere else. The Bot in the box has no endpoint and nothing to
 * authenticate as, and offering it a token would imply otherwise.
 *
 * Shown once, and said plainly. This deployment keeps a hash, so there is no screen that can show the
 * token again: an operator who loses it rotates, and rotating retires the old one, which is also how a
 * leak is handled.
 *
 * A coworker with no token can still hold a conversation. What it cannot do is reach anything outside
 * one, which is the right default for a URL somebody pasted.
 */
export function CallbackTokenPanel({
  agentId,
  hasToken,
}: {
  agentId: string;
  hasToken: boolean;
}) {
  const { t } = useTranslation("agents");
  const queryClient = useQueryClient();
  const issue = useMutation(issueCallbackTokenMutationOptions(queryClient));
  const revoke = useMutation(revokeCallbackTokenMutationOptions(queryClient));

  /** Held in state, not in a query cache: it must not survive a refetch or a navigation. */
  const [token, setToken] = useState<string | null>(null);
  const error = issue.error ?? revoke.error;

  return (
    <section className="mt-6 grid gap-2">
      <h2 className="font-medium text-muted-foreground text-xs">
        {t("callback.title")}
      </h2>

      <p className="text-muted-foreground text-sm">
        {hasToken ? t("callback.hasToken") : t("callback.noToken")}
      </p>

      {token ? (
        <div className="grid gap-2 rounded-lg border border-border bg-card p-3">
          <p className="font-medium text-sm">{t("callback.copyNow")}</p>
          {/*
           * Selectable and wrapped rather than a copy button alone: somebody pasting this into a
           * deployment config on another machine may not have a clipboard between the two.
           */}
          <code className="block break-all rounded bg-foreground/5 p-2 font-mono text-xs">
            {token}
          </code>
          <p className="text-muted-foreground text-xs">
            {t("callback.hashNote")}
          </p>
          <Button onClick={() => setToken(null)} size="sm" variant="outline">
            {t("callback.done")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={issue.isPending}
            onClick={async () => setToken(await issue.mutateAsync(agentId))}
            size="sm"
            variant="outline"
          >
            {issue.isPending
              ? t("callback.generating")
              : hasToken
                ? t("callback.rotate")
                : t("callback.generate")}
          </Button>
          {hasToken ? (
            <Button
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(agentId)}
              size="sm"
              variant="outline"
            >
              {revoke.isPending ? t("callback.revoking") : t("callback.revoke")}
            </Button>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
