import { IconLock, IconShieldCheck, IconUser } from "@tabler/icons-react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import {
  clearOldIdentityState,
  createPlatformUserMutationOptions,
  platformUserSessionsQueryOptions,
  revokePlatformUserSessionMutationOptions,
  revokePlatformUserSessionsMutationOptions,
  setPlatformUserPasswordMutationOptions,
  updatePlatformUserProfileMutationOptions,
} from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { terminateMemberComputersMutationOptions } from "@/lib/enterprise/mutations";
import { useDateTime } from "@/lib/i18n/datetime";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";

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
function describe(
  person: Person,
  t: TFunction<"admin">,
  formatDate: (value: Date | string | number) => string,
): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? t("people.lastSignedIn", {
        date: formatDate(person.lastSignedInAt),
      })
    : t("people.neverSignedIn");

  if (person.revoked)
    return t("people.accessRemoved", {
      providers: providers || t("people.noProvider"),
      when,
    });
  if (person.configuredAdmin) {
    return t("people.adminByConfiguration", { when });
  }
  return t("people.providersAndWhen", {
    providers: providers || t("people.noProvider"),
    when,
  });
}

function PeoplePage() {
  const { t } = useTranslation("admin");
  const { formatDate } = useDateTime();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Person | null>(null);
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
  const rows = people.data?.pages.flatMap((page) => page.people) ?? [];
  const currentUser = useQuery(currentUserQueryOptions());
  const currentUserId = currentUser.data?.id ?? null;
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  // Offboarding: stops this person's Bots' computers, keeping their disks. Access is unchanged.
  const terminate = useMutation(terminateMemberComputersMutationOptions());
  return (
    <PageShell description={t("people.description")} title={t("people.title")}>
      <PageSection
        description={t("people.whoIsHere.description")}
        title={t("people.whoIsHere.title")}
      >
        {/*
          Each action's refusal in its own line, because they fail for different reasons and a
          shared line would let one hide behind another.
        */}
        {setRole.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {setRole.error.message}
          </p>
        ) : null}
        {setAccess.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {setAccess.error.message}
          </p>
        ) : null}
        {terminate.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {terminate.error.message}
          </p>
        ) : null}
        {terminate.data ? (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            {t("people.stoppedCount", {
              count: terminate.data.stopped.length,
            })}
            {terminate.data.failed.length > 0
              ? t("people.stopFailed", {
                  number: terminate.data.failed.length,
                })
              : ""}
            {t("people.disksKept")}
          </p>
        ) : null}
        {/*
          Server-side search. Filtering what already arrived would only search the first page, which
          is the opposite of what somebody looking for a colleague needs. The create action sits
          beside it because both are "find or make a person" from the same chair.
        */}
        <div className="mt-4 flex gap-2">
          <Input
            aria-label={t("people.searchAria")}
            className="flex-1"
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("people.searchPlaceholder")}
            value={search}
          />
          <Button onClick={() => setAdding(true)} size="sm" variant="outline">
            {t("people.add.button")}
          </Button>
        </div>

        {people.isPending ? (
          <PageRowsSkeleton />
        ) : people.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("people.loadError")}
          </p>
        ) : rows.length === 0 ? (
          <PageEmpty>
            {query ? t("people.noMatches", { query }) : t("people.nobodyYet")}
          </PageEmpty>
        ) : (
          <PageRows>
            {rows.map((person, index) => {
              const isSelf = person.id === currentUserId;
              const busy = setRole.isPending || setAccess.isPending;

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
                      <ItemDescription>
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person, t, formatDate)}
                      </ItemDescription>
                      {/*
                        Restore says what comes back, and what does not: their access to OpenBot,
                        not the grants and roles they held before it was removed. Those are asked
                        for again, one by one, by the people who gave them.
                      */}
                      {person.revoked ? (
                        <p className="text-muted-foreground text-xs">
                          {t("people.restoreNoGrants")}
                        </p>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <Button
                        aria-label={t("people.manageAria", {
                          email: person.email,
                        })}
                        onClick={() => setManaging(person)}
                        size="sm"
                        variant="outline"
                      >
                        {t("people.manage")}
                      </Button>
                      {/*
                       * Removing access is the louder decision, so it is a button rather than a
                       * second switch: two switches on one row invites somebody to flip the wrong
                       * one, and these two do very different things.
                       */}
                      <Button
                        aria-label={t("people.accessAria", {
                          action: person.revoked
                            ? t("people.restore")
                            : t("people.remove"),
                          email: person.email,
                        })}
                        disabled={busy || isSelf || person.configuredAdmin}
                        onClick={() =>
                          setAccess.mutate(
                            { userId: person.id, revoked: !person.revoked },
                            {
                              // Removing the access of the person at this keyboard ends their
                              // session too; their old identity state must not outlive it.
                              onSuccess: () =>
                                clearOldIdentityState(
                                  queryClient,
                                  person.id,
                                  currentUserId,
                                ),
                            },
                          )
                        }
                        size="sm"
                        variant={person.revoked ? "outline" : "destructive"}
                      >
                        {person.revoked
                          ? t("people.restore")
                          : t("people.remove")}
                      </Button>
                      <Button
                        aria-label={t("people.stopAria", {
                          email: person.email,
                        })}
                        disabled={terminate.isPending}
                        onClick={() => terminate.mutate(person.id)}
                        size="sm"
                        variant="outline"
                      >
                        {t("people.stopComputers")}
                      </Button>
                      <Switch
                        aria-label={t("people.adminAria", {
                          email: person.email,
                        })}
                        checked={person.role === "admin"}
                        disabled={busy || person.configuredAdmin || isSelf}
                        onCheckedChange={(checked) =>
                          setRole.mutate({
                            userId: person.id,
                            role: checked ? "admin" : "user",
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                  {index !== rows.length - 1 ? <Separator /> : null}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}

        {/*
          Only when there is one. A button that says there is more when there is not is worse than
          no button, and this list ends for most deployments on the first page.
        */}
        {people.hasNextPage ? (
          <Button
            className="mt-4"
            disabled={people.isFetchingNextPage}
            onClick={() => people.fetchNextPage()}
            size="sm"
            variant="outline"
          >
            {people.isFetchingNextPage
              ? t("people.loading")
              : t("people.showMore")}
          </Button>
        ) : null}
      </PageSection>

      <AddPersonDialog close={() => setAdding(false)} open={adding} />
      {managing ? (
        <PersonSecurityDialog
          close={() => setManaging(null)}
          currentUserId={currentUserId}
          person={managing}
        />
      ) : null}
    </PageShell>
  );
}

/** The create form, which the footer's submit reaches by id so DialogBody keeps its shape. */
function AddPersonDialog({
  close,
  open,
}: {
  close: () => void;
  open: boolean;
}) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const create = useMutation(createPlatformUserMutationOptions(queryClient));
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("people.add.title")}</DialogTitle>
          <DialogDescription>{t("people.add.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-2">
          <label className="text-sm" htmlFor="add-person-email">
            {t("people.add.email")}
          </label>
          <Input
            autoComplete="off"
            id="add-person-email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <label className="text-sm" htmlFor="add-person-name">
            {t("people.add.name")}
          </label>
          <Input
            autoComplete="off"
            id="add-person-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
          <label className="text-sm" htmlFor="add-person-password">
            {t("people.add.password")}
          </label>
          <Input
            autoComplete="new-password"
            id="add-person-password"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          {create.error ? (
            <p className="text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          ) : null}
          <div>
            <Button
              disabled={create.isPending || email.trim() === ""}
              onClick={() =>
                create.mutate(
                  {
                    email: email.trim(),
                    name: name.trim() || undefined,
                    password: password || undefined,
                  },
                  { onSuccess: close },
                )
              }
            >
              {create.isPending
                ? t("people.add.pending")
                : t("people.add.submit")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One person's account, from the platform chair: the name, the password, and every session they
 * have open. Each act is its own security operation with its own answer, because they fail for
 * different reasons and a shared error line would let one hide behind another.
 *
 * What is deliberately absent: signing in as this person, and deleting them. The server refuses
 * both, so the screen offers neither.
 */
function PersonSecurityDialog({
  close,
  currentUserId,
  person,
}: {
  close: () => void;
  currentUserId: string | null;
  person: Person;
}) {
  const { t } = useTranslation("admin");
  const { formatDate } = useDateTime();
  const queryClient = useQueryClient();
  const [name, setName] = useState(person.name ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [passwordReason, setPasswordReason] = useState("");
  const [sessionReason, setSessionReason] = useState("");
  const rename = useMutation(
    updatePlatformUserProfileMutationOptions(queryClient),
  );
  const password = useMutation(
    setPlatformUserPasswordMutationOptions(queryClient, currentUserId),
  );
  const revokeOne = useMutation(
    revokePlatformUserSessionMutationOptions(queryClient, currentUserId),
  );
  const revokeAll = useMutation(
    revokePlatformUserSessionsMutationOptions(queryClient, currentUserId),
  );
  const sessions = useQuery(platformUserSessionsQueryOptions(person.id));
  const reasonReady = sessionReason.trim() !== "";

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) close();
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("people.manageTitle")}</DialogTitle>
          <DialogDescription>
            {t("people.manageDescription", { email: person.email })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 space-y-6">
          <section>
            <h3 className="text-sm font-medium">{t("people.name.title")}</h3>
            <p className="mt-1 text-muted-foreground text-sm">
              {t("people.name.description")}
            </p>
            <label className="mt-2 block text-sm" htmlFor="manage-person-name">
              {t("people.add.name")}
            </label>
            <div className="mt-2 flex gap-2">
              <Input
                id="manage-person-name"
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <Button
                disabled={
                  rename.isPending ||
                  name.trim() === "" ||
                  name.trim() === person.name
                }
                onClick={() =>
                  rename.mutate({ userId: person.id, name: name.trim() })
                }
                size="sm"
                variant="outline"
              >
                {t("people.name.save")}
              </Button>
            </div>
            {rename.error ? (
              <p className="mt-2 text-destructive text-sm" role="alert">
                {rename.error.message}
              </p>
            ) : null}
          </section>

          <section>
            <h3 className="text-sm font-medium">
              {t("people.password.title")}
            </h3>
            <p className="mt-1 text-muted-foreground text-sm">
              {t("people.password.description")}
            </p>
            <div className="mt-2 space-y-2">
              <label className="text-sm" htmlFor="manage-person-password">
                {t("people.password.new")}
              </label>
              <Input
                autoComplete="new-password"
                id="manage-person-password"
                minLength={8}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                value={newPassword}
              />
              <label
                className="text-sm"
                htmlFor="manage-person-password-reason"
              >
                {t("people.password.why")}
              </label>
              <Input
                id="manage-person-password-reason"
                onChange={(event) => setPasswordReason(event.target.value)}
                value={passwordReason}
              />
              <div>
                <Button
                  disabled={
                    password.isPending ||
                    newPassword.length < 8 ||
                    passwordReason.trim() === ""
                  }
                  onClick={() =>
                    password.mutate({
                      userId: person.id,
                      newPassword,
                      reason: passwordReason.trim(),
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  {t("people.password.set")}
                </Button>
              </div>
            </div>
            {password.error ? (
              <p className="mt-2 text-destructive text-sm" role="alert">
                {password.error.message}
              </p>
            ) : null}
            {password.isSuccess ? (
              <p className="mt-2 text-muted-foreground text-sm" role="status">
                {t("people.password.done")}
              </p>
            ) : null}
          </section>

          <section>
            <h3 className="text-sm font-medium">
              {t("people.sessions.title")}
            </h3>
            <p className="mt-1 text-muted-foreground text-sm">
              {t("people.sessions.description")}
            </p>
            <label
              className="mt-2 block text-sm"
              htmlFor="manage-session-reason"
            >
              {t("people.sessions.why")}
            </label>
            <Input
              className="mt-2"
              id="manage-session-reason"
              onChange={(event) => setSessionReason(event.target.value)}
              value={sessionReason}
            />
            {sessions.isPending ? (
              <p className="mt-3 text-muted-foreground text-sm">
                {t("people.sessions.loading")}
              </p>
            ) : sessions.error ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                {sessions.error.message}
              </p>
            ) : (sessions.data ?? []).length === 0 ? (
              <p className="mt-3 text-muted-foreground text-sm">
                {t("people.sessions.none")}
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {(sessions.data ?? []).map((session) => (
                  <Item key={session.id} size="sm">
                    <ItemContent>
                      <ItemTitle>
                        {session.userAgent ??
                          t("people.sessions.unknownDevice")}
                      </ItemTitle>
                      <ItemDescription>
                        {t("people.sessions.until", {
                          date: formatDate(session.expiresAt),
                        })}
                        {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        disabled={!reasonReady || revokeOne.isPending}
                        onClick={() =>
                          revokeOne.mutate({
                            userId: person.id,
                            sessionId: session.id,
                            reason: sessionReason.trim(),
                          })
                        }
                        size="sm"
                        variant="outline"
                      >
                        {t("people.sessions.revoke")}
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
                <Button
                  disabled={!reasonReady || revokeAll.isPending}
                  onClick={() =>
                    revokeAll.mutate({
                      userId: person.id,
                      reason: sessionReason.trim(),
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  {t("people.sessions.revokeAll")}
                </Button>
              </div>
            )}
            {revokeOne.error || revokeAll.error ? (
              <p className="mt-2 text-destructive text-sm" role="alert">
                {(revokeOne.error ?? revokeAll.error)?.message}
              </p>
            ) : null}
          </section>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
