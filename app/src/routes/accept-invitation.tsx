import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/auth-shell";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  authClient,
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
} from "@/lib/auth/queries";
import {
  DirectoryInvitationActionError,
  type InvitationActionFailure,
  invitationCommandAdapter,
  invitationKeys,
  invitationLandingQueryOptions,
  invitationSessionQueryOptions,
  type PublicInvitationRead,
} from "@/lib/enterprise/tenant/directory";
import { useDateTime } from "@/lib/i18n/datetime";

/*
 * The invitation landing, T04.11 (#555): what a person who followed an invitation link sees,
 * and the one path back to it.
 *
 * THE LINK CARRIES ONE FACT. The invitation id is the whole input; every other search parameter
 * is dropped by `searchOf` before anything reads it, so an outside "return to" target never
 * becomes a destination. The way back after a sign-in is the invitation's own path, rebuilt
 * from the id alone and handed to the sign-in as its return target — which is also how a wrong
 * account recovers: switch accounts, and the same invitation is waiting under the same path.
 *
 * EVERY STATE HAS ITS OWN SENTENCE. The narrow read answers the minimal landing while nobody is
 * signed in (expired, cancelled and already answered each say so) and the caller's own view
 * once they are; a 404 while signed in is either the unverified mailbox or another address's
 * invitation, and the page names which from the session's own facts. Accepting and declining
 * ride the controlled commands with the invitee's verified mailbox as the whole qualification —
 * the server's, never a form's.
 */

function searchOf(search: Record<string, unknown>): { id?: string } {
  const id = search.id;
  return typeof id === "string" && id !== "" ? { id } : {};
}

type Outcome =
  | { kind: "joined"; company: string }
  | { kind: "declined" }
  | { kind: "refused"; failure: InvitationActionFailure };

function failureOf(error: unknown): InvitationActionFailure {
  return error instanceof DirectoryInvitationActionError
    ? error.failure
    : "failed";
}

/** The refusals that end the answering: the invitation is settled (a concurrent accept among
 * them), expired, or this mailbox may not answer it. Every other refusal leaves the buttons. */
const TERMINAL_REFUSALS: ReadonlySet<InvitationActionFailure> = new Set([
  "settled",
  "expired",
  "mismatch",
  "unverified",
]);

const ROLE_LABEL_KEYS = {
  owner: "acceptInvitation.roleOf.owner",
  admin: "acceptInvitation.roleOf.admin",
  member: "acceptInvitation.roleOf.member",
  auditor: "acceptInvitation.roleOf.auditor",
} as const;

