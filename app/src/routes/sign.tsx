import { Stack } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { ReadError } from "@/components/layout/read-status";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/i18n";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";
import {
  appReturnPath,
  errorUrlFor,
  openFuseResumePath,
  resumeUrlFor,
  verifierPathFor,
} from "@/lib/auth/resume";
import { appConfig } from "@/lib/generated/application-config";
import { searchTextEntry } from "@/lib/search-text";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  /*
   * `?flow_id=` is the handle a brokered authorization arrived with, sent here when its session had
   * lapsed. It is a value to carry back, never a place to go: see `resumeUrlFor`.
   *
   * READ AS TEXT WHATEVER THE ROUTER PARSED IT INTO, which is what `searchText` is for: a handle
   * made of digits arrives here as a number and a JSON-shaped one as an object, so a `typeof`
   * guard would drop the correlation for whichever handles the vendor's generator happens to emit
   * — working in testing and losing the return leg's binding in production.
   *
   * The key is omitted rather than set to undefined, for the reason the connected-accounts screen
   * gives for `?connected=`: present-but-undefined makes `search` a required prop on every Link to
   * this route, which is a lot of ripple for a parameter only the verifier sets.
   */
  /*
   * `?error=` / `?error_description=` is how a provider that cancels or refuses reports back (the
   * per-flow `errorCallbackURL` sends the browser here instead of Better Auth's global fallback).
   * Read as text whatever the router parsed them into, and dropped from the address once read, the
   * way the connected-accounts screen handles `?connected=`: the notice is for the arrival, not for
   * every reload after it.
   */
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    flow_id?: string;
    openfuse_request?: string;
    returnTo?: string;
    error?: string;
    error_description?: string;
  } => {
    const returnTo = appReturnPath(search.returnTo);
    return {
      ...searchTextEntry("flow_id", search.flow_id),
      ...searchTextEntry("openfuse_request", search.openfuse_request),
      ...(returnTo ? { returnTo } : {}),
      ...searchTextEntry("error", search.error),
      ...searchTextEntry("error_description", search.error_description),
    };
  },
  beforeLoad: async ({ context, search }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      /*
       * Signed in already, so the handle has nowhere to be lost between here and the verifier.
       *
       * `href` rather than `to` because the verifier is an API path, not a router route — and
       * `reloadDocument` because of what follows from that. A redirect the router is left to
       * handle is a navigation INSIDE the app: it resolves the href against the route tree, finds
       * nothing (there is no route for `/api/…`, and there cannot be — the verifier is served by
       * the server, not this build), and `__root.tsx` sends an address it does not know home. The
       * person who was part-way through connecting an app would be dropped on the home screen with
       * the authorization they started abandoned and nothing said about it, because no request for
       * the verifier was ever made. `reloadDocument` makes this a document navigation, which is
       * the only kind that leaves the app and therefore the only kind that arrives.
       */
      const verifier =
        openFuseResumePath(search.openfuse_request) ??
        verifierPathFor(search.flow_id);
      if (verifier) throw redirect({ href: verifier, reloadDocument: true });
      if (search.returnTo)
        throw redirect({ href: search.returnTo, replace: true });
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient
      .ensureQueryData(authProvidersQueryOptions())
      .catch(() => undefined);
  },
  component: SignScreen,
});

