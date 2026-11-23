import {
  IconLock,
  IconSearch,
  IconShieldCheck,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { StaggerItem } from "@/components/layout/stagger";
import {
  ActionIncomplete,
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
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
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { canKeepCachedRead } from "@/lib/client";
import { terminateMemberComputersMutationOptions } from "@/lib/enterprise/mutations";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/people")({
  component: PeoplePage,
});

/** What each provider is called, since the id it registers under is not a name. */
const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
};

/**
 * The second line of a person's row: how they got here, and when they were last here.
 *
 * The address is the title, so this is everything else worth knowing at a glance while deciding
 * whether somebody should still have access.
 */
function describe(person: Person): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? `last signed in ${new Date(person.lastSignedInAt).toLocaleDateString()}`
    : "never signed in";

  if (person.revoked)
    return `Access removed · ${providers || "no provider"} · ${when}`;
  if (person.configuredAdmin) {
    return `Admin by configuration · ${when}`;
  }
  const role = person.role === "admin" ? "Admin" : "Member";
  return `${role} · ${providers || "no provider"} · ${when}`;
}

function PeoplePage() {
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const peopleHeading = useRef<HTMLHeadingElement>(null);
  const moreErrorId = useId();
  const { requestConfirmation, confirmation } = useActionConfirmation();
  /*
   * Debounced, so typing a name is one request rather than one per keystroke against an aggregate
   * over every user in the deployment.
   */
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useInfiniteQuery(peopleListQueryOptions(query));
  const loaded = canKeepCachedRead(people.error) ? people.data : undefined;
  const rows = loaded?.pages.flatMap((page) => page.people) ?? [];
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  const terminate = useMutation(terminateMemberComputersMutationOptions());

  function confirm(
    person: Person,
    operation: "stop" | "access" | "role",
    trigger: HTMLElement,
  ) {
    const email = person.email;

    let attemptedRevocation = false;

    async function currentPerson() {
      const latest = await people.refetch({ throwOnError: true });
      const current = latest.data?.pages
        .flatMap((page) => page.people)
        .find((candidate) => candidate.id === person.id);
      if (!current || current.email !== email) {
        throw new ActionUnavailable(
          "This person’s record changed. Close this dialog and review the list.",
        );
      }
      if (
        operation !== "stop" &&
        (current.role !== person.role ||
          current.configuredAdmin ||
          (current.revoked !== person.revoked && !attemptedRevocation))
      ) {
        throw new ActionUnavailable(
          "This person’s role or access changed. Close this dialog and review their current permissions.",
        );
      }
    }

    const common = {
      trigger,
      fallbackFocus: () => searchInput.current,
      refresh: () => people.refetch(),
    };

    if (operation === "stop") {
      requestConfirmation({
        ...common,
        title: `Stop computers for ${email}?`,
        description:
          "This stops their running computer and the computers of Bots they own. Active work can be interrupted. Disks are kept, and the computers can start again in a later session.",
        confirmLabel: "Stop computers",
        pendingLabel: "Stopping computers…",
        failureMessage: "The stop request could not be confirmed. Try again.",
        run: async () => {
          await currentPerson();
          const result = await terminate.mutateAsync(person.id);
          const stopped = result.stopped.length;
          const failed = result.failed.length;
          const stoppedMessage = `Stopped ${stopped} ${stopped === 1 ? "computer" : "computers"} for ${email}.`;
          if (failed > 0) {
            throw new ActionIncomplete(
              `${stoppedMessage} Still unable to stop ${failed}. Try again to stop the remaining computers.`,
            );
          }
          return stopped === 0
            ? `No running computers for ${email}.`
            : stoppedMessage;
        },
      });
      return;
    }

    if (operation === "access") {
      const label = person.revoked ? "Restore access" : "Remove access";
      requestConfirmation({
        ...common,
        title: `${label} for ${email}?`,
        description: person.revoked
          ? "This restores their sign-in access to this workspace. Credentials retired when access was removed stay revoked."
          : "This person loses access to this workspace and their owned credentials are retired. You can restore sign-in access later. Retired credentials need to be replaced.",
        confirmLabel: label,
        pendingLabel: "Updating access…",
        failureMessage:
          "The access change could not be confirmed. Try again to check their current access.",
        successMessage: person.revoked
          ? `Access restored for ${email}.`
          : `Access removed for ${email}.`,
        variant: person.revoked ? "default" : "destructive",
        run: async () => {
          await currentPerson();
          attemptedRevocation = !person.revoked;
          await setAccess.mutateAsync({
            userId: person.id,
            revoked: !person.revoked,
          });
        },
      });
      return;
    }

    const promote = person.role !== "admin";
    const label = promote ? "Grant admin" : "Remove admin";
    requestConfirmation({
      ...common,
      title: `${label} for ${email}?`,
      description: promote
        ? "They can manage people and deployment settings in Admin. Another administrator can remove this role later."
        : "They lose access to Admin pages and admin actions. Their workspace access stays as it is. An administrator can grant the role again.",
      confirmLabel: label,
      pendingLabel: "Updating role…",
      failureMessage:
        "The role change could not be confirmed. Try again to check their current role.",
      successMessage: `Admin role ${promote ? "granted to" : "removed from"} ${email}.`,
      variant: promote ? "default" : "destructive",
      run: async () => {
        await currentPerson();
        await setRole.mutateAsync({
          userId: person.id,
          role: promote ? "admin" : "user",
        });
      },
    });
  }

  return (
    <PageShell
      description="Manage access for people who have signed in. Only admins can access the Admin pages."
      title="People"
    >
      <PageSection
        description="Addresses in INITIAL_ADMIN_EMAILS are always admins. You can't change them here."
        headingRef={peopleHeading}
        title="Who is here"
      >
        {confirmation}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs.
        */}
        <Input
          ref={searchInput}
          aria-label="Search people"
          className="mt-4"
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or address"
          value={search}
        />

        {people.isPending ? (
          <ReadStatus kind="loading" message="Loading people…" />
        ) : null}
        {people.error && (!loaded || !people.isFetchNextPageError) ? (
          <ReadError
            description={
              rows.length ? "Showing the last loaded people." : undefined
            }
            message={
              rows.length ? "Couldn't refresh people." : "Couldn't load people."
            }
            retry={people.refetch}
            retryBelow
            retrying={people.isFetching}
          />
        ) : null}
        {!loaded || (people.error && rows.length === 0) ? null : rows.length ===
          0 ? (
          <PageEmpty
            icon={query ? IconSearch : IconUsers}
            title={query ? "No matches" : "Nobody has signed in yet"}
          >
            {query
              ? `Nobody matches "${query}".`
              : "People show here once they do."}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((person, index) => {
              const isSelf = person.id === currentUser.data?.id;
              const managed = isSelf || person.configuredAdmin;

              return (
                <StaggerItem index={index} key={person.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {person.revoked ? (
                        <IconLock />
                      ) : person.role === "admin" ? (
                        <IconShieldCheck />
                      ) : (
                        <IconUser />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{person.name ?? person.email}</ItemTitle>
                      <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions className="min-w-0 flex-wrap max-sm:basis-full">
                      <Button
                        aria-label={`Stop computers for ${person.email}`}
                        className="min-h-11"
                        onClick={(event) =>
                          confirm(person, "stop", event.currentTarget)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Stop computers
                      </Button>
                      <Button
                        aria-label={`${person.revoked ? "Restore" : "Remove"} access for ${person.email}`}
                        className="min-h-11"
                        disabled={managed}
                        onClick={(event) =>
                          confirm(person, "access", event.currentTarget)
                        }
                        size="sm"
                        variant="outline"
                      >
                        {person.revoked ? "Restore access" : "Remove access"}
                      </Button>
                      <Button
                        aria-label={`${person.role === "admin" ? "Remove" : "Grant"} admin for ${person.email}`}
                        className="min-h-11"
                        disabled={managed}
                        onClick={(event) =>
                          confirm(person, "role", event.currentTarget)
                        }
                        size="sm"
                        variant="outline"
                      >
                        {person.role === "admin"
                          ? "Remove admin"
                          : "Grant admin"}
                      </Button>
                    </ItemActions>
                  </Item>
                  {index !== rows.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}

        {/*
          Only when there is one. A button that says there is more when there is not is worse than
          no button, and this list ends for most deployments on the first page.
        */}
        {loaded && people.isFetchNextPageError ? (
          <p
            className="mt-4 text-destructive text-sm"
            id={moreErrorId}
            role="alert"
          >
            Couldn't load more people. The people already loaded are still
            shown.
          </p>
        ) : null}
        {loaded && people.hasNextPage ? (
          <Button
            aria-describedby={
              people.isFetchNextPageError ? moreErrorId : undefined
            }
            aria-disabled={people.isFetching}
            className="mt-4 min-h-11"
            onClick={(event) => {
              if (people.isFetching) return;
              const button = event.currentTarget;
              const document = button.ownerDocument;
              const focused = document.activeElement === button;
              void people
                .fetchNextPage({ cancelRefetch: false })
                .then((result) => {
                  if (
                    focused &&
                    result.isSuccess &&
                    !result.hasNextPage &&
                    (document.activeElement === button ||
                      (!button.isConnected &&
                        document.activeElement === document.body))
                  ) {
                    peopleHeading.current?.focus();
                  }
                });
            }}
            size="sm"
            variant="outline"
          >
            {people.isFetchingNextPage
              ? "Loading…"
              : people.isFetchNextPageError
                ? "Retry loading more"
                : "Show more"}
          </Button>
        ) : null}
      </PageSection>
    </PageShell>
  );
}
