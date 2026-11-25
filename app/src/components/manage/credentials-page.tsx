import { IconKey, IconPlus } from "@tabler/icons-react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
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
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { canKeepCachedRead, ClientError } from "@/lib/client";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import {
  type CredentialStatus,
  type CredentialUsage,
  credentialKindLabel,
  credentialListQueryOptions,
  credentialUsageQueryOptions,
} from "@/lib/credentials/queries";
import { useManagePaths } from "@/lib/manage-paths";

declare module "@tanstack/react-router" {
  interface HistoryState {
    replaceCredentialId?: string;
    replacedCredentialId?: string;
  }
}

export function CredentialsPage() {
  const paths = useManagePaths();
  const addButton = useRef<HTMLAnchorElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const replacedRow = useRef<HTMLDivElement>(null);
  const restoredEntry = useRef<string | undefined>(undefined);
  const { __TSR_key: historyKey, replacedCredentialId } = useLocation({
    select: (location) => location.state,
  });
  const firstMatch = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const personal = paths.edition === "personal";
  const entry = personal ? "key" : "credential";
  // The credential being revoked. What uses it is read while the confirmation is open, and the
  // confirmation cannot be submitted until that read has answered.
  const [revoking, setRevoking] = useState<CredentialStatus | null>(null);
  const usage = useQuery({
    ...credentialUsageQueryOptions(revoking?.id ?? ""),
    enabled: revoking !== null,
  });
  const { requestConfirmation, confirmation } = useActionConfirmation({
    content: revoking ? (
      <CredentialUse
        deploymentName={paths.deploymentName}
        entry={entry}
        usage={usage}
      />
    ) : null,
    ready: revoking !== null && usage.isSuccess && usage.fetchStatus === "idle",
    onClose: () => setRevoking(null),
  });
  const queryClient = useQueryClient();
  const credentials = useQuery(credentialListQueryOptions());
  const entries = canKeepCachedRead(credentials.error)
    ? credentials.data
    : undefined;
  const terms = settingsSearchTerms(search);
  const matches =
    entries?.filter(({ provider, kind, keyId }) => {
      const searchable = `${provider} ${kind} ${keyId}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    }) ?? [];
  const revokeCredential = useMutation(
    revokeCredentialMutationOptions(queryClient),
  );
  useEffect(() => {
    if (
      !historyKey ||
      !replacedCredentialId ||
      credentials.isPending ||
      credentials.isFetching ||
      restoredEntry.current === historyKey
    )
      return;
    const frame = requestAnimationFrame(() => {
      restoredEntry.current = historyKey;
      if (document.activeElement === document.body) {
        const row = replacedRow.current;
        if (row) {
          row.focus({ preventScroll: true });
          row.scrollIntoView({ block: "center" });
        } else {
          heading.current?.focus();
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    credentials.isFetching,
    credentials.isPending,
    historyKey,
    replacedCredentialId,
  ]);

  return (
    <PageShell
      action={
        // Its own screen, `credentials_.new.tsx`, which says why the form is not on this page.
        <Button
          render={(props) => (
            <Link {...props} {...paths.newCredential()} ref={addButton} />
          )}
          size="sm"
          className="min-h-11"
          variant="ghost"
        >
          <IconPlus />
          Add {entry}
        </Button>
      }
      description={
        personal
          ? "API keys and tokens your apps and models use. A saved key can't be viewed again."
          : "Manage this deployment’s keys and tokens. Saved secrets cannot be viewed again."
      }
      title={paths.credentialsLabel}
      headingRef={heading}
    >
      <PageSection title={personal ? "Saved keys" : "Saved credentials"}>
        {confirmation}
        {replacedCredentialId &&
        !credentials.isPending &&
        !credentials.isFetching &&
        !entries?.some(
          (credential) =>
            credential.id === replacedCredentialId && !credential.revokedAt,
        ) ? (
          <p className="text-sm" role="status">
            Replacement saved.
          </p>
        ) : null}
        {credentials.isPending ? (
          <ReadStatus kind="loading" message={`Loading ${entry}s…`} />
        ) : credentials.isError ? (
          <ReadError
            description={
              entries?.length
                ? "Showing the last list we could load."
                : undefined
            }
            message={`Couldn't load ${entry}s.`}
            retry={credentials.refetch}
            retryBelow
            retrying={credentials.isFetching}
          />
        ) : null}
        {entries?.length ? (
          <SettingsListSearch
            noun={`${entry}s`}
            placeholder="Provider, type or key ID"
            value={search}
            onChange={setSearch}
            onEnter={() => firstMatch.current?.focus()}
            matches={matches.length}
            total={entries.length}
          />
        ) : null}
        {credentials.isSuccess && entries?.length === 0 ? (
          <PageEmpty icon={IconKey} title={`No ${entry}s yet`}>
            Use Add {entry} to save an API key or token.
          </PageEmpty>
        ) : matches.length ? (
          <PageRows>
            {matches.map((credential, index) => {
              const replaced =
                !credential.revokedAt && credential.id === replacedCredentialId;
              return (
                <StaggerItem index={index} key={credential.id}>
                  <Item
                    aria-label={
                      replaced
                        ? `${credential.provider} · ${credential.keyId} · active`
                        : undefined
                    }
                    ref={replaced ? replacedRow : undefined}
                    role={replaced ? "group" : undefined}
                    size="sm"
                    tabIndex={replaced ? -1 : undefined}
                  >
                    <ItemContent style={{ minInlineSize: 0 }}>
                      <ItemTitle
                        className="wrap-anywhere"
                        ref={index === 0 ? firstMatch : undefined}
                        tabIndex={-1}
                      >
                        {credential.provider}
                      </ItemTitle>
                      <ItemDescription className="line-clamp-none wrap-anywhere">
                        {credentialKindLabel(credential.kind)} ·{" "}
                        {credential.keyId} ·{" "}
                        {credential.revokedAt ? "revoked" : "active"}
                      </ItemDescription>
                      {replaced ? (
                        <ItemDescription
                          className="line-clamp-none"
                          role="status"
                        >
                          Replacement saved.
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions style={{ flexWrap: "wrap" }}>
                      {credentials.isSuccess &&
                      !credential.revokedAt &&
                      (credential.kind === "model" ||
                        credential.kind === "connector") ? (
                        <Button
                          aria-label={`Replace ${credential.keyId} for ${credential.provider}`}
                          className="min-h-11"
                          render={(props) => (
                            <Link
                              {...props}
                              {...paths.newCredential()}
                              state={{ replaceCredentialId: credential.id }}
                            />
                          )}
                          size="sm"
                          variant="ghost"
                        >
                          Replace
                        </Button>
                      ) : null}
                      <Button
                        aria-label={`Revoke ${credential.keyId} for ${credential.provider}`}
                        disabled={
                          Boolean(credential.revokedAt) ||
                          !credentials.isSuccess
                        }
                        onClick={(event) => {
                          setRevoking(credential);
                          requestConfirmation({
                            title: `Revoke ${credential.keyId} for ${credential.provider}?`,
                            description: personal
                              ? `This is a ${credentialKindLabel(credential.kind)} key. Revocation is permanent. Add a replacement key to restore access.`
                              : `This is a ${credentialKindLabel(credential.kind)} credential for this deployment. Revocation is permanent. Add a replacement credential to restore access.`,
                            confirmLabel: `Revoke ${entry}`,
                            pendingLabel: `Revoking ${entry}…`,
                            failureMessage:
                              "Revocation could not be confirmed. Try again to check the credential’s status.",
                            successMessage: `${credential.keyId} was revoked.`,
                            trigger: event.currentTarget,
                            fallbackFocus: () => addButton.current,
                            refresh: () => credentials.refetch(),
                            run: async () => {
                              const latest = await credentials.refetch({
                                throwOnError: true,
                              });
                              const current = latest.data?.find(
                                (item) => item.id === credential.id,
                              );
                              if (!current || current.revokedAt) {
                                throw new ActionUnavailable(
                                  "This credential is missing or already revoked. Close this dialog and review the list.",
                                );
                              }
                              await revokeCredential.mutateAsync(credential.id);
                            },
                          });
                        }}
                        size="sm"
                        className="min-h-11"
                        variant="outline"
                      >
                        Revoke
                      </Button>
                    </ItemActions>
                  </Item>
                  {index !== matches.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        ) : null}
      </PageSection>
    </PageShell>
  );
}

/**
 * What holds a credential, inside the confirmation that revokes it.
 *
 * Read while the dialog is open, from the rows that keep the credential's id: a failed read offers
 * its own retry in place, and the Revoke button stays disabled until the answer is in, so a key
 * that stops a Bot's runs is not withdrawn without that first being on screen.
 */
function CredentialUse({
  deploymentName,
  entry,
  usage,
}: {
  deploymentName: string;
  entry: string;
  usage: UseQueryResult<CredentialUsage>;
}) {
  if (usage.error)
    return (
      <ReadError
        // The server's own sentence when it sent one: it knows whether the credential is gone.
        message={
          usage.error instanceof ClientError
            ? usage.error.message
            : `Couldn’t check what uses this ${entry}.`
        }
        retry={() => usage.refetch()}
        retryLabel="Retry preview"
        retrying={usage.isFetching}
      />
    );
  if (!usage.isSuccess || usage.fetchStatus !== "idle")
    return (
      <ReadStatus
        kind="loading"
        message={`Checking what uses this ${entry}…`}
      />
    );

  const { features, bots } = usage.data;
  const rows = [
    ...bots.map((bot) => ({
      key: `bot:${bot.id}`,
      title: bot.name,
      note: "Bot",
    })),
    ...features.map((feature) => ({
      key: `feature:${feature}`,
      title: feature,
      note: undefined,
    })),
  ];
  return (
    <Field aria-labelledby="credential-use" aria-live="polite">
      <FieldLabel id="credential-use">What uses it</FieldLabel>
      {rows.length === 0 ? (
        <p>{`Nothing in ${deploymentName} points at this ${entry}.`}</p>
      ) : (
        <PageRows>
          {rows.map((row, index) => (
            <Fragment key={row.key}>
              {index > 0 ? <Separator /> : null}
              <Item className="px-0" size="sm">
                <ItemContent>
                  <ItemTitle className="wrap-anywhere">{row.title}</ItemTitle>
                  {row.note ? (
                    <ItemDescription>{row.note}</ItemDescription>
                  ) : null}
                </ItemContent>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </Field>
  );
}
