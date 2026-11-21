import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { ConnectionAction } from "@/components/connections/connection-surface";
import { CorsairInvocation } from "@/components/connections/corsair-invocation";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  corsairAccountsQueryOptions,
  corsairKeys,
  type CorsairProvider,
  corsairRevocationsQueryOptions,
  corsairWrite,
} from "@/lib/connections/corsair";

type AccountAction =
  | { kind: "authorize" }
  | { kind: "default" | "disconnect" | "retry"; id: string };

const authorization = z.object({
  authorizationUrl: z.url({ protocol: /^https$/ }),
});

export function CorsairAccounts({
  provider,
  outcome,
}: {
  provider: CorsairProvider;
  outcome?: string;
}) {
  const accounts = useQuery(corsairAccountsQueryOptions(provider));
  const revocations = useQuery({
    ...corsairRevocationsQueryOptions(provider),
    enabled: Boolean(accounts.data),
  });
  const queryClient = useQueryClient();
  const [disconnecting, setDisconnecting] = useState<string>();
  const action = useMutation({
    mutationFn: async (input: AccountAction) => {
      switch (input.kind) {
        case "authorize": {
          const response = await corsairWrite(provider, "connect", "POST");
          const { authorizationUrl } = authorization.parse(
            await response.json(),
          );
          window.location.assign(authorizationUrl);
          return;
        }
        case "default":
          await corsairWrite(provider, "connections/default", "PUT", {
            connectionId: input.id,
          });
          return;
        case "disconnect":
        case "retry":
          await corsairWrite(
            provider,
            `connections/${input.id}/revocation`,
            input.kind === "disconnect" ? "DELETE" : "POST",
          );
      }
    },
    onSettled: async (_data, _error, input) => {
      if (input.kind === "authorize") return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: corsairKeys.accounts(provider),
        }),
        queryClient.invalidateQueries({
          queryKey: corsairKeys.revocations(provider),
        }),
      ]);
    },
  });

  if (accounts.data === null || accounts.isPending) return null;
  const title = provider === "github" ? "GitHub" : "Slack";
  const current = accounts.data?.accounts ?? [];
  const activeIds = new Set(current.map((account) => account.id));
  const disconnected = revocations.data?.filter(
    (account) => !activeIds.has(account.id),
  );
  const usable = current.filter((account) => !account.needsAuthorization);
  const defaultId = accounts.data?.defaultConnectionId;
  const pending = action.isPending;

  return (
    <PageSection title="Personal tool accounts">
      {outcome === "connected" ? (
        <p className="text-sm text-muted-foreground" role="status">
          {title} authorization completed.
        </p>
      ) : null}
      {outcome === "failed" ? (
        <p className="text-sm text-destructive" role="alert">
          {title} authorization could not be completed. Start again here.
        </p>
      ) : null}
      {accounts.isError ? (
        <>
          <p className="text-sm text-destructive" role="alert">
            Couldn't load your {title} tool accounts.
          </p>
          <ConnectionAction
            variant="outline"
            onClick={() => void accounts.refetch()}
          >
            Retry
          </ConnectionAction>
        </>
      ) : (
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Authorize a {title} account</ItemTitle>
              <ItemDescription className="line-clamp-none">
                Choose the same account at {title} to reauthorize it. To use a
                legacy Broker account in Corsair, authorize it here first. An
                existing default carries over after its identity is verified.
                {defaultId
                  ? ""
                  : " Choose a default after authorizing an account."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <ConnectionAction
                disabled={pending}
                onClick={() => action.mutate({ kind: "authorize" })}
              >
                {current.length
                  ? "Authorize another or reconnect"
                  : "Authorize account"}
              </ConnectionAction>
            </ItemActions>
          </Item>
          {current.map((account) => (
            <AccountRow key={account.id}>
              <ItemContent>
                <ItemTitle>{account.label}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {account.identity} ·{" "}
                  {account.needsAuthorization
                    ? "Reauthorization required"
                    : "Authorized"}
                  {account.id === defaultId ? " · Default" : ""}
                </ItemDescription>
                {disconnecting === account.id ? (
                  <ItemDescription className="line-clamp-none">
                    OpenBot will stop using this account immediately and check
                    whether
                    {title} has revoked access.
                  </ItemDescription>
                ) : null}
              </ItemContent>
              <ItemActions>
                {disconnecting === account.id ? (
                  <>
                    <ConnectionAction
                      variant="outline"
                      disabled={pending}
                      onClick={() => setDisconnecting(undefined)}
                    >
                      Cancel
                    </ConnectionAction>
                    <ConnectionAction
                      disabled={pending}
                      onClick={() => {
                        setDisconnecting(undefined);
                        action.mutate({ kind: "disconnect", id: account.id });
                      }}
                    >
                      Confirm disconnect
                    </ConnectionAction>
                  </>
                ) : (
                  <>
                    {account.id !== defaultId && !account.needsAuthorization ? (
                      <ConnectionAction
                        aria-label={`Make ${account.label} (${account.identity}) default`}
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          action.mutate({ kind: "default", id: account.id })
                        }
                      >
                        Make default
                      </ConnectionAction>
                    ) : null}
                    <ConnectionAction
                      aria-label={`Disconnect ${account.label} (${account.identity})`}
                      variant="outline"
                      disabled={pending}
                      onClick={() => setDisconnecting(account.id)}
                    >
                      Disconnect
                    </ConnectionAction>
                  </>
                )}
              </ItemActions>
            </AccountRow>
          ))}
          {disconnected?.map((account) => (
            <AccountRow key={account.id}>
              <ItemContent>
                <ItemTitle>{account.label}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {account.revocation.status === "pending"
                    ? "Disconnected · Provider revocation pending confirmation"
                    : "Disconnected · Provider revocation confirmed"}
                </ItemDescription>
              </ItemContent>
              {account.revocation.status === "pending" ? (
                <ItemActions>
                  <ConnectionAction
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      action.mutate({ kind: "retry", id: account.id })
                    }
                  >
                    Check revocation
                  </ConnectionAction>
                </ItemActions>
              ) : null}
            </AccountRow>
          ))}
        </PageRows>
      )}
      {revocations.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {revocations.error.message}
        </p>
      ) : null}
      {action.isError ? (
        <p className="text-sm text-destructive" role="alert">
          {action.error.message}
        </p>
      ) : null}
      {accounts.data ? (
        <CorsairInvocation
          provider={provider}
          accounts={usable}
          defaultId={defaultId}
        />
      ) : null}
    </PageSection>
  );
}

function AccountRow({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Separator />
      <Item size="sm">{children}</Item>
    </>
  );
}
