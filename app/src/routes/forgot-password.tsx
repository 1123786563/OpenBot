import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { recoveryAuthClient } from "@/lib/auth/client";
import { authProvidersQueryOptions } from "@/lib/auth/queries";

export const Route = createFileRoute("/forgot-password")({
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

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setState("form");
    try {
      const result = await recoveryAuthClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: "/reset-password",
      });
      if (result.error?.code === "PASSWORD_RECOVERY_CLOSED_FOR_SSO") {
        setState("closed");
      } else if (result.error) {
        setState("failed");
      } else {
        setState("sent");
      }
    } catch {
      setState("failed");
    } finally {
      setPending(false);
    }
  }

  const closed = state === "closed" || options.data?.emailPassword !== true;
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {t("forgotIxdaxjzz.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("forgotIxdaxjzz.description")}
          </p>
        </div>
        {options.isPending ? null : closed ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("forgotIxdaxjzz.closed")}
          </p>
        ) : state === "sent" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("forgotIxdaxjzz.sent")}
          </p>
        ) : (
          <form className="space-y-3" onSubmit={(event) => void submit(event)}>
            <label className="sr-only" htmlFor="recovery-email">
              {t("forgotIxdaxjzz.email")}
            </label>
            <Input
              autoComplete="email"
              disabled={pending}
              id="recovery-email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
            <Button className="w-full" disabled={pending} type="submit">
              {pending ? t("forgotIxdaxjzz.sending") : t("forgotIxdaxjzz.send")}
            </Button>
            {state === "failed" ? (
              <p className="text-sm text-destructive" role="alert">
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
      </div>
    </main>
  );
}
