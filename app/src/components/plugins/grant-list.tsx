import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { failureMessage } from "@/lib/client";
import { consentCopy } from "@/lib/plugins/enablement-notes";
import {
  authorizeActionMutationOptions,
  consentActionsFrom,
  couldNotRead,
  type GrantGroup,
  type GrantState,
  grantsQueryOptions,
  groupGrants,
  RANK,
} from "@/lib/plugins/grants";

/**
 * What one account holds at one app, action by action, grouped by the permission each action needs.
 *
 * ONE ROW PER ACTION, DRAWN FROM ITS `GrantState` AND NOTHING ELSE. Authorize is offered for
 * `needs-consent` only: a `needs-operator` action is blocked by a deployment secret that no amount
 * of consenting moves, and an `unknown` one offers a Retry, because not knowing is not the same as
 * not connected and telling somebody to authorize what they already authorized sends them round
 * twice.
 *
 * NO ORDERING BY "RECENTLY REFUSED". Authorized actions come first, then the unauthorized ones in
 * state order, and only the tail beyond `UNAUTHORIZED_SHOWN` sits behind the search; there is no
 * per-person, per-app refusal read on any route this page can call, and inventing a column to order
 * on would be a claim this page could not back.
 */

/** How many unauthorized actions are drawn before the rest are left to the search. */
const UNAUTHORIZED_SHOWN = 10;

