import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { ProviderLogo } from "@/components/auth/provider-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  providerName,
  signInWith,
  signInWithEmailDomain,
  signInWithEmailPassword,
} from "@/lib/auth/client";
import { appConfig } from "@/lib/generated/application-config";
import {
  type AuthProviderId,
  authProvidersQueryOptions,
  currentUserQueryOptions,
} from "../lib/auth/queries";

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/*
 * Better Auth refusals carry a code; the ones a person can act on get translated copy. The raw
 * server message stays the fallback for unknown codes — it beats a generic apology that hides
 * what actually refused.
 */
const SIGN_IN_ERROR_KEYS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "signIn.invalidCredentials",
};

const ENTRANCE_SECONDS = 0.4;
const ENTRANCE_STAGGER_SECONDS = 0.08;
const ENTRANCE_OFFSET = "translateY(12px)";

export const Route = createFileRoute("/sign")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (user) {
      throw redirect({ to: "/" });
    }
    // Loaded here so the screen paints with its buttons rather than painting empty and then
    // growing them, which reads as "no providers" for exactly as long as the request takes.
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  pendingComponent: () => (
    <div className="flex h-dvh w-full items-center justify-center">
      <AgentOrb size="56px" />
    </div>
  ),
  component: SignScreen,
});

function SignScreen() {
  const { t } = useTranslation("common");
  useEffect(() => {
    document.title = t("signIn.title", {
      product: appConfig.brand.productName,
    });
  }, [t]);
  // Which provider is being opened, rather than whether one is: with three buttons, a single
  // boolean would put "Opening…" on all of them.
  const [opening, setOpening] = useState<
    AuthProviderId | "sso" | "password" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const { data: options } = useQuery(authProvidersQueryOptions());
  const providers = options?.providers ?? [];
  const [email, setEmail] = useState("");
  const [passwordEmail, setPasswordEmail] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

  /*
   * A deployment with exactly one way in goes straight there.
   *
   * The buttons exist to choose between ways in; with one provider and no registered company
   * IdP there is no choice to make, and a screen that only asks somebody to press the one
   * button it has is a step that does nothing. Skipped when SSO is registered (the email box
   * is also a way in, so the choice is real), when password accounts are enabled (the form
   * below is one too, for the same reason), and when SSO is required (the buttons are the
   * administrators' break-glass, which must stay deliberate).
   *
   * Once only: a sign-in that fails lands back here with a reason, and sending somebody
   * straight back into the same failure would be a loop, not a retry.
   */
  const autoEntered = useRef(false);
  useEffect(() => {
    if (autoEntered.current || !options) return;
    if (
      providers.length !== 1 ||
      options.sso ||
      options.ssoRequired ||
      options.emailPassword
    ) {
      return;
    }
    const provider = providers[0];
    if (!provider) return;
    autoEntered.current = true;
    setOpening(provider);
    void signInWith(provider).catch((caughtError) => {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("signIn.couldNotStart", { provider: providerName(provider) }),
      );
      setOpening(null);
    });
  }, [options, providers, t]);

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
      await signInWithEmailDomain(email);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("signIn.noProviderForAddress"),
      );
      setOpening(null);
    }
  }

  /**
   * The way in for the deployment's own password accounts. The address and the password are both
   * credentials here, unlike the domain box above, where the address only picks a provider;
   * success lands on the app's origin, the same full-page arrival a provider callback ends with.
   */
  async function handlePasswordSignIn(submission: React.FormEvent) {
    submission.preventDefault();
    setError(null);
    setOpening("password");

    try {
      await signInWithEmailPassword(passwordEmail, password);
      window.location.assign(window.location.origin);
    } catch (caughtError) {
      const code = (caughtError as { code?: string } | null)?.code;
      const key = code !== undefined ? SIGN_IN_ERROR_KEYS[code] : undefined;
      setError(
        key === "signIn.invalidCredentials"
          ? t("signIn.invalidCredentials")
          : caughtError instanceof Error
            ? caughtError.message
            : t("signIn.passwordFailed"),
      );
      setOpening(null);
      passwordRef.current?.focus();
    }
  }

  async function handleSignIn(provider: AuthProviderId) {
    setError(null);
    setOpening(provider);

    try {
      await signInWith(provider);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("signIn.couldNotStart", { provider: providerName(provider) }),
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
          className="h-10 w-full justify-start gap-3 px-3 tracking-tight"
          disabled={opening !== null}
          key={provider}
          onClick={() => handleSignIn(provider)}
          size="lg"
          variant="outline"
        >
          <ProviderLogo provider={provider} />
          {/* Centred against the button, not against the space left of the mark. */}
          <span className="flex-1 text-center">
            {opening === provider
              ? t("signIn.openingProvider", {
                  provider: providerName(provider),
                })
              : t("signIn.continueWith", { provider: providerName(provider) })}
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
    <div className="flex flex-col h-dvh w-full items-center justify-center -mt-12">
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
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {t("signIn.title", { product: appConfig.brand.productName })}
        </motion.h1>
        <motion.div
          className="mt-8 w-full"
          transition={{ duration: ENTRANCE_SECONDS, ease: EASE_OUT }}
          variants={{ hidden, shown }}
        >
          {options?.ssoRequired ? (
            <p className="mb-3 text-center text-sm text-muted-foreground">
              {t("signIn.ssoRequired")}
            </p>
          ) : null}
          {providers.length > 0 && !options?.ssoRequired ? (
            providerButtons
          ) : options?.sso ||
            options?.ssoRequired ||
            options?.emailPassword ? null : (
            <p className="text-center text-sm text-muted-foreground">
              {t("signIn.noProvider")}
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
                className="mt-2 h-10 w-full tracking-tight"
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
          {/*
           * The deployment's own password accounts: the way back in after a reset, and on a
           * deployment with no providers at all, the only way in. Hidden on pure SSO, where no
           * password exists to check.
           */}
          {options?.emailPassword ? (
            <form className="mt-3" onSubmit={handlePasswordSignIn}>
              {providers.length > 0 || options.sso ? (
                <div className="mb-3 flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">
                    {t("signIn.or")}
                  </span>
                  <Separator className="flex-1" />
                </div>
              ) : null}
              <label className="sr-only" htmlFor="sign-in-email">
                {t("signIn.emailLabel")}
              </label>
              <Input
                autoComplete="email"
                id="sign-in-email"
                onChange={(event) => setPasswordEmail(event.target.value)}
                placeholder={t("signIn.emailPlaceholder")}
                required
                type="email"
                value={passwordEmail}
              />
              <label className="sr-only" htmlFor="sign-in-password">
                {t("signIn.passwordLabel")}
              </label>
              <Input
                aria-describedby={error ? "sign-in-error" : undefined}
                autoComplete="current-password"
                className="mt-2"
                id="sign-in-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("signIn.passwordLabel")}
                ref={passwordRef}
                required
                type="password"
                value={password}
              />
              {/*
               * The app's filled primary when this form is the only way in: with no providers
               * and no SSO, an outline button leaves the screen's one action lighter than the
               * inputs around it. With more than one way in, every way stays the same weight.
               */}
              <Button
                className="mt-2 h-10 w-full tracking-tight"
                disabled={opening !== null}
                size="lg"
                type="submit"
                variant={
                  providers.length === 0 && !options?.sso
                    ? "default"
                    : "outline"
                }
              >
                {opening === "password"
                  ? t("signIn.signingIn")
                  : t("signIn.continuePassword")}
              </Button>
            </form>
          ) : null}
          {/* The administrators' audited break-glass while SSO is required; everybody else is refused. */}
          {options?.emailPassword ? (
            <Link
              className="mt-4 block text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
              to="/forgot-password"
            >
              {t("signIn.forgotIxdaxjzz")}
            </Link>
          ) : null}
          {options?.ssoRequired && providers.length > 0 ? (
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-center text-muted-foreground">
                {t("signIn.adminSignIn")}
              </summary>
              <div className="mt-3">{providerButtons}</div>
            </details>
          ) : null}
          {error ? (
            <p
              className="mt-3 text-sm text-destructive"
              id="sign-in-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </motion.div>
      </motion.div>
    </div>
  );
}