function AcceptInvitationPage() {
  const { t } = useTranslation("common");
  const { id } = Route.useSearch();
  const queryClient = useQueryClient();
  const session = useQuery(invitationSessionQueryOptions());
  const invitation = useQuery(invitationLandingQueryOptions(id));
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function handleSwitchAccount() {
    // The session read leaves with the sign-out's own cache clear; the invitation read stays,
    // so it is invalidated by hand — the answer it holds was the signed-in one.
    await signOut.mutateAsync().catch(() => {});
    await queryClient.invalidateQueries({ queryKey: invitationKeys.root });
  }

  const body = (() => {
    if (id === undefined) {
      return (
        <div className="space-y-4">
          <h1 className="text-base font-medium">
            {t("acceptInvitation.linkMissing")}
          </h1>
          <Link
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            to="/"
          >
            {t("acceptInvitation.goHome")}
          </Link>
        </div>
      );
    }
    if (session.isPending || invitation.isPending) {
      return (
        <p className="text-sm text-muted-foreground" role="status">
          {t("acceptInvitation.loading")}
        </p>
      );
    }
    if (invitation.isError) {
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("acceptInvitation.failed")}
          </p>
          <Button
            disabled={invitation.isFetching}
            onClick={() => void invitation.refetch()}
            type="button"
            variant="outline"
          >
            {t("acceptInvitation.retry")}
          </Button>
        </div>
      );
    }
    const read = invitation.data;
    if (read === undefined) {
      return (
        <p className="text-sm text-muted-foreground" role="status">
          {t("acceptInvitation.loading")}
        </p>
      );
    }
    if (read.kind === "unavailable") {
      const who = session.data ?? null;
      // A signed-in miss is the caller's own fact to explain: an unverified mailbox or another
      // address's invitation. Signed out, the same 404 is simply not available.
      if (who !== null && !who.emailVerified) {
        return (
          <p className="text-sm text-muted-foreground">
            {t("acceptInvitation.unverified", { email: who.email })}
          </p>
        );
      }
      if (who !== null) {
        return (
          <div className="space-y-3">
            <h1 className="text-base font-medium">
              {t("acceptInvitation.wrongAccount", { email: who.email })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("acceptInvitation.wrongAccountHint")}
            </p>
            <Button
              disabled={signOut.isPending}
              onClick={() => void handleSwitchAccount()}
              variant="outline"
            >
              {t("acceptInvitation.switchAccount")}
            </Button>
          </div>
        );
      }
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("acceptInvitation.unavailable")}
          </p>
          <Link
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            to="/"
          >
            {t("acceptInvitation.goHome")}
          </Link>
        </div>
      );
    }
    if (read.kind === "landing") {
      if (read.status === "pending" && !read.expired) {
        return (
          <div className="space-y-4">
            <h1 className="text-base font-medium">
              {t("acceptInvitation.signInTitle")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("acceptInvitation.signInHint")}
            </p>
            <SignInChoices
              returnPath={`/accept-invitation?id=${encodeURIComponent(id)}`}
            />
          </div>
        );
      }
      const sentence =
        read.status === "accepted"
          ? t("acceptInvitation.accepted")
          : read.status === "rejected"
            ? t("acceptInvitation.declined")
            : read.status === "canceled"
              ? t("acceptInvitation.cancelled")
              : read.expired
                ? t("acceptInvitation.expired")
                : t("acceptInvitation.unavailable");
      // Every settled landing sentence gets the same exit; a page that ends on its own
      // news leaves the reader nowhere to go.
      return (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{sentence}</p>
          <Link
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            to="/"
          >
            {t("acceptInvitation.goToApp")}
          </Link>
        </div>
      );
    }
    return (
      <OwnInvitation
        id={id}
        read={read}
        outcome={outcome}
        onOutcome={setOutcome}
      />
    );
  })();

  return (
    <AuthShell title={t("acceptInvitation.pageTitle")}>
      <div className="w-full space-y-4 text-center">{body}</div>
    </AuthShell>
  );
}

/** The caller's own view: the company, the role, and the two answers. */
function OwnInvitation({
  id,
  read,
  outcome,
  onOutcome,
}: {
  id: string;
  read: Extract<PublicInvitationRead, { kind: "own" }>;
  outcome: Outcome | null;
  onOutcome: (outcome: Outcome) => void;
}) {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const { formatDate } = useDateTime();
  const commands = invitationCommandAdapter();
  // After accepting/declining/refusing, the answer replaces the buttons; focus moves with it
  // so keyboard and screen-reader users land on the outcome instead of a vanished control.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (outcome !== null) headingRef.current?.focus();
  }, [outcome]);
  const answer = useMutation({
    mutationFn: (accept: boolean) =>
      accept ? commands.accept(id) : commands.decline(id),
    onSuccess: (_settled, accept) =>
      onOutcome(
        accept
          ? { kind: "joined", company: read.organizationName }
          : { kind: "declined" },
      ),
    onError: (error) =>
      onOutcome({ kind: "refused", failure: failureOf(error) }),
  });

  const sentenceOf = (failure: InvitationActionFailure): string => {
    switch (failure) {
      case "expired":
        return t("acceptInvitation.expired");
      case "settled":
        return t("acceptInvitation.settled");
      case "seats":
        return t("acceptInvitation.seats");
      case "closed":
        return t("acceptInvitation.closed");
      case "paused":
        return t("acceptInvitation.paused");
      case "refused":
        return t("acceptInvitation.refused");
      case "invalid":
        return t("acceptInvitation.invalid");
      case "unverified":
        return t("acceptInvitation.actionUnverified");
      case "mismatch":
        return t("acceptInvitation.actionMismatch");
      default:
        return t("acceptInvitation.failed");
    }
  };

  if (outcome?.kind === "joined") {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-medium" ref={headingRef} tabIndex={-1}>
          {t("acceptInvitation.joined", { company: outcome.company })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("acceptInvitation.joinedHint")}
        </p>
        <Button onClick={() => void navigate({ to: "/" })} type="button">
          {t("acceptInvitation.goToApp")}
        </Button>
      </div>
    );
  }
  if (outcome?.kind === "declined") {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-medium" ref={headingRef} tabIndex={-1}>
          {t("acceptInvitation.declinedNow")}
        </h1>
        {/* Declining is an answer, not a dead end: the same exit accepting gets. */}
        <Button
          onClick={() => void navigate({ to: "/" })}
          type="button"
          variant="outline"
        >
          {t("acceptInvitation.goToApp")}
        </Button>
      </div>
    );
  }

  const refused = outcome?.kind === "refused" ? outcome.failure : null;
  if (refused !== null && TERMINAL_REFUSALS.has(refused)) {
    return (
      <div className="space-y-3">
        <h1 className="text-base font-medium" ref={headingRef} tabIndex={-1}>
          {read.organizationName}
        </h1>
        <p className="text-sm text-muted-foreground">{sentenceOf(refused)}</p>
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          to="/"
        >
          {t("acceptInvitation.goToApp")}
        </Link>
      </div>
    );
  }

  const role = read.role ?? "member";
  const roleKey: keyof typeof ROLE_LABEL_KEYS =
    role === "owner" || role === "admin" || role === "auditor"
      ? role
      : "member";

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-base font-medium">
          {t("acceptInvitation.invitedTo", { company: read.organizationName })}
        </h1>
      </div>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("acceptInvitation.company")}
          </span>
          <span>{read.organizationName}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("acceptInvitation.role")}
          </span>
          <span>{t(ROLE_LABEL_KEYS[roleKey])}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">
            {t("acceptInvitation.expires")}
          </span>
          <span>{formatDate(read.expiresAt)}</span>
        </div>
      </div>
      {refused !== null ? (
        <p className="text-sm text-destructive" role="alert">
          {sentenceOf(refused)}
        </p>
      ) : null}
      <div className="flex justify-center gap-2">
        <Button
          disabled={answer.isPending}
          onClick={() => answer.mutate(true)}
          type="button"
        >
          {t("acceptInvitation.accept")}
        </Button>
        <Button
          disabled={answer.isPending}
          onClick={() => answer.mutate(false)}
          type="button"
          variant="outline"
        >
          {t("acceptInvitation.decline")}
        </Button>
      </div>
    </div>
  );
}