export function GrantList({
  serverId,
  appNames,
  canAuthorize,
  landedAction,
  returnTo,
}: {
  serverId: string;
  /** Every name this app goes by, so the route's synthetic toolkit-named entry is recognised. */
  appNames: readonly string[];
  /** Whether this viewer may mint a consent. State is shown to everyone; minting is not. */
  canAuthorize: boolean;
  landedAction: string | null;
  returnTo: "settings" | "admin";
}) {
  const grants = useQuery(grantsQueryOptions(serverId, true));
  const [search, setSearch] = useState("");
  const [choosing, setChoosing] = useState<string | null>(null);
  const choiceTrigger = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const authorize = useMutation({
    ...authorizeActionMutationOptions(returnTo),
    onError: (thrown: Error) => setNotice(failureMessage(thrown)),
    /* A full page navigation: the consent screen is the vendor's own and shown in this browser. */
    onSuccess: (authorizationUrl) => {
      if (authorizationUrl === null) {
        setNotice(
          "OpenBot answered without a consent link, so nothing was authorized. Try again, or ask an admin if it keeps happening.",
        );
        return;
      }
      window.location.href = authorizationUrl;
    },
  });

  if (grants.isPending) {
    return (
      <PageSection title="Actions">
        <ReadStatus kind="loading" message="Checking allowed actions…" />
      </PageSection>
    );
  }
  if (grants.error) {
    return (
      <PageSection title="Actions">
        <ReadError
          message="Couldn't read what this account allows right now."
          retry={grants.refetch}
          retrying={grants.isFetching}
          retryBelow
        />
      </PageSection>
    );
  }

  const all = grants.data ?? [];
  if (couldNotRead(all, appNames)) {
    const [only] = all;
    return (
      <PageSection title="Actions">
        {/* Not an action: the entry's label is the toolkit's own name, which a person must not
            see in their grant list as if it were one. */}
        <p data-could-not-read="" role="status" className="text-sm">
          Couldn't read what this account allows right now.
          {only?.state === "unknown" ? ` ${only.reason}` : null}{" "}
          <Button
            onClick={() => grants.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </p>
      </PageSection>
    );
  }

  const term = search.trim().toLowerCase();
  const unauthorized = all
    .filter((grant) => grant.state !== "authorized")
    .sort(
      (left, right) =>
        RANK[left.state] - RANK[right.state] ||
        left.action.localeCompare(right.action),
    );
  /* With no search term the first unauthorized actions are drawn as well: an Authorize that only
     appears once somebody guesses a substring is an Authorize nobody on a fresh account can reach,
     and a fresh account is every first visit. Beyond those, the count below still stands. */
  const shown =
    term.length > 0
      ? all.filter((grant) => grant.action.toLowerCase().includes(term))
      : [
          ...all.filter((grant) => grant.state === "authorized"),
          ...unauthorized.slice(0, UNAUTHORIZED_SHOWN),
        ];
  const hidden =
    term.length > 0 ? 0 : Math.max(unauthorized.length - UNAUTHORIZED_SHOWN, 0);
  const groups: GrantGroup[] = groupGrants(shown);
  const consentActions = consentActionsFrom(all);
  const selected = canAuthorize
    ? shown.find(
        (grant) => grant.action === choosing && grant.state === "needs-consent",
      )
    : undefined;
  const cancelChoice = () => {
    setChoosing(null);
    setNotice(null);
    choiceTrigger.current?.focus();
  };

  return (
    <PageSection
      description="Grouped by the permission each action asks for. This matches what the consent screen shows."
      title="Actions"
    >
      {notice && !selected ? (
        <p className="text-destructive text-sm" role="alert">
          {notice}
        </p>
      ) : null}
      <Input
        aria-label="Search actions"
        className="min-h-11"
        disabled={authorize.isPending}
        onChange={(event) => {
          setChoosing(null);
          setNotice(null);
          setSearch(event.target.value);
        }}
        placeholder="Search actions"
        type="search"
        value={search}
      />
      {groups.map((group) => (
        <VStack
          data-grant-group={
            group.kind === "scoped" ? group.scopes.join(", ") : group.kind
          }
          key={group.scopes.join("\u0000") || group.kind}
        >
          <p className="mb-1 text-muted-foreground text-xs">
            {group.kind === "whole-app"
              ? "Everything in this app, approved together"
              : group.kind === "none"
                ? "Asks for no permission of its own"
                : `Needs ${group.scopes.join(", ")}`}
          </p>
          <PageRows>
            {group.grants.map((grant) => (
              <Fragment key={grant.action}>
                <Item
                  data-action={grant.action}
                  data-landed={grant.action === landedAction ? "" : undefined}
                  data-state={grant.state}
                  size="sm"
                >
                  <ItemContent>
                    <ItemTitle>{grant.action}</ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {describe(grant, canAuthorize)}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {grant.state === "needs-consent" && canAuthorize ? (
                      <Button
                        className="min-h-11"
                        disabled={authorize.isPending}
                        onClick={(event) => {
                          choiceTrigger.current = event.currentTarget;
                          setNotice(null);
                          setChoosing(grant.action);
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Authorize
                      </Button>
                    ) : null}
                    {grant.state === "unknown" ? (
                      <Button
                        className="min-h-11"
                        disabled={grants.isFetching}
                        onClick={() => grants.refetch()}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Retry
                      </Button>
                    ) : null}
                  </ItemActions>
                </Item>
                {selected?.action === grant.action ? (
                  <ConsentNotice
                    action={grant.action}
                    busy={authorize.isPending}
                    error={notice}
                    onCancel={cancelChoice}
                    onContinue={() =>
                      authorize.mutate({ serverId, action: grant.action })
                    }
                    sentence={
                      consentCopy(grant.action, consentActions).sentence
                    }
                  />
                ) : null}
              </Fragment>
            ))}
          </PageRows>
        </VStack>
      ))}
      {hidden > 0 ? (
        <p className="text-muted-foreground text-sm">
          {hidden} more {hidden === 1 ? "action" : "actions"} not yet
          authorized. Search to find {hidden === 1 ? "it" : "one"}.
        </p>
      ) : null}
      {term.length > 0 && groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No action matches that search.
        </p>
      ) : null}
    </PageSection>
  );
}

/**
 * What somebody reads immediately before being sent to a consent screen. The sentence is
 * `consentCopy`'s and is rendered as it came, never reworded here.
 */
function ConsentNotice({
  action,
  busy,
  error,
  sentence,
  onCancel,
  onContinue,
}: {
  action: string;
  busy: boolean;
  error: string | null;
  sentence: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const summary = useId();
  const panel = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);

  return (
    <fieldset
      aria-describedby={summary}
      aria-label={`Before you authorize ${action}`}
      className="mx-4 mb-4 flex min-w-0 flex-col gap-2 rounded-lg border p-3"
      data-consent-copy=""
      onKeyDown={(event) => {
        if (event.key !== "Escape" || busy) return;
        event.stopPropagation();
        onCancel();
      }}
      ref={panel}
      tabIndex={-1}
    >
      <p className="wrap-anywhere text-sm" id={summary}>
        {sentence}
      </p>
      {error ? (
        <p className="wrap-anywhere text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <HStack gap={2} hAlign="end" wrap="wrap">
        <Button
          className="min-h-11"
          disabled={busy}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          className="min-h-11"
          disabled={busy}
          onClick={onContinue}
          size="sm"
          type="button"
          variant="outline"
        >
          Continue to consent
        </Button>
      </HStack>
    </fieldset>
  );
}

function describe(grant: GrantState, canAuthorize: boolean): string {
  switch (grant.state) {
    case "authorized":
      // Nobody authorized an action that needs no authorization, so the row does not say they did.
      return grant.authorization === "not-required"
        ? "Needs no authorization."
        : "Authorized.";
    case "needs-consent":
      return canAuthorize
        ? "Not authorized yet."
        : "Not authorized yet. An admin can authorize it.";
    case "needs-operator":
      return grant.missing.length > 0
        ? `Missing ${grant.missing.join(", ")}. An admin has to set it. Authorizing can't fix it.`
        : "A setting is missing. An admin has to set it. Authorizing can't fix it.";
    case "unknown":
      return `Couldn't read this one right now. ${grant.reason}`;
  }
}
