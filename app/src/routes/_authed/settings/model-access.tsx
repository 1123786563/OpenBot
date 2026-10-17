import { IconRobot, IconShieldCheck } from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ModelPicker } from "@/components/settings/model-picker";
import { ModelAccessAuthorizations } from "@/components/settings/model-access-authorizations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { useDateTime } from "@/lib/i18n/datetime";
import {
  type AccessGrant,
  type BindingPreview,
  confirmAccessGrantMutationOptions,
  previewBindingCodeMutationOptions,
} from "@/lib/model-access/mutations";

export const Route = createFileRoute("/_authed/settings/model-access")({
  component: ModelAccessPage,
});

/**
 * The model access page (Bifrost #238, 04.5; the list and revocation are #240, 04.7).
 *
 * A Bot hands its person a one-time binding code out of band; this page is where that code becomes
 * an authorization. Yours alone to give: the page shows exactly which Bot and which external
 * identity the code names before anything is created, and only an explicit Confirm — never the
 * preview, never the code alone — creates the grant. No key appears here and no balance moves:
 * the Bot's server receives its own short-lived key later (05.3), and it spends this person's
 * credits only through this authorization.
 *
 * Below the confirmation, the person's own authorizations: one row per grant, the state the
 * server reports, and a Revoke press that takes effect the moment the server commits it.
 */
function ModelAccessPage() {
  const { t } = useTranslation("settings");
  const { formatDateTime } = useDateTime();
  const [bindingCode, setBindingCode] = React.useState("");
  const [preview, setPreview] = React.useState<BindingPreview | null>(null);
  const [grant, setGrant] = React.useState<AccessGrant | null>(null);

  const lookup = useMutation(previewBindingCodeMutationOptions());
  const confirm = useMutation(confirmAccessGrantMutationOptions());

  /** Back to a clean slate: the preview is gone, the code is kept for a retry. */
  const reset = () => {
    setPreview(null);
    setGrant(null);
    lookup.reset();
    confirm.reset();
  };

  const lookupError = lookup.error ? t("modelAccess.invalidCode") : null;

  return (
    <PageShell
      title={t("modelAccess.title")}
      description={t("modelAccess.description")}
    >
      <ModelPicker />
      <ModelAccessAuthorizations />
      <PageSection title={t("modelAccess.confirmSection")}>
        {grant ? (
          <GrantedAuthorization grant={grant} />
        ) : preview ? (
          <>
            <PreviewCard
              preview={preview}
              expiry={formatDateTime(preview.expiresAt)}
            />
            {confirm.error ? (
              <p className="text-destructive text-sm" role="alert">
                {t("modelAccess.confirmFailed")}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  const code = bindingCode.trim();
                  if (code)
                    confirm.mutate(code, {
                      onSuccess: (created) => setGrant(created),
                    });
                }}
                disabled={confirm.isPending}
              >
                {confirm.isPending
                  ? t("modelAccess.confirming")
                  : t("modelAccess.confirm")}
              </Button>
              <Button
                variant="ghost"
                onClick={reset}
                disabled={confirm.isPending}
              >
                {t("modelAccess.cancel")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconRobot />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{t("modelAccess.codeTitle")}</ItemTitle>
                <ItemDescription>
                  {t("modelAccess.codeDescription")}
                </ItemDescription>
              </ItemContent>
            </Item>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const code = bindingCode.trim();
                if (!code) return;
                lookup.mutate(code, {
                  onSuccess: (found) => setPreview(found),
                });
              }}
            >
              <Input
                value={bindingCode}
                onChange={(event) => setBindingCode(event.target.value)}
                placeholder={t("modelAccess.codePlaceholder")}
                aria-label={t("modelAccess.codeTitle")}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
              <Button
                type="submit"
                disabled={lookup.isPending || !bindingCode.trim()}
              >
                {lookup.isPending
                  ? t("modelAccess.checking")
                  : t("modelAccess.checkCode")}
              </Button>
            </form>
            {lookupError ? (
              <p className="text-destructive text-sm" role="alert">
                {lookupError}
              </p>
            ) : null}
          </>
        )}
      </PageSection>
      <PageSection title={t("modelAccess.aboutSection")}>
        <PageEmpty>{t("modelAccess.about")}</PageEmpty>
      </PageSection>
    </PageShell>
  );
}

/** The thing the person is about to authorize, shown exactly as the code names it. */
function PreviewCard({
  preview,
  expiry,
}: {
  preview: BindingPreview;
  expiry: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconShieldCheck />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {t("modelAccess.previewTitle", {
            bot: preview.bot.displayName,
          })}
        </ItemTitle>
        <ItemDescription>
          {t("modelAccess.previewIdentity", {
            identity: preview.externalIdentity,
          })}
        </ItemDescription>
        <ItemDescription>
          {t("modelAccess.previewExpires", {
            expiry,
          })}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** The authorization that now exists: its stable id and its state, and nothing that can spend. */
function GrantedAuthorization({ grant }: { grant: AccessGrant }) {
  const { t } = useTranslation("settings");
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconShieldCheck />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{t("modelAccess.grantedTitle")}</ItemTitle>
          <ItemDescription>
            {t("modelAccess.grantedDescription", {
              bot: grant.botId,
              identity: grant.externalIdentity,
            })}
          </ItemDescription>
          <ItemDescription className="font-mono">
            {t("modelAccess.grantId", { grantId: grant.grantId })}
          </ItemDescription>
          <ItemDescription>{t("modelAccess.grantActive")}</ItemDescription>
        </ItemContent>
      </Item>
      <p className="text-muted-foreground text-sm">
        {t("modelAccess.grantedNext")}
      </p>
    </>
  );
}
