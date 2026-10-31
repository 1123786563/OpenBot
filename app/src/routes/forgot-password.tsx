import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { recoveryAuthClient } from "@/lib/auth/client";
import { authProvidersQueryOptions } from "@/lib/auth/queries";

export const Route = createFileRoute("/forgot-password")({
  // Same reason as /sign: paint the screen with its answer, not a hole under the heading.
  beforeLoad: async ({ context }) => {
    await context.queryClient.ensureQueryData(authProvidersQueryOptions());
  },
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: ForgotIxdaxjzzPage,
});

function ForgotIxdaxjzzPage() {
  const { t } = useTranslation("common");
  const options = useQuery(authProvidersQueryOptions());
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"form" | "sent" | "closed" | "failed">(
    "form",
  );
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);

  async function sendLink() {
    const address = email.trim();
    setPending(true);
    setState("form");
    try {
      const result = await recoveryAuthClient.requestPasswordReset({
        email: address,
        redirectTo: "/reset-password",
      });
      if (result.error?.code === "PASSWORD_RECOVERY_CLOSED_FOR_SSO") {
        setState("closed");
      } else if (result.error) {
        setState("failed");
        emailRef.current?.focus();
      } else {
        setSentTo(address);
        setState("sent");
      }
    } catch {
      setState("failed");
      emailRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendLink();
  }

  /*
   * "Closed" is only a fact once the answer arrived. A failed or in-flight providers read is
   * not "no password sign-in here" — telling an email-password user to go find an IdP the
   * deployment may not have was the query error wearing the wrong sentence.
   */
  const closed =
    state === "closed" ||
    (options.data !== undefined && options.data.emailPassword !== true);
  return (
    <AuthShell title={t("forgotIxdaxjzz.title")}>
      <div className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">
          {t("forgotIxdaxjzz.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("forgotIxdaxjzz.description")}
        </p>
      </div>
      {options.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {t("forgotIxdaxjzz.providersFailed")}
          </p>
          <Button
            disabled={options.isFetching}
            onClick={() => void options.refetch()}
            size="lg"
            type="button"
            variant="outline"
          >
            {t("forgotIxdaxjzz.retry")}
          </Button>
        </div>
      ) : closed ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("forgotIxdaxjzz.closed")}
        </p>
      ) : state === "sent" ? (
        <div className="space-y-3" role="status">
          <p className="text-sm font-medium">
            {t("forgotIxdaxjzz.sent", { email: sentTo })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("forgotIxdaxjzz.sentHint")}
          </p>
          <Button
            disabled={pending}
            onClick={() => void sendLink()}
            size="lg"
            type="button"
            variant="outline"
          >
            {t("forgotIxdaxjzz.resend")}
          </Button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit}>
          <label className="sr-only" htmlFor="recovery-email">
            {t("forgotIxdaxjzz.email")}
          </label>
          <Input
            aria-describedby={
              state === "failed" ? "recovery-email-error" : undefined
            }
            autoComplete="email"
            disabled={pending}
            id="recovery-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("signIn.emailPlaceholder")}
            ref={emailRef}
            required
            type="email"
            value={email}
          />
          <Button className="w-full" disabled={pending} size="lg" type="submit">
            {pending ? t("forgotIxdaxjzz.sending") : t("forgotIxdaxjzz.send")}
          </Button>
          {state === "failed" ? (
            <p
              className="text-sm text-destructive"
              id="recovery-email-error"
              role="alert"
            >
              {t("forgotIxdaxjzz.failed")}
            </p>
          ) : null}
        </form>
      )}
      <Link
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        to="/sign"
      >
        {t("forgotIxdaxjzz.back")}
      </Link>
    </AuthShell>
  );
}
