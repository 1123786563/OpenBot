import { IconKey, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { canKeepCachedRead } from "@/lib/client";
import { revokeCredentialMutationOptions } from "@/lib/credentials/mutations";
import { credentialListQueryOptions } from "@/lib/credentials/queries";
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
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const personal = paths.edition === "personal";
  const entry = personal ? "key" : "credential";
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
                        {credential.kind} · {credential.keyId} ·{" "}
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
                        onClick={(event) =>
                          requestConfirmation({
                            title: `Revoke ${credential.keyId} for ${credential.provider}?`,
                            description: personal
                              ? "Apps or models using this credential may stop working. Revocation is permanent. Add a replacement credential to restore access."
                              : "This revokes the credential for this deployment. Any apps or models using it may stop working. Revocation is permanent. Add a replacement credential to restore access.",
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
                          })
                        }
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
