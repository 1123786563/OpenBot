import { IconBuildingBank, IconTrash } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { SignInSection } from "@/components/admin/controls/sign-in-section";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { StaggerItem } from "@/components/layout/stagger";
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
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { canKeepCachedRead } from "@/lib/client";
import {
  deleteIdentityProviderMutationOptions,
  type IdentityProviderInput,
  registerIdentityProviderMutationOptions,
} from "@/lib/identity-providers/mutations";
import {
  identityProviderListQueryOptions,
  identityProvidersAccessDenied,
} from "@/lib/identity-providers/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/identity-providers")({
  component: IdentityProvidersPage,
});

const EMPTY: {
  protocol: IdentityProviderInput["protocol"];
  providerId: string;
  domain: string;
  issuer: string;
  entryPoint: string;
  metadata: string;
  clientId: string;
  clientSecret: string;
} = {
  protocol: "saml",
  providerId: "",
  domain: "",
  issuer: "",
  entryPoint: "",
  metadata: "",
  clientId: "",
  clientSecret: "",
};

function IdentityProvidersPage() {
  const providers = useQuery(identityProviderListQueryOptions());
  const registered = canKeepCachedRead(providers.error)
    ? providers.data
    : undefined;
  const accessDenied = identityProvidersAccessDenied(providers.error);
  const canManage = providers.isSuccess;
  const addButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const registerButton = useRef<HTMLButtonElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const firstMatch = useRef<HTMLDivElement>(null);
  const registeredRow = useRef<HTMLDivElement>(null);
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const register = useMutation(
    registerIdentityProviderMutationOptions(queryClient),
  );
  const remove = useMutation(
    deleteIdentityProviderMutationOptions(queryClient),
  );
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [uncertainProvider, setUncertainProvider] = useState<string | null>(
    null,
  );
  const formId = useId();
  const requestPending = useRef(false);
  const verification = useRef(0);
  const providerId = draft.providerId.trim();
  const duplicateName =
    registered?.some((provider) => provider.providerId === providerId) ?? false;
  const terms = settingsSearchTerms(search);
  const matches =
    registered?.filter((provider) => {
      const text =
        `${provider.providerId} ${provider.protocol} ${provider.domain} ${provider.issuer}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    }) ?? [];

  const resetRegistration = register.reset;
  useEffect(() => {
    if (uncertainProvider) checkButton.current?.focus();
  }, [uncertainProvider]);

  useEffect(() => {
    if (!accessDenied) return;
    verification.current += 1;
    setOpen(false);
    setDraft(EMPTY);
    setUncertainProvider(null);
    setNotice("");
    setRevealed(null);
    resetRegistration();
  }, [accessDenied, resetRegistration]);

  function closeRegistration() {
    verification.current += 1;
    setOpen(false);
    setDraft(EMPTY);
    setUncertainProvider(null);
    resetRegistration();
  }

  function revealRegistration(id: string, message: string) {
    setRevealed(id);
    if (search.trim()) setSearch(id);
    setNotice(message);
    closeRegistration();
  }

  async function checkRegistration() {
    if (!uncertainProvider || requestPending.current || providers.isFetching)
      return;
    const attempt = ++verification.current;
    const result = await providers.refetch();
    if (attempt !== verification.current || !result.isSuccess) return;
    if (
      result.data.some((provider) => provider.providerId === uncertainProvider)
    ) {
      revealRegistration(
        uncertainProvider,
        `A provider named ${uncertainProvider} is already registered. Review it in the list.`,
      );
      return;
    }
    setUncertainProvider(null);
    resetRegistration();
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        registerButton.current?.focus();
    });
  }

  async function submit(submission: FormEvent) {
    submission.preventDefault();
    if (
      !canManage ||
      !providerId ||
      duplicateName ||
      uncertainProvider ||
      requestPending.current
    )
      return;
    const input: IdentityProviderInput =
      draft.protocol === "saml"
        ? {
            protocol: "saml",
            providerId,
            domain: draft.domain.trim(),
            issuer: draft.issuer.trim(),
            entryPoint: draft.entryPoint.trim(),
            metadata: draft.metadata,
          }
        : {
            protocol: "oidc",
            providerId,
            domain: draft.domain.trim(),
            issuer: draft.issuer.trim(),
            clientId: draft.clientId.trim(),
            clientSecret: draft.clientSecret,
          };

    requestPending.current = true;
    try {
      await register.mutateAsync(input);
      revealRegistration(providerId, `${providerId} was registered.`);
    } catch (error) {
      if (identityProvidersAccessDenied(error)) {
        closeRegistration();
        setNotice("You don’t have permission to register a provider.");
        await providers.refetch();
      } else if (error instanceof Error && canKeepCachedRead(error)) {
        setUncertainProvider(providerId);
      }
    } finally {
      requestPending.current = false;
    }
  }

  return (
    <PageShell
      action={
        canManage ? (
          <Button
            className="min-h-11"
            onClick={() => {
              setRevealed(null);
              setNotice("");
              setOpen(true);
            }}
            ref={addButton}
            size="lg"
          >
            Add a provider
          </Button>
        ) : undefined
      }
      description="Configure your company’s SAML or OpenID Connect provider. Email domains determine which provider people use to sign in."
      title="Identity providers"
    >
      <PageSection
        description="Google, Microsoft and Okta are set in the environment. They don't show here."
        headingRef={heading}
        title="Registered"
      >
        {confirmation}
        {notice ? <p role="status">{notice}</p> : null}
        {providers.isPending ? (
          <ReadStatus kind="loading" message="Loading identity providers…" />
        ) : null}
        {providers.error ? (
          <ReadError
            description={
              registered?.length
                ? "Showing the last loaded providers. Refresh to make changes."
                : undefined
            }
            message={
              accessDenied
                ? "You don’t have access to the registered providers."
                : registered?.length
                  ? "Couldn't refresh identity providers."
                  : "Couldn't load identity providers."
            }
            retry={providers.refetch}
            focusAfterRetry={() => registeredRow.current ?? heading.current}
            retryBelow
            retrying={providers.isFetching}
          />
        ) : null}
        {registered?.length ? (
          <SettingsListSearch
            inputRef={searchInput}
            noun="identity providers"
            placeholder="Provider, protocol, domain or issuer"
            value={search}
            onChange={setSearch}
            onEnter={() => firstMatch.current?.focus()}
            matches={matches.length}
            total={registered.length}
          />
        ) : null}
        {registered?.length === 0 && !providers.error ? (
          <PageEmpty icon={IconBuildingBank} title="No identity providers yet">
            Use the metadata from your identity team.
          </PageEmpty>
        ) : matches.length ? (
          <PageRows>
            {matches.map((provider, index) => (
              <StaggerItem index={index} key={provider.providerId}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconBuildingBank />
                  </ItemMedia>
                  <ItemContent style={{ minInlineSize: 0 }}>
                    <ItemTitle
                      className="line-clamp-none [overflow-wrap:anywhere]"
                      ref={(element) => {
                        if (index === 0) firstMatch.current = element;
                        if (provider.providerId === revealed)
                          registeredRow.current = element;
                      }}
                      tabIndex={-1}
                    >
                      {provider.providerId}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
                      {provider.protocol.toUpperCase()} · {provider.domain}
                    </ItemDescription>
                    <ItemDescription className="line-clamp-none [overflow-wrap:anywhere]">
                      Issuer {provider.issuer}
                    </ItemDescription>
                  </ItemContent>
                  {canManage ? (
                    <ItemActions className="max-sm:basis-full">
                      <Button
                        aria-label={`Remove identity provider ${provider.providerId}`}
                        className="min-h-11"
                        onClick={(event) =>
                          requestConfirmation({
                            title: `Remove ${provider.providerId}?`,
                            description: `People with email addresses at ${provider.domain} will lose this ${provider.protocol.toUpperCase()} sign-in option. If they rely on it, they may be unable to sign in. To restore it, register the provider again.`,
                            confirmLabel: "Remove provider",
                            pendingLabel: "Removing provider…",
                            failureMessage:
                              "Removal could not be confirmed. Try again to check whether the provider is still registered.",
                            successMessage: "",
                            trigger: event.currentTarget,
                            fallbackFocus: () =>
                              firstMatch.current ??
                              searchInput.current ??
                              heading.current,
                            refresh: () => providers.refetch(),
                            run: async () => {
                              const latest = await providers.refetch({
                                throwOnError: true,
                              });
                              const current = latest.data?.find(
                                (item) =>
                                  item.providerId === provider.providerId,
                              );
                              if (
                                !current ||
                                current.domain !== provider.domain ||
                                current.issuer !== provider.issuer ||
                                current.protocol !== provider.protocol ||
                                current.registeredBy !== provider.registeredBy
                              ) {
                                throw new ActionUnavailable(
                                  "This provider was removed or its setup changed. Close this dialog and review the list.",
                                );
                              }
                              await remove.mutateAsync(provider.providerId);
                              setNotice(`${provider.providerId} was removed.`);
                            },
                          })
                        }
                        size="sm"
                        variant="destructive"
                      >
                        <IconTrash />
                        Remove
                      </Button>
                    </ItemActions>
                  ) : null}
                </Item>
                {index !== matches.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        ) : null}
      </PageSection>
      <SignInSection />

      <Dialog
        onOpenChange={(next, event) => {
          if (next) return;
          if (requestPending.current) {
            event.cancel();
            return;
          }
          closeRegistration();
        }}
        open={open && !accessDenied}
      >
        <DialogContent
          finalFocus={() =>
            revealed
              ? (registeredRow.current ?? heading.current)
              : (addButton.current ?? heading.current)
          }
          initialFocus={nameInput}
          showCloseButton={!register.isPending}
        >
          <DialogHeader>
            <DialogTitle>Add an identity provider</DialogTitle>
            <DialogDescription>
              Use the settings supplied by your identity team. The email domain
              controls who can sign in with this provider.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4 space-y-4 overflow-y-auto">
            {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
                direct child of DialogContent and keeps scrolling. */}
            <form className="flex flex-col gap-4" id={formId} onSubmit={submit}>
              <fieldset
                aria-label="Protocol"
                className="flex gap-2"
                disabled={register.isPending || uncertainProvider !== null}
              >
                {(["saml", "oidc"] as const).map((protocol) => (
                  <Button
                    aria-pressed={draft.protocol === protocol}
                    className="min-h-11"
                    key={protocol}
                    onClick={() => setDraft({ ...draft, protocol })}
                    size="sm"
                    type="button"
                    variant={
                      draft.protocol === protocol ? "default" : "outline"
                    }
                  >
                    {protocol.toUpperCase()}
                  </Button>
                ))}
              </fieldset>

              <Field>
                <FieldLabel htmlFor="providerId">Provider name</FieldLabel>
                <Input
                  aria-describedby={
                    duplicateName ? `${formId}-name-conflict` : undefined
                  }
                  aria-invalid={duplicateName || undefined}
                  className="min-h-11"
                  disabled={register.isPending || uncertainProvider !== null}
                  id="providerId"
                  onChange={(event) =>
                    setDraft({ ...draft, providerId: event.target.value })
                  }
                  placeholder="acme-okta"
                  ref={nameInput}
                  required
                  value={draft.providerId}
                />
                {duplicateName ? (
                  <FieldDescription id={`${formId}-name-conflict`}>
                    A provider with this name is already registered.
                  </FieldDescription>
                ) : null}
              </Field>

              <Field>
                <FieldLabel htmlFor="domain">Email domain</FieldLabel>
                <Input
                  aria-describedby={`${formId}-domain-help`}
                  className="min-h-11"
                  disabled={register.isPending || uncertainProvider !== null}
                  id="domain"
                  onChange={(event) =>
                    setDraft({ ...draft, domain: event.target.value })
                  }
                  placeholder="acme.com"
                  required
                  value={draft.domain}
                />
                <FieldDescription id={`${formId}-domain-help`}>
                  Enter the email domains your provider covers. Separate
                  multiple domains with commas.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="issuer">Issuer</FieldLabel>
                <Input
                  className="min-h-11"
                  disabled={register.isPending || uncertainProvider !== null}
                  id="issuer"
                  onChange={(event) =>
                    setDraft({ ...draft, issuer: event.target.value })
                  }
                  placeholder="https://acme.okta.com"
                  required
                  type="url"
                  value={draft.issuer}
                />
              </Field>

              {draft.protocol === "saml" ? (
                <>
                  <Field>
                    <FieldLabel htmlFor="entryPoint">Sign-on URL</FieldLabel>
                    <Input
                      className="min-h-11"
                      disabled={
                        register.isPending || uncertainProvider !== null
                      }
                      id="entryPoint"
                      onChange={(event) =>
                        setDraft({ ...draft, entryPoint: event.target.value })
                      }
                      placeholder="https://acme.okta.com/app/.../sso/saml"
                      required
                      type="url"
                      value={draft.entryPoint}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="metadata">Metadata XML</FieldLabel>
                    <Textarea
                      aria-describedby={`${formId}-metadata-help`}
                      className="font-mono text-xs"
                      disabled={
                        register.isPending || uncertainProvider !== null
                      }
                      id="metadata"
                      onChange={(event) =>
                        setDraft({ ...draft, metadata: event.target.value })
                      }
                      placeholder="<EntityDescriptor …>"
                      required
                      rows={6}
                      value={draft.metadata}
                    />
                    <FieldDescription id={`${formId}-metadata-help`}>
                      Paste the contents of the XML file that includes the
                      signing certificate.
                    </FieldDescription>
                  </Field>
                </>
              ) : (
                <>
                  <Field>
                    <FieldLabel htmlFor="clientId">Client ID</FieldLabel>
                    <Input
                      className="min-h-11"
                      disabled={
                        register.isPending || uncertainProvider !== null
                      }
                      id="clientId"
                      onChange={(event) =>
                        setDraft({ ...draft, clientId: event.target.value })
                      }
                      required
                      value={draft.clientId}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="clientSecret">
                      Client secret
                    </FieldLabel>
                    <Input
                      autoComplete="new-password"
                      className="min-h-11"
                      disabled={
                        register.isPending || uncertainProvider !== null
                      }
                      id="clientSecret"
                      onChange={(event) =>
                        setDraft({ ...draft, clientSecret: event.target.value })
                      }
                      required
                      type="password"
                      value={draft.clientSecret}
                    />
                  </Field>
                </>
              )}
            </form>
          </DialogBody>
          {uncertainProvider ? (
            <p className="shrink-0 text-destructive text-sm" role="alert">
              {providers.error
                ? "Couldn't check the provider list. Try the check again."
                : "Registration could not be confirmed. Check the registered providers before trying again."}
            </p>
          ) : providers.error ? (
            <ReadError
              message="Couldn't refresh the provider list. Your draft is still here."
              retry={providers.refetch}
              retrying={providers.isFetching}
              focusAfterRetry={() => nameInput.current}
            />
          ) : register.error ? (
            <p
              className="shrink-0 break-words text-destructive text-sm"
              role="alert"
            >
              {register.error.message}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              className="min-h-11"
              disabled={register.isPending}
              onClick={closeRegistration}
              size="sm"
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            {uncertainProvider ? (
              <Button
                aria-disabled={providers.isFetching}
                className="min-h-11"
                onClick={() => void checkRegistration()}
                ref={checkButton}
                size="sm"
                type="button"
              >
                {providers.isFetching
                  ? "Checking…"
                  : "Check registered providers"}
              </Button>
            ) : (
              <Button
                className="min-h-11"
                disabled={
                  register.isPending ||
                  !canManage ||
                  !providerId ||
                  duplicateName
                }
                form={formId}
                ref={registerButton}
                size="sm"
                type="submit"
              >
                {register.isPending ? "Registering…" : "Register provider"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
