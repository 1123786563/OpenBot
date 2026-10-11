import { IconCopy, IconLink, IconLinkOff } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  createWorkshopShare,
  revokeWorkshopShare,
  type WorkshopShareScope,
  type WorkshopShareState,
} from "@/lib/workshop/client";

/**
 * The share manager: mint a link, show it exactly once, revoke it, mint again.
 *
 * The token plaintext exists in this component's state between creation and the copy (or the
 * close): the server keeps only its hash and cannot answer "what was the link" a second time,
 * so the one-time banner is the product, not a nicety. Revocation asks twice — a shared link
 * is somebody's bookmark, and taking it away should feel like the decision it is.
 */
export function WorkshopShareView({
  channelId,
  share,
}: {
  channelId: string;
  share: WorkshopShareState;
}) {
  const { t } = useTranslation("workshop");
  const queryClient = useQueryClient();
  const [minted, setMinted] = useState<{
    token: string;
    shareUrl: string;
    scope: WorkshopShareScope;
    expiresAt: string | null;
  } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [scope, setScope] = useState<WorkshopShareScope>("preview");
  const [days, setDays] = useState(7);

  const create = useMutation({
    mutationFn: () =>
      createWorkshopShare(channelId, {
        scope,
        ...(days > 0 ? { expiresInDays: days } : {}),
      }),
    onSuccess: (created) => {
      setMinted(created);
      setConfirmingRevoke(false);
      void queryClient.invalidateQueries({ queryKey: ["workshop"] });
    },
  });

  const revoke = useMutation({
    mutationFn: () => revokeWorkshopShare(channelId),
    onSuccess: () => {
      setMinted(null);
      setConfirmingRevoke(false);
      void queryClient.invalidateQueries({ queryKey: ["workshop"] });
    },
  });

  const live = share.shareUrl !== null && share.shareRevokedAt === null;

  return (
    <div className="space-y-4 p-4">
      <section className="rounded-md border border-border p-3">
        <h3 className="text-sm font-medium">{t("share.heading")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("share.hint")}</p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label
            className="text-xs text-muted-foreground"
            htmlFor="share-scope"
          >
            {t("share.scopeLabel")}
          </label>
          <select
            id="share-scope"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as WorkshopShareScope)
            }
            disabled={create.isPending}
          >
            <option value="preview">{t("share.scope.preview")}</option>
            <option value="preview_download">
              {t("share.scope.previewDownload")}
            </option>
          </select>
          <label
            className="ml-2 text-xs text-muted-foreground"
            htmlFor="share-days"
          >
            {t("share.daysLabel")}
          </label>
          <select
            id="share-days"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            disabled={create.isPending}
          >
            <option value={7}>{t("share.days.7")}</option>
            <option value={30}>{t("share.days.30")}</option>
            <option value={0}>{t("share.days.forever")}</option>
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => create.mutate()}
            disabled={create.isPending}
          >
            <IconLink className="size-3.5" />
            {live ? t("share.replace") : t("share.create")}
          </Button>
        </div>

        {create.isError ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {t("share.createError")}
          </p>
        ) : null}
      </section>

      {minted ? (
        <section
          className="rounded-md border border-emerald-600/40 bg-emerald-500/5 p-3"
          aria-label={t("share.minted.aria")}
        >
          <p className="text-sm font-medium">{t("share.minted.title")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("share.minted.once")}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted/60 px-2 py-1 text-xs">
              {minted.shareUrl}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard?.writeText(minted.shareUrl)
              }
            >
              <IconCopy className="size-3.5" />
              {t("share.copy")}
            </Button>
          </div>
          {minted.expiresAt ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("share.minted.expires", {
                date: new Date(minted.expiresAt).toLocaleString(),
              })}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            onClick={() => setMinted(null)}
          >
            {t("share.minted.dismiss")}
          </Button>
        </section>
      ) : null}

      <section className="rounded-md border border-border p-3">
        <h3 className="text-sm font-medium">{t("share.state.heading")}</h3>
        {live ? (
          <>
            <p className="mt-1 text-xs text-muted-foreground">
              {share.shareExpiresAt
                ? t("share.state.liveUntil", {
                    date: new Date(share.shareExpiresAt).toLocaleString(),
                  })
                : t("share.state.live")}
            </p>
            {confirmingRevoke ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="text-xs text-destructive">
                  {t("share.revoke.confirm")}
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => revoke.mutate()}
                  disabled={revoke.isPending}
                >
                  {t("share.revoke.yes")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmingRevoke(false)}
                >
                  {t("share.revoke.no")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setConfirmingRevoke(true)}
              >
                <IconLinkOff className="size-3.5" />
                {t("share.revokeButton")}
              </Button>
            )}
          </>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("share.state.none")}
          </p>
        )}
      </section>
    </div>
  );
}
