import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { AstryxBrand, AstryxSurface } from "@/components/astryx-pilot/theme";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Separator } from "@/components/ui/separator";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
} from "@/lib/auth/client";
import {
  appReturnPath,
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
  validateSearch: (
    search: Record<string, unknown>,
  ): { flow_id?: string; returnTo?: string } => {
    const returnTo = appReturnPath(search.returnTo);
    return {
      ...searchTextEntry("flow_id", search.flow_id),
      ...("returnTo" in search ? { returnTo } : {}),
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
      const verifier = verifierPathFor(search.flow_id);
      throw verifier
        ? redirect({ href: verifier, reloadDocument: true })
        : search.returnTo
          ? redirect({ href: search.returnTo, replace: true })
          : redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  component: SignScreen,
});

function SignScreen() {
  const { flow_id: flowId, returnTo } = Route.useSearch();
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<AuthProviderId | "sso" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];
  const [email, setEmail] = useState("");

  /**
   * Sign in through whichever identity provider covers this address.
   *
   * No password is asked for and none is checked here: only the part after the @ is used, to decide
   * which registered provider to hand somebody to.
   */
  async function handleDomainSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    if (opening !== null || !email.trim()) return;
    setError(null);
    setOpening("sso");

    try {
      await signInWithEmailDomain(
        email,
        undefined,
        resumeUrlFor(window.location.origin, flowId, returnTo),
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "No company sign-in is set up for that address.",
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
        resumeUrlFor(window.location.origin, flowId, returnTo),
      );
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : `Couldn't open ${providerName(provider)} sign-in. Try again.`,
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
        <AstryxButton
          className="w-full"
          icon={<ProviderLogo provider={provider} />}
          isDisabled={opening !== null && opening !== provider}
          isLoading={opening === provider}
          size="lg"
          key={provider}
          label={`Continue with ${providerName(provider)}`}
          onClick={() => handleSignIn(provider)}
          variant="secondary"
        />
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
    <AstryxSurface className="min-h-svh">
      <main className={"grid min-h-svh place-items-center px-4 py-10"}>
        <motion.div
          animate="shown"
          className="flex-1 flex w-full max-w-82 flex-col items-center justify-center p-4"
          initial="hidden"
          variants={{
            hidden: {},
            shown: {
              transition: { staggerChildren: ENTRANCE_STAGGER_SECONDS },
            },
          }}
        >
          <motion.div
            transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
            variants={{ hidden, shown }}
            className="flex items-center justify-center"
          >
            <AstryxBrand />
          </motion.div>
          <motion.h1
            className="text-2xl font-medium tracking-tight text-center mt-8"
            transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
            variants={{ hidden, shown }}
          >
            Sign in to {appConfig.brand.productName}
          </motion.h1>
          <motion.div
            className="mt-8 w-full"
            transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
            variants={{ hidden, shown }}
          >
            {options?.ssoRequired ? (
              <p className="mb-3 text-center text-sm text-muted-foreground">
                Your organization requires you to sign in with your company
                account.
              </p>
            ) : null}
            {providers.length > 0 && !options?.ssoRequired ? (
              providerButtons
            ) : options?.sso || options?.ssoRequired ? null : (
              <p className="text-center text-sm text-muted-foreground">
                Sign-in isn't set up yet. An admin has to set it up first.
              </p>
            )}
            {/*
             * The way in for a company that runs its own identity provider.
             *
             * Below the buttons, because a deployment with both has more people arriving through the
             * buttons: the registered providers are for the companies whose IdP was added by hand.
             */}
            {options?.sso ? (
              <form className="mt-3" onSubmit={handleDomainSignIn}>
                {providers.length > 0 ? (
                  <div className="mb-3 flex items-center gap-3">
                    <Separator className="flex-1" />
                    <span className="text-muted-foreground text-xs">or</span>
                    <Separator className="flex-1" />
                  </div>
                ) : null}
                <div className="grid gap-3">
                  <TextInput
                    autoComplete="email"
                    isRequired
                    label="Company email"
                    onChange={setEmail}
                    placeholder="you@company.com"
                    type="email"
                    value={email}
                    width="100%"
                  />
                  <AstryxButton
                    isDisabled={opening !== null && opening !== "sso"}
                    isLoading={opening === "sso"}
                    label="Continue with your company account"
                    type="submit"
                    variant="secondary"
                  />
                </div>
              </form>
            ) : null}
            {/* The administrators' audited break-glass while SSO is required; everybody else is refused. */}
            {options?.ssoRequired && providers.length > 0 ? (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-center text-muted-foreground">
                  Admin sign-in
                </summary>
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
      </main>
    </AstryxSurface>
  );
}
