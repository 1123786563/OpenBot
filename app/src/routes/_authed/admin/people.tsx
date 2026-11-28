import { Text } from "@astryxdesign/core/Text";
import {
  IconDots,
  IconLock,
  IconSearch,
  IconShieldCheck,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionIncomplete,
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { canKeepCachedRead, ClientError } from "@/lib/client";
import { isComposing } from "@/lib/composing";
import { terminateMemberComputersMutationOptions } from "@/lib/enterprise/mutations";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import {
  type Person,
  peopleAccessDenied,
  peopleListQueryOptions,
} from "@/lib/people/queries";
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
    ? `Last signed in ${new Date(person.lastSignedInAt).toLocaleDateString()}`
    : "Never signed in";
  const role = person.role === "admin" ? "Admin" : "Member";
  return [
    person.revoked ? "Access removed" : null,
    person.configuredAdmin ? "Admin set in deployment configuration" : role,
    providers ? `Sign-in: ${providers}` : null,
    when,
  ]
    .filter(Boolean)
    .join(" · ");
}

type PersonOperation = "stop" | "access" | "role";

function PersonActions({
  person,
  managed,
  onAction,
}: {
  person: Person;
  managed: boolean;
  onAction: (operation: PersonOperation, trigger: HTMLElement) => void;
}) {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const options = [
    { operation: "stop", label: "Stop computers", disabled: false },
    {
      operation: "access",
      label: person.revoked ? "Restore access" : "Remove access",
      disabled: managed,
    },
    {
      operation: "role",
      label: person.role === "admin" ? "Remove admin" : "Grant admin",
      disabled: managed,
    },
  ] as const;
  return (
    <>
      <ItemActions className="sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Actions for ${person.email}`}
                className="min-h-11 min-w-11"
                ref={menuTrigger}
                size="icon"
                variant="outline"
              />
            }
          >
            <IconDots aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {options.map(({ operation, label, disabled }) => (
              <DropdownMenuItem
                className="min-h-11"
                disabled={disabled}
                key={operation}
                onClick={() => {
                  if (menuTrigger.current)
                    onAction(operation, menuTrigger.current);
                }}
              >
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
      <ItemActions className="hidden min-w-0 flex-wrap sm:flex">
        {options.map(({ operation, label, disabled }) => (
          <Button
            aria-label={`${label} for ${person.email}`}
            className="min-h-11"
            disabled={disabled}
            key={operation}
            onClick={(event) => onAction(operation, event.currentTarget)}
            size="sm"
            variant="outline"
          >
            {label}
          </Button>
        ))}
      </ItemActions>
    </>
  );
}

function PeoplePage() {
  const [search, setSearch] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const peopleHeading = useRef<HTMLHeadingElement>(null);
  const moreErrorId = useId();
  const rowTitles = useRef(new Map<string, HTMLDivElement>());
  const pageAdvance = useRef<{
    count: number;
    query: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  const { requestConfirmation, confirmation } = useActionConfirmation();
  /*
   * Debounced, so typing a name is one request rather than one per keystroke against an aggregate
   * over every user in the deployment.
   */
  const [query, setQuery] = useState("");
  const searchChanging = search.trim() !== query;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const people = useInfiniteQuery(peopleListQueryOptions(query));
  const accessDenied = peopleAccessDenied(people.error);
  const loaded =
    !searchChanging &&
    people.data?.pages.length &&
    canKeepCachedRead(people.error)
      ? people.data
      : undefined;
  const canChange = people.isSuccess || people.isFetchNextPageError;
  const rows = loaded?.pages.flatMap((page) => page.people) ?? [];
  useLayoutEffect(() => {
    const advance = pageAdvance.current;
    if (!advance) return;
    if (searchChanging || query !== advance.query) {
      pageAdvance.current = null;
      return;
    }
    if (people.isFetchingNextPage) return;
    if (people.isError) {
      pageAdvance.current = null;
      return;
    }
    const firstAdded = rows[advance.count];
    if (!firstAdded && people.hasNextPage) return;
    pageAdvance.current = null;
    const { trigger } = advance;
    const doc = trigger.ownerDocument;
    if (
      doc.activeElement !== trigger &&
      (trigger.isConnected || doc.activeElement !== doc.body)
    )
      return;
    const target = firstAdded ?? rows.at(-1);
    (target
      ? rowTitles.current.get(target.id)
      : peopleHeading.current
    )?.focus();
  }, [
    people.hasNextPage,
    people.isError,
    people.isFetchingNextPage,
    query,
    rows,
    searchChanging,
  ]);
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  const terminate = useMutation(terminateMemberComputersMutationOptions());

  function confirm(
    person: Person,
    operation: PersonOperation,
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
          try {
            await setAccess.mutateAsync({
              userId: person.id,
              revoked: !person.revoked,
            });
          } catch (error) {
            /*
             * The removal committed and the retirement did not. The server's sentence says which
             * half took effect, and removing them again finishes the other half.
             */
            if (error instanceof ClientError && error.status === 503)
              throw new ActionIncomplete(error.message);
            throw error;
          }
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
        description="Admins set by deployment configuration can’t be changed here."
        headingRef={peopleHeading}
        title="Workspace access"
      >
        {confirmation}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs.
        */}
        <Input
          ref={searchInput}
          aria-label="Search people"
          className="mt-4 min-h-11"
          enterKeyHint="search"
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search && !isComposing(event)) {
              event.preventDefault();
              setSearch("");
            }
          }}
          placeholder="Search by name or address"
          type="search"
          value={search}
        />

        <Text
          as="p"
          color="secondary"
          display="block"
          role="status"
          size="base"
          style={
            rows.length ? { marginBlockStart: "var(--spacing-2)" } : undefined
          }
        >
          {rows.length > 0 ? (
            <>
              {rows.length} {rows.length === 1 ? "person" : "people"} shown.
              {people.hasNextPage ? " More available." : ""}
            </>
          ) : null}
        </Text>

        {searchChanging ||
        people.isPending ||
        (!loaded && people.isFetching && !people.error) ? (
          <ReadStatus
            kind="loading"
            message={search.trim() ? "Searching people…" : "Loading people…"}
          />
        ) : null}
        {!searchChanging &&
        people.error &&
        (!loaded || !people.isFetchNextPageError) ? (
          <ReadError
            description={
              rows.length
                ? "Showing the last loaded people. Retry to make changes."
                : undefined
            }
            message={
              accessDenied
                ? "You don’t have access to this people list."
                : rows.length
                  ? "Couldn't refresh people."
                  : "Couldn't load people."
            }
            focusAfterRetry={() => peopleHeading.current}
            retry={people.refetch}
            retryBelow
            retryLabel="Retry people list"
            retrying={people.isFetching}
          />
        ) : null}
        {!loaded || (people.error && rows.length === 0) ? null : rows.length ===
          0 ? (
          <PageEmpty
            action={
              query ? (
                <Button
                  className="min-h-11"
                  onClick={() => {
                    setSearch("");
                    searchInput.current?.focus();
                  }}
                  type="button"
                  variant="outline"
                >
                  Clear search
                </Button>
              ) : undefined
            }
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
                <Fragment key={person.id}>
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
                      <ItemTitle
                        aria-describedby={`person-summary-${person.id}`}
                        className="line-clamp-none [overflow-wrap:anywhere]"
                        ref={(node) => {
                          if (node) rowTitles.current.set(person.id, node);
                          else rowTitles.current.delete(person.id);
                        }}
                        tabIndex={-1}
                      >
                        {person.name ?? person.email}
                      </ItemTitle>
                      <ItemDescription
                        className="line-clamp-none text-sm [overflow-wrap:anywhere]"
                        id={`person-summary-${person.id}`}
                      >
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person)}
                      </ItemDescription>
                    </ItemContent>
                    {canChange ? (
                      <PersonActions
                        managed={managed}
                        onAction={(operation, trigger) =>
                          confirm(person, operation, trigger)
                        }
                        person={person}
                      />
                    ) : null}
                  </Item>
                  {index !== rows.length - 1 && <Separator />}
                </Fragment>
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
              const trigger = event.currentTarget;
              if (trigger.ownerDocument.activeElement === trigger) {
                pageAdvance.current = { count: rows.length, query, trigger };
              }
              void people.fetchNextPage({ cancelRefetch: false });
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
