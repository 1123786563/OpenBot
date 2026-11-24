import { IconFingerprint, IconShieldLock } from "@tabler/icons-react";
import { type ComponentRef, useRef, useState } from "react";
import { PageRows } from "@/components/layout/page-shell";
import {
  ActionIncomplete,
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
import { Switch } from "@/components/ui/switch";
import { ClientError } from "@/lib/client";
import { enterpriseKeys } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";
import { ControlsSection } from "./controls-section";

/** Admin, Identity providers: whether SSO is the only way in, and directory provisioning. */
export function SignInSection() {
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const ssoSwitch = useRef<ComponentRef<typeof Switch>>(null);
  const [retry, setRetry] = useState<{
    required: boolean;
    message: string;
  } | null>(null);

  function confirmSetting(
    required: boolean,
    save: () => Promise<void>,
    trigger: HTMLElement | null,
    finishingSignOut = false,
  ) {
    const failureMessage =
      "Couldn't finish saving the sign-in policy. Try again.";
    const requireSso = {
      title: "Require SSO for this deployment?",
      description:
        "People without an account linked to a registered identity provider will be signed out. Your current session and the configured emergency administrators are exempt.",
      confirmLabel: "Require SSO",
    };
    const allowOtherSignIns = {
      title: "Allow other sign-in methods?",
      description:
        "People can also sign in using Google, Microsoft or Okta when those options are configured.",
      confirmLabel: "Allow other sign-ins",
    };
    const finishSignOut = {
      title: "Finish requiring SSO?",
      description:
        "The sign-in policy is already on. Retry signing out people whose accounts are missing a registered identity provider.",
      confirmLabel: "Finish signing out",
    };
    const action = finishingSignOut
      ? finishSignOut
      : required
        ? requireSso
        : allowOtherSignIns;
    requestConfirmation({
      ...action,
      pendingLabel: "Saving sign-in policy…",
      failureMessage,
      successMessage: required
        ? "SSO is required."
        : "Other sign-in methods are allowed.",
      trigger: trigger ?? undefined,
      fallbackFocus: () => ssoSwitch.current,
      run: async () => {
        try {
          await save();
          setRetry(null);
        } catch (error) {
          if (error instanceof ClientError && error.status < 500) {
            if (error.status === 409)
              throw new ActionUnavailable(error.message);
            throw error;
          }
          const message =
            error instanceof ClientError ? error.message : failureMessage;
          setRetry({ required, message });
          await queryClient.invalidateQueries({
            queryKey: enterpriseKeys.overview(),
          });
          throw new ActionIncomplete(message);
        }
      },
    });
  }

  return (
    <>
      <ControlsSection
        description="Addresses in INITIAL_ADMIN_EMAILS can always use social sign-in as an emergency way in. Each of those sign-ins shows in Audit."
        showWriteError={false}
        title="Sign-in"
      >
        {({ data, setSettingAsync, saving }) => (
          <>
            {retry ? (
              <section
                className="mt-3 space-y-2"
                aria-label="Sign-in policy recovery"
              >
                <p className="text-sm" role="status">
                  {retry.message}
                </p>
                <Button
                  className="min-h-11"
                  disabled={saving}
                  onClick={(event) =>
                    confirmSetting(
                      retry.required,
                      () => setSettingAsync("ssoRequired", retry.required),
                      event.currentTarget,
                      retry.required && data.settings.ssoRequired,
                    )
                  }
                  variant="outline"
                >
                  Retry saving sign-in policy
                </Button>
              </section>
            ) : null}
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldLock />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Require SSO</ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    {data.settings.ssoRequired
                      ? "People can only sign in through a registered SAML or OpenID Connect provider."
                      : "People can also sign in with Google, Microsoft or Okta. Before requiring SSO, test a sign-in using an email address from a registered provider's domain."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Require SSO"
                    checked={data.settings.ssoRequired}
                    className="after:top-1/2 after:bottom-auto after:h-11 after:-translate-y-1/2"
                    disabled={saving}
                    onCheckedChange={(checked) =>
                      confirmSetting(
                        checked,
                        () => setSettingAsync("ssoRequired", checked),
                        ssoSwitch.current,
                      )
                    }
                    ref={ssoSwitch}
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconFingerprint />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>SCIM provisioning</ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
                    {data.scim.configured
                      ? `Directory base URL ${data.scim.baseUrl ?? "(set BETTER_AUTH_URL)"} with the SCIM_BEARER_TOKEN bearer token. Deprovisioning ends sessions, blocks the address, retires connector credentials and stops their computers.`
                      : "Off. Set SCIM_BEARER_TOKEN to accept provisioning from Okta, Entra or another directory."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">
                    {data.scim.configured ? "On" : "Off"}
                  </span>
                </ItemActions>
              </Item>
            </PageRows>
          </>
        )}
      </ControlsSection>
      {confirmation}
    </>
  );
}