/** The ways in, each carrying the invitation's own path as the return target. */
function SignInChoices({ returnPath }: { returnPath: string }) {
  const { t } = useTranslation("common");
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const callbackURL = `${window.location.origin}${returnPath}`;

  async function startSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);
    try {
      await signInWith(
        provider,
        (input) =>
          authClient.signIn.social({
            provider: input.provider,
            callbackURL,
          }) as Promise<{ error?: { message?: string } | null }>,
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("signIn.couldNotStart", { provider: providerName(provider) }),
      );
      setOpening(null);
    }
  }

  async function startSso(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("sso");
    try {
      await signInWithEmailDomain(email, (input) =>
        (
          authClient as unknown as {
            signIn: {
              sso: (
                input: unknown,
              ) => Promise<{ error?: { message?: string } | null }>;
            };
          }
        ).signIn.sso({ email: input.email, callbackURL }),
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("signIn.noProviderForAddress"),
      );
      setOpening(null);
    }
  }

  return (
    <div className="space-y-3">
      {providers.length > 0 ? (
        <div className="flex flex-col gap-2">
          {providers.map((provider) => (
            <Button
              className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
              disabled={opening !== null}
              key={provider}
              onClick={() => void startSignIn(provider)}
              size="lg"
              type="button"
              variant="outline"
            >
              <ProviderLogo provider={provider} />
              <span className="flex-1 text-center">
                {opening === provider
                  ? t("signIn.openingProvider", {
                      provider: providerName(provider),
                    })
                  : t("signIn.continueWith", {
                      provider: providerName(provider),
                    })}
              </span>
              <span aria-hidden="true" className="size-[18px]" />
            </Button>
          ))}
        </div>
      ) : null}
      {options?.sso ? (
        <form className="space-y-2" onSubmit={startSso}>
          {providers.length > 0 ? (
            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-muted-foreground text-xs">
                {t("signIn.or")}
              </span>
              <Separator className="flex-1" />
            </div>
          ) : null}
          <Input
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("signIn.emailPlaceholder")}
            required
            type="email"
            value={email}
          />
          <Button
            className="h-10 w-full tracking-tight"
            disabled={opening !== null || email.trim().length === 0}
            size="lg"
            type="submit"
            variant="outline"
          >
            {opening === "sso"
              ? t("signIn.opening")
              : t("signIn.continueCompany")}
          </Button>
        </form>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const Route = createFileRoute("/accept-invitation")({
  validateSearch: searchOf,
  component: AcceptInvitationPage,
});
