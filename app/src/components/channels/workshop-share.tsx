import { IconCopy, IconLink, IconLinkOff } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createWorkshopShare,
  revokeWorkshopShare,
  type WorkshopShareScope,
  type WorkshopShareState,
} from "@/lib/workshop/client";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  invalidateWorkshopInScope,
  workshopScopePair,
} from "@/lib/workshop/queries";

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
  // Minting and closing a share are authorization issuances under the scope in force (MT091 /
  // Issue #134, AC2/AC3): the token is minted for this scope's session, and the close settles
  // at both cache roots so the tab reflects the revoked state immediately.
  const scopeCache = useScopedCache();
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
      createWorkshopShare(
        channelId,
        {
          scope,
          ...(days > 0 ? { expiresInDays: days } : {}),
        },
        workshopScopePair(scopeCache),
      ),
    onSuccess: (created) => {
      setMinted(created);
      setConfirmingRevoke(false);
      invalidateWorkshopInScope(queryClient, scopeCache);
    },
  });

  const revoke = useMutation({
    mutationFn: () =>
      revokeWorkshopShare(channelId, workshopScopePair(scopeCache)),
    onSuccess: () => {
      setMinted(null);
      setConfirmingRevoke(false);
      invalidateWorkshopInScope(queryClient, scopeCache);
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
          <Select
            value={scope}
            onValueChange={(value) => {
              // The null guard is the migration contract (H05/H06/H10): React Aria reports an
              // empty selection as null, and the mint form keeps its previous scope rather
              // than a stringified absence.
              if (value !== null) setScope(value);
            }}
            disabled={create.isPending}
          >
            <SelectTrigger id="share-scope" size="sm" className="h-8 text-xs">
              <SelectValue>
                {scope === "preview"
                  ? t("share.scope.preview")
                  : t("share.scope.previewDownload")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preview">
                {t("share.scope.preview")}
              </SelectItem>
              <SelectItem value="preview_download">
                {t("share.scope.previewDownload")}
              </SelectItem>
            </SelectContent>
          </Select>
          <label
            className="ml-2 text-xs text-muted-foreground"
            htmlFor="share-days"
          >
            {t("share.daysLabel")}
          </label>
          <Select
            value={days}
            onValueChange={(value) => {
              // Null guard as above, and the days are NUMBER keys: ui/select keeps the
              // domain value round-trip exact (7/30/0 — 0 is "never expires"), so the
              // native select's Number(event.target.value) stringify is gone, not kept.
              if (value !== null) setDays(value);
            }}
            disabled={create.isPending}
          >
            <SelectTrigger id="share-days" size="sm" className="h-8 text-xs">
              <SelectValue>
                {days === 7
                  ? t("share.days.7")
                  : days === 30
                    ? t("share.days.30")
                    : t("share.days.forever")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={7}>{t("share.days.7")}</SelectItem>
              <SelectItem value={30}>{t("share.days.30")}</SelectItem>
              <SelectItem value={0}>{t("share.days.forever")}</SelectItem>
            </SelectContent>
          </Select>
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
            <code className="min-w-0 flex-1 truncate rounded bg-ob-muted-surface/60 px-2 py-1 text-xs">
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
