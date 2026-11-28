import { VStack } from "@astryxdesign/core/VStack";
import { IconBrandGithub, IconBrandSlack, IconLink } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { failureMessage } from "@/lib/client";
import {
  connectGithubMutationOptions,
  issueSlackCodeMutationOptions,
  type SlackLinkCode,
  unlinkMutationOptions,
} from "@/lib/identity/mutations";
import {
  type IdentityProviders,
  identityKeys,
  identityProvidersQueryOptions,
  type LinkedAccount,
  linkedAccountsQueryOptions,
} from "@/lib/identity/queries";
import { queryClient } from "@/query-client";

/** A lapsed link is a warning, not metadata: the amber pair carries AA contrast in both themes. */
const TURNS_WARN = "text-amber-700 dark:text-amber-400";

export function linkedAccountDescription(account: LinkedAccount): string {
  if (account.status === "needs_reconnect") {
    return account.handle
      ? `Needs reconnecting · @${account.handle}`
      : "Needs reconnecting";
  }
  return account.handle ? `@${account.handle}` : "Linked";
}

const providerIcons = {
  slack: IconBrandSlack,
  github: IconBrandGithub,
} as const;

/** A provider this build has no mark for gets a neutral link icon rather than someone else's logo. */
export function providerIcon(provider: string) {
  // Own keys only: "constructor" or "toString" would otherwise find an Object prototype member.
  return Object.hasOwn(providerIcons, provider)
    ? providerIcons[provider as keyof typeof providerIcons]
    : IconLink;
}

/** The account types a person can link from here, in the order their cards are drawn. */
const linkableProviders = [
  { provider: "slack", title: "Slack" },
  { provider: "github", title: "GitHub" },
] as const;

export type LinkableProvider = (typeof linkableProviders)[number]["provider"];

/** The name a linkable provider is shown under. */
export function linkableProviderTitle(provider: LinkableProvider): string {
  return (
    linkableProviders.find((entry) => entry.provider === provider)?.title ??
    provider
  );
}

export type LinkedAccountsEntry =
  | { kind: "linked"; account: LinkedAccount }
  | {
      kind: "available";
      provider: LinkableProvider;
      title: string;
    };

/**
 * What the section draws: one card per account type, then an error if the list failed.
 *
 * Each account type is either the account linked there, with its disconnect, or — when this
 * deployment can link it — an unlinked card to connect from. Links stay listed even when their type
 * can no longer be linked, so they can still be disconnected; links of a type this build does not
 * know come last. Connect cards need the list: with no list loaded there is no knowing whether the
 * account is already linked. Hidden when there is nothing to list, nothing to connect and nothing
 * to report. A failed refetch keeps the stale entries on screen with the error under them. A failed
 * providers check is reported too, so a missing Connect card is never unexplained.
 */
export function linkedAccountsSectionState({
  data,
  error,
  only,
  providers,
  providersError = null,
}: {
  data: LinkedAccount[] | undefined;
  error: Error | null;
  /** One provider's page draws only that provider's links and offer. */
  only?: LinkableProvider;
  providers?: IdentityProviders;
  providersError?: Error | null;
}): {
  entries: LinkedAccountsEntry[];
  error: string | null;
  providersError: string | null;
} | null {
  const links = data ?? [];
  const entries: LinkedAccountsEntry[] = [];
  for (const { provider, title } of linkableProviders) {
    if (only && provider !== only) continue;
    const linked = links.filter((account) => account.provider === provider);
    for (const account of linked) entries.push({ kind: "linked", account });
    if (linked.length === 0 && data !== undefined && providers?.[provider]) {
      entries.push({ kind: "available", provider, title });
    }
  }
  for (const account of only ? [] : links) {
    if (
      !linkableProviders.some(({ provider }) => provider === account.provider)
    )
      entries.push({ kind: "linked", account });
  }
  if (entries.length === 0 && !error && !providersError) return null;
  return {
    entries,
    error: error ? error.message : null,
    providersError: providersError ? providersError.message : null,
  };
}

/**
 * Whether the GitHub Connect button is disabled.
 *
 * The mutation settles before the browser has left for GitHub, so a success keeps the button
 * disabled too: the page is about to navigate away and a second click would start a second sign-in.
 */
export function connectGithubPending(mutation: {
  isPending: boolean;
  isSuccess: boolean;
}): boolean {
  return mutation.isPending || mutation.isSuccess;
}

/**
 * Who you are in the chat apps and code hosts this deployment talks to.
 *
 * Separate from the connector rows above it: those are services a Bot reads as you, these are how
 * this deployment recognises you when a message or an event arrives from somewhere else.
 */
/**
 * The person's own account at one provider, on that provider's Connections page: the link with a
 * Disconnect button, or Connect where this deployment can link it.
 */
