import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { IconChevronRight, IconSearch } from "@tabler/icons-react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
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
import { Separator } from "@/components/ui/separator";
import type { CapabilityAnswer } from "@/lib/capability-changes/queries";
import { ClientError, canKeepCachedRead } from "@/lib/client";
import { memberAccessQueryOptions } from "@/lib/enterprise/queries";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";

export function MemberAccess() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      className="[&_.astryx-collapsible-trigger]:min-h-12 [&_.astryx-collapsible-trigger]:rounded-lg [&_.astryx-collapsible-trigger]:font-medium"
      isOpen={open}
      onOpenChange={setOpen}
      trigger="Check a member's access"
    >
      {open ? <MemberAccessLookup /> : null}
    </Collapsible>
  );
}

function MemberAccessLookup() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Person | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const returnToSearch = useRef(false);
  const searchPending = search.trim() !== query;
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useLayoutEffect(() => {
    if (!selected && returnToSearch.current) {
      input.current?.focus();
      returnToSearch.current = false;
    }
  }, [selected]);
  const directory = useInfiniteQuery({
    ...peopleListQueryOptions(query),
    enabled: selected === null && !searchPending,
    retry: false,
  });
  const people = canKeepCachedRead(directory.error)
    ? directory.data?.pages.flatMap((page) => page.people)
    : undefined;

  return (
    <VStack gap={3} paddingBlock={3} ref={results}>
      {selected ? (
        <>
          <Button
            className="min-h-12 self-start"
            onClick={() => {
              returnToSearch.current = true;
              setSelected(null);
            }}
            type="button"
            variant="outline"
          >
            Choose another member
          </Button>
          <MemberAccessResult key={selected.id} member={selected} />
        </>
      ) : (
        <>
          <Text as="p" color="secondary" size="sm">
            Find a member to see their current permissions and which rules grant
            or deny access.
          </Text>
          <Input
            aria-label="Search members by name or email"
            className="min-h-12"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or email"
            ref={input}
            value={search}
          />
          {searchPending ||
          (directory.isPending && directory.errorUpdateCount === 0) ? (
            <ReadStatus kind="loading" message="Finding members…" />
          ) : (
            <>
              {directory.isError && !directory.isFetchNextPageError ? (
                <ReadError
                  focusAfterRetry={() => input.current}
                  message="Couldn't load members."
                  retry={directory.refetch}
                  retryBelow
                  retrying={directory.isFetching}
                />
              ) : null}
              {people && people.length > 0 ? (
                <PageRows>
                  {people.map((person, index) => (
                    <Fragment key={person.id}>
                      {index > 0 && <Separator />}
                      <Item
                        className="min-h-12 text-left"
                        render={
                          <button
                            onClick={() => setSelected(person)}
                            data-member-result=""
                            type="button"
                          />
                        }
                        size="sm"
                      >
                        <ItemContent>
                          <ItemTitle className="wrap-anywhere">
                            {person.name ?? person.email}
                          </ItemTitle>
                          {person.name || person.revoked ? (
                            <ItemDescription className="line-clamp-none wrap-anywhere text-sm">
                              {person.name ? person.email : null}
                              {person.name && person.revoked ? " · " : null}
                              {person.revoked ? "Access removed" : null}
                            </ItemDescription>
                          ) : null}
                        </ItemContent>
                        <ItemActions>
                          <IconChevronRight aria-hidden className="size-4" />
                        </ItemActions>
                      </Item>
                    </Fragment>
                  ))}
                </PageRows>
              ) : directory.isSuccess ? (
                <PageEmpty
                  icon={IconSearch}
                  title={
                    query
                      ? "No matching members"
                      : "No members in the directory"
                  }
                />
              ) : null}
              {people && directory.hasNextPage ? (
                <>
                  {directory.isFetchNextPageError ? (
                    <p className="text-destructive text-sm" role="alert">
                      Couldn't load more members.
                    </p>
                  ) : null}
                  <Button
                    className="min-h-12 self-start"
                    aria-disabled={directory.isFetching}
                    onClick={(event) => {
                      if (directory.isFetching) return;
                      const button = event.currentTarget;
                      const document = button.ownerDocument;
                      const focused = document.activeElement === button;
                      const nextIndex = people.length;
                      void directory
                        .fetchNextPage({ cancelRefetch: false })
                        .then((result) => {
                          if (!focused || !result.isSuccess) return;
                          requestAnimationFrame(() => {
                            if (
                              document.activeElement !== button &&
                              (button.isConnected ||
                                document.activeElement !== document.body)
                            )
                              return;
                            results.current
                              ?.querySelectorAll<HTMLButtonElement>(
                                "[data-member-result]",
                              )
                              [nextIndex]?.focus();
                          });
                        });
                    }}
                    type="button"
                    variant="outline"
                  >
                    {directory.isFetchingNextPage
                      ? "Loading more…"
                      : directory.isFetchNextPageError
                        ? "Retry loading more"
                        : "Load more members"}
                  </Button>
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </VStack>
  );
}

function MemberAccessResult({ member }: { member: Person }) {
  const access = useQuery(memberAccessQueryOptions(member.id));
  const { data } = access;
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);
  const person = data?.person ?? member;
  const missing =
    access.error instanceof ClientError && access.error.status === 404;
  return (
    <VStack gap={2}>
      <h2
        className="wrap-anywhere font-semibold text-base"
        ref={heading}
        tabIndex={-1}
      >
        {person.name ?? person.email}
      </h2>
      {person.name ? (
        <Text as="p" className="wrap-anywhere" color="secondary" size="sm">
          {person.email}
        </Text>
      ) : null}
      {missing ? (
        <Text as="p" role="alert" size="sm">
          This person is no longer in the directory. Choose another member.
        </Text>
      ) : access.isError ||
        (access.isPending && access.errorUpdateCount > 0) ? (
        <ReadError
          focusAfterRetry={() => heading.current}
          message={
            access.error?.message ?? "Couldn't load this person's permissions."
          }
          retry={access.refetch}
          retryBelow
          retrying={access.isFetching}
        />
      ) : !data || access.isFetching ? (
        <ReadStatus kind="loading" message="Checking current permissions…" />
      ) : data.status === "access-removed" ? (
        <Text as="p" role="status" size="sm">
          Access removed. This person can't sign in to the workspace.
        </Text>
      ) : (
        <>
          <Text as="p" color="secondary" size="sm">
            {data.person.role === "admin" ? "Admin" : "Member"} · Current
            permissions
          </Text>
          {[false, true].map((allowed) => {
            const capabilities = data.capabilities.filter(
              (capability) => capability.allowed === allowed,
            );
            if (capabilities.length === 0) return null;
            const label = allowed ? "Allowed" : "Blocked";
            return (
              <section aria-label={label} className="mt-2" key={label}>
                <h3 className="font-semibold text-sm">
                  {label} ({capabilities.length})
                </h3>
                <PageRows className="mt-2 [&_[data-slot=item]]:min-h-0">
                  {capabilities.map((capability, index) => (
                    <Fragment key={capability.capability}>
                      {index > 0 && <Separator />}
                      <Item className="px-4" size="xs">
                        <ItemContent>
                          <ItemTitle className="wrap-anywhere">
                            {capability.title}
                          </ItemTitle>
                          <ItemDescription className="line-clamp-none wrap-anywhere text-sm">
                            {permissionSource(capability)}
                          </ItemDescription>
                        </ItemContent>
                      </Item>
                    </Fragment>
                  ))}
                </PageRows>
              </section>
            );
          })}
        </>
      )}
    </VStack>
  );
}

function permissionSource(answer: CapabilityAnswer): string {
  switch (answer.decidedBy) {
    case "default":
      return "Product default";
    case "organization":
      return "Organization default";
    case "role":
      return answer.scopeId === "admin"
        ? "Admins override"
        : "Members override";
    case "group":
      return `Group grant from ${answer.scopeId}`;
  }
}