function SignScreen() {
  const { t } = useTranslation();
  const title = t("sign.title", "Sign in");
  useEffect(() => {
    document.title = `${title} · ${appConfig.brand.productName}`;
  }, [title]);
  const {
    flow_id: flowId,
    openfuse_request: openFuseRequest,
    returnTo,
    error: refusalCode,
    error_description: refusalDescription,
  } = Route.useSearch();
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  /*
   * The refusal a provider returned (a cancel, or SSO refusing another way in) is the one notice
   * this screen shows, in words this app owns. `sso_required` is the exception: the server's
   * sentence is already person-words and says what to do next, so it passes through as a value.
   */
  const [error, setError] = useState<string | null>(() => {
    if (refusalCode === undefined) return null;
    if (refusalCode === "access_denied")
      return t(
        "sign.error.cancelled",
        "Sign-in was cancelled. Choose a way to sign in again.",
      );
    if (refusalCode === "sso_required" && refusalDescription)
      return refusalDescription;
    return t(
      "sign.error.failed",
      "Couldn't finish sign-in. Try again, or ask your OpenBot admin if it keeps happening.",
    );
  });
  // The arrival is handled once: the heading takes focus, and the address loses the refusal so a
  // reload does not repeat it.
  const [arrivalNeedsFocus] = useState(() => refusalCode !== undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (!arrivalNeedsFocus) return;
    heading.current?.focus();
    navigate({
      search: ({ error: _error, error_description: _description, ...rest }) =>
        rest,
      replace: true,
    });
  }, [arrivalNeedsFocus, navigate]);
  const {
    data: options,
    isError: optionsError,
    isFetching: checkingOptions,
    refetch: reloadOptions,
  } = useQuery({ ...authProvidersQueryOptions(), retryOnMount: false });
  const providers = options?.providers ?? [];
  const optionsUnavailable =
    options !== undefined &&
    !options.sso &&
    (options.ssoRequired || providers.length === 0);
  const [email, setEmail] = useState("");

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("sso");

    try {
      await signInWithEmailDomain(
        email,
        undefined,
        resumeUrlFor(window.location.origin, flowId, openFuseRequest, returnTo),
        errorUrlFor(window.location.origin, flowId, openFuseRequest, returnTo),
      );
    } catch (caughtError) {
      /*
       * Whatever the server said is a value, not copy: it passes through verbatim and only the
       * sentence built around it is translated.
       */
      setError(
        t(
          "sign.sso.guidance",
          "{message} Check your company email and try again. If the problem continues, contact your OpenBot administrator.",
          {
            message:
              caughtError instanceof Error
                ? caughtError.message
                : t("sign.sso.failed", "Couldn't open company sign-in."),
          },
        ),
      );
      setOpening(null);
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    if (opening !== null) return;
    setError(null);
    setOpening(provider);

    try {
      await signInWith(
        provider,
        undefined,
        resumeUrlFor(window.location.origin, flowId, openFuseRequest, returnTo),
        errorUrlFor(window.location.origin, flowId, openFuseRequest, returnTo),
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t(
              "sign.provider.failed",
              "Couldn't open {provider} sign-in. Try again.",
              { provider: providerName(provider) },
            ),
      );
      setOpening(null);
    }
  }

  const providerButtons = (
    <div className="flex flex-col gap-2">
      {providers.map((provider) => (
        /*
         * Every provider gets the same button, and it is the light-themed outline one
         * rather than the app's filled primary. Google's guidelines require their button be
         * at least as prominent as any other sign-in option and specify its fill and
         * stroke, so making one provider the loud one would break that for the others. The
         * same size and weight throughout is also the honest presentation: a deployment
         * that configured three has three, and none of them is the recommended one.
         */
        <Button
          aria-disabled={opening === provider}
          className="min-h-11 w-full justify-start gap-3 px-3 tracking-tight"
          disabled={opening !== null && opening !== provider}
          key={provider}
          onClick={() => handleSignIn(provider)}
          size="lg"
          variant="outline"
        >
          <ProviderLogo provider={provider} />
          {/* Centred against the button, not against the space left of the mark. */}
          <span className="flex-1 text-center">
            {opening === provider
              ? t("sign.provider.opening", "Opening {provider}…", {
                  provider: providerName(provider),
                })
              : t("sign.provider.continue", "Continue with {provider}", {
                  provider: providerName(provider),
                })}
          </span>
          {/* Balances the mark so the label sits in the middle of the button. */}
          <span aria-hidden="true" className="size-[18px]" />
        </Button>
      ))}
    </div>
  );

  const prefersReducedMotion = useReducedMotion();
  const hidden = {
    opacity: 0,
    ...(prefersReducedMotion ? {} : { transform: ENTRANCE_OFFSET }),
  };
  const shown = {
    opacity: 1,
    ...(prefersReducedMotion ? {} : { transform: "translateY(0px)" }),
  };

  return (
    <Stack
      {...astryxScope}
      align="center"
      as="main"
      className="sign-in-screen"
      minHeight="100dvh"
      width="100%"
    >
      <motion.div
        animate="shown"
        className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
        initial="hidden"
        variants={{
          hidden: {},
          shown: { transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS } },
        }}
      >
        <motion.div
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
          className="flex items-center justify-center"
        >
          <AgentOrb size="56px" />
        </motion.div>
        <motion.h1
          className="text-2xl font-medium tracking-tight text-center mt-8"
          ref={heading}
          tabIndex={-1}
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {t("sign.heading", "Sign in to {product}", {
            product: appConfig.brand.productName,
          })}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {(!options || optionsUnavailable) && (
            <ReadError
              description={
                !options || optionsError
                  ? t(
                      "sign.options.loadFailedDescription",
                      "Check your connection and try again.",
                    )
                  : t(
                      "sign.options.unusableDescription",
                      "Ask your IT help desk or the person who invited you to check sign-in for this workspace. Check again when it’s ready.",
                    )
              }
              focusAfterRetry={() => heading.current}
              message={
                !options || optionsError
                  ? t(
                      "sign.options.loadFailed",
                      "Couldn't load sign-in options.",
                    )
                  : options.ssoRequired
                    ? t(
                        "sign.required.unavailable",
                        "Company sign-in is required but unavailable.",
                      )
                    : t("sign.unconfigured", "Sign-in isn’t set up yet.")
              }
              retry={reloadOptions}
              retryBelow
              retryLabel={
                optionsUnavailable
                  ? t("sign.options.checkAgain", "Check sign-in options")
                  : undefined
              }
              retrying={checkingOptions}
            />
          )}
          {options?.ssoRequired && options.sso ? (
            <p className="mb-3 text-center text-sm text-muted-foreground">
              {t(
                "sign.required.notice",
                "Your organization requires you to sign in with your company account.",
              )}
            </p>
          ) : null}
          {providers.length > 0 && !options?.ssoRequired
            ? providerButtons
            : null}
          {/*
           * The way in for a company that runs its own identity provider.
           *
           * Below the buttons, because a deployment with both has more people arriving through the
           * buttons: the registered providers are for the companies whose IdP was added by hand.
           */}
          {options?.sso ? (
            <Stack
              as="form"
              gap={2}
              onSubmit={handleDomainSignIn}
              style={{ marginBlockStart: "var(--spacing-3)" }}
            >
              {providers.length > 0 && !options.ssoRequired ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">
                    {t("sign.sso.or", "or")}
                  </span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              <TextInput
                autoComplete="email"
                controlClassName="sign-in-email"
                description={t(
                  "sign.sso.description",
                  "Use the email address issued by your organization.",
                )}
                isRequired
                label={t("sign.sso.label", "Company email")}
                onChange={setEmail}
                placeholder="you@company.com"
                type="email"
                value={email}
              />
              <Button
                className="min-h-11 w-full tracking-tight"
                disabled={opening !== null || email.trim().length === 0}
                size="lg"
                type="submit"
                variant="outline"
              >
                {opening === "sso"
                  ? t("sign.sso.opening", "Opening…")
                  : t(
                      "sign.sso.continue",
                      "Continue with your company account",
                    )}
              </Button>
            </Stack>
          ) : null}
          {/* The administrators' audited break-glass while SSO is required; everybody else is refused. */}
          {options?.ssoRequired && providers.length > 0 ? (
            <details className="mt-4 text-sm">
              <summary className="sign-in-admin-summary cursor-pointer text-center text-muted-foreground">
                {t("sign.admin.signIn", "Admin sign-in")}
              </summary>
              <p className="mt-2 text-muted-foreground">
                {t(
                  "sign.admin.restore",
                  "Use this if you administer this workspace and need to restore company sign-in.",
                )}
              </p>
              <div className="mt-3">{providerButtons}</div>
            </details>
          ) : null}
          {error ? (
            <p className="mt-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </Stack>
  );
}