export function LinkedAccountSection({
  provider,
}: {
  provider: LinkableProvider;
}) {
  const links = useQuery(linkedAccountsQueryOptions());
  const providers = useQuery(identityProvidersQueryOptions());
  const heading = useRef<HTMLHeadingElement>(null);
  const issueCode = useMutation(issueSlackCodeMutationOptions());
  const slackCodeTrigger = useRef<HTMLButtonElement>(null);
  const issuingCode = useRef(false);
  const slackCommandId = useId();
  const connectGithub = useMutation(connectGithubMutationOptions());
  const [issued, setIssued] = useState<SlackLinkCode | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const slackCommand = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!issued) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(issued.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [issued]);
  // Back from GitHub can restore this page from the back/forward cache with the successful
  // connect still in memory, which would leave Connect disabled; a restored page starts over.
  const resetConnect = connectGithub.reset;
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) resetConnect();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [resetConnect]);
  const closeDialog = () => {
    issuingCode.current = false;
    setIssued(null);
    setExpired(false);
    setCopied(false);
    setCopyFailed(false);
    // A link may have completed while the dialog was open.
    queryClient.invalidateQueries({ queryKey: identityKeys.links() });
  };
  const state = linkedAccountsSectionState({
    data: links.data,
    error: links.error,
    only: provider,
    providers: providers.data,
    providersError: providers.error,
  });
  if (links.isPending || (!state && providers.isPending)) {
    return (
      <PageSection headingRef={heading} title="Your account">
        <ReadStatus kind="loading" message="Checking your linked account…" />
      </PageSection>
    );
  }
  if (!state) {
    return (
      <PageSection headingRef={heading} title="Your account">
        <PageEmpty icon={IconLink} title="Not set up yet">
          You can't link a {linkableProviderTitle(provider)} account yet. An
          admin has to set it up first.
        </PageEmpty>
      </PageSection>
    );
  }
  const connect = {
    slack: {
      pending: issueCode.isPending || issued !== null,
      start: (trigger: HTMLButtonElement) => {
        if (issuingCode.current) return;
        issuingCode.current = true;
        slackCodeTrigger.current = trigger;
        issueCode.mutate(undefined, {
          onSuccess: setIssued,
          onError: () => {
            issuingCode.current = false;
          },
        });
      },
    },
    github: {
      pending: connectGithubPending(connectGithub),
      start: () =>
        connectGithub.mutate(undefined, {
          onSuccess: (url) => window.location.assign(url),
        }),
    },
  };
  return (
    <PageSection headingRef={heading} title="Your account">
      {state.entries.length > 0 ? (
        <PageRows>
          {state.entries.map((entry, index) => (
            <Fragment
              key={entry.kind === "linked" ? entry.account.id : entry.provider}
            >
              {index > 0 ? <Separator /> : null}
              {entry.kind === "linked" ? (
                <LinkedAccountRow
                  account={entry.account}
                  reconnect={
                    entry.account.status === "needs_reconnect"
                      ? connect[entry.account.provider as LinkableProvider]
                      : undefined
                  }
                />
              ) : (
                <AvailableAccountRow
                  provider={entry.provider}
                  title={entry.title}
                  pending={connect[entry.provider].pending}
                  onConnect={connect[entry.provider].start}
                />
              )}
            </Fragment>
          ))}
        </PageRows>
      ) : null}
      {state.error ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't load your account."
          retry={links.refetch}
          retryBelow
          retryLabel="Retry linked account"
          retrying={links.isFetching}
        />
      ) : null}
      {state.providersError ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't check whether you can link this account."
          retry={providers.refetch}
          retryBelow
          retryLabel="Retry account linking availability"
          retrying={providers.isFetching}
        />
      ) : null}
      {issueCode.isPending ? (
        <ReadStatus kind="loading" message="Requesting a Slack code…" />
      ) : null}
      {issueCode.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {failureMessage(
            issueCode.error,
            "Couldn't create a Slack code. Try connecting Slack again.",
          )}
        </p>
      ) : null}
      {connectGithub.error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {failureMessage(
            connectGithub.error,
            "Couldn't connect GitHub. Try again.",
          )}
        </p>
      ) : null}
      <Dialog
        open={issued !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent
          {...astryxScope}
          finalFocus={() => {
            const trigger = slackCodeTrigger.current;
            return trigger?.isConnected ? trigger : (heading.current ?? true);
          }}
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>Link your Slack account</DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4">
            {issued ? (
              <VStack gap={3} className="text-sm">
                <p>
                  In Slack, open a direct message with the OpenBot app. Paste
                  and send the command below, then return here to check that
                  your account is linked.
                </p>
                <Field>
                  <FieldLabel htmlFor={slackCommandId}>
                    Slack command
                  </FieldLabel>
                  <Input
                    id={slackCommandId}
                    onFocus={(event) => event.currentTarget.select()}
                    readOnly
                    ref={slackCommand}
                    value={`link ${issued.code}`}
                  />
                </Field>
                {copyFailed ? (
                  <p className="text-destructive" role="alert">
                    Couldn't copy automatically. Select and copy the Slack
                    command.
                  </p>
                ) : null}
                {expired ? (
                  <p className="text-muted-foreground" role="status">
                    This code expired. Close this window and request a new code.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Use this one-time code by{" "}
                    <time dateTime={issued.expiresAt}>
                      {new Date(issued.expiresAt).toLocaleTimeString(
                        undefined,
                        {
                          hour: "numeric",
                          minute: "2-digit",
                        },
                      )}
                    </time>
                    .
                  </p>
                )}
              </VStack>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              className="confirmation-action"
              disabled={expired}
              size="sm"
              variant="outline"
              onClick={async () => {
                if (!issued || Date.parse(issued.expiresAt) <= Date.now())
                  return;
                const ok = await copyText(
                  `link ${issued.code}`,
                  navigator.clipboard,
                );
                setCopied(ok);
                setCopyFailed(!ok);
                if (!ok) slackCommand.current?.focus();
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              className="confirmation-action"
              size="sm"
              onClick={closeDialog}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

/** An account type this deployment can link and the person has not linked yet. */
function AvailableAccountRow({
  provider,
  title,
  pending,
  onConnect,
}: {
  provider: string;
  title: string;
  pending: boolean;
  onConnect: (trigger: HTMLButtonElement) => void;
}) {
  const Icon = providerIcon(provider);
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>Not linked</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={`Connect ${title}`}
          size="sm"
          variant="outline"
          aria-disabled={provider === "slack" && pending}
          className={provider === "slack" ? "confirmation-action" : undefined}
          disabled={provider !== "slack" && pending}
          onClick={(event) => onConnect(event.currentTarget)}
        >
          Connect
        </Button>
      </ItemActions>
    </Item>
  );
}

/**
 * One linked account with its own disconnect, so a second click elsewhere neither re-enables this
 * row mid-request nor overwrites its error. A lapse (`needs_reconnect`) also carries the way back:
 * the same connect flow that linked it, so the page never announces a problem it cannot fix.
 */
function LinkedAccountRow({
  account,
  reconnect,
}: {
  account: LinkedAccount;
  reconnect?: { pending: boolean; start: (trigger: HTMLButtonElement) => void };
}) {
  const unlink = useMutation(unlinkMutationOptions(queryClient));
  /*
   * Disconnecting removes OpenBot's recognition of this person at the vendor, which every Bot's
   * GitHub and Slack abilities lean on, so it asks first — the same guard the smaller per-repo
   * disconnect already keeps.
   */
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const Icon = providerIcon(account.provider);
  const lapsed = account.status === "needs_reconnect";
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <Icon />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{account.title}</ItemTitle>
          <ItemDescription className={lapsed ? TURNS_WARN : undefined}>
            {linkedAccountDescription(account)}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {lapsed && reconnect ? (
            <Button
              aria-label={`Reconnect ${account.title}`}
              size="sm"
              type="button"
              aria-disabled={account.provider === "slack" && reconnect.pending}
              className={
                account.provider === "slack" ? "confirmation-action" : undefined
              }
              disabled={account.provider !== "slack" && reconnect.pending}
              onClick={(event) => reconnect.start(event.currentTarget)}
            >
              Reconnect
            </Button>
          ) : null}
          <Button
            aria-label={`Disconnect ${account.title}`}
            size="sm"
            variant="outline"
            disabled={unlink.isPending}
            onClick={(event) =>
              requestConfirmation({
                title: `Disconnect ${account.title}?`,
                description: `OpenBot stops recognising you at ${account.title}${account.handle ? ` as @${account.handle}` : ""}, and anything that relied on it stops working until you link again.`,
                confirmLabel: "Disconnect",
                pendingLabel: "Disconnecting…",
                failureMessage: `Couldn't disconnect ${account.title}. Try again.`,
                variant: "destructive",
                trigger: event.currentTarget,
                run: async () => {
                  await unlink.mutateAsync(account.id);
                },
              })
            }
          >
            Disconnect
          </Button>
        </ItemActions>
      </Item>
      {unlink.error ? (
        <p className="px-3 pb-2 text-destructive text-sm" role="alert">
          Couldn't disconnect {account.title}: {unlink.error.message}
        </p>
      ) : null}
      {confirmation}
    </>
  );
}

/**
 * Write text to the clipboard, answering whether it landed. The clipboard is missing on plain-http
 * hosts and a write is refused when permission is denied; both are a "no", not an exception.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
