import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { recoveryAuthClient } from "@/lib/auth/client";
import { authProvidersQueryOptions } from "@/lib/auth/queries";
import { invitationSessionQueryOptions } from "@/lib/enterprise/tenant/directory";

export const Route = createFileRoute("/verify-email")({
  /*
   * `verified` accepts every spelling of the flag: better-auth's callbackURL is `?verified=1`,
   * and the router re-serializes the validated search on the next render, so a parse that only
   * matches one spelling reads its own re-serialization back as false — the success state was
   * unreachable on the cold load an email link always is.
   */
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
    // The router's search parser may hand back "1", "true", 1, or true depending on how the
    // value round-trips; every spelling means the same thing — the email link was followed.
    verified: ["1", "true", 1, true].includes(search.verified as never),
    // A token that arrives here unconsumed never got validated; treat it like the expired copy.
    token:
      typeof search.token === "string" && search.token !== ""
        ? search.token
        : undefined,
  }),
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { t } = useTranslation("common");
  const { error, verified, token } = Route.useSearch();
  const options = useQuery(authProvidersQueryOptions());
  const session = useQuery(invitationSessionQueryOptions());
  const resend = useMutation({
    mutationFn: async () => {
      if (!session.data || session.data.emailVerified) return;
      const result = await recoveryAuthClient.sendVerificationEmail({
        email: session.data.email,
        callbackURL: `${window.location.origin}/verify-email?verified=1`,
      });
      if (result.error) throw new Error(result.error.code ?? "SEND_FAILED");
    },
  });
  const isExpired =
    error === "TOKEN_EXPIRED" ||
    error === "INVALID_TOKEN" ||
    token !== undefined;
  const alreadyVerified = session.data?.emailVerified === true;
  const isVerified = verified || alreadyVerified;

  return (
    <AuthShell
      title={
        isExpired
          ? t("resetIxdaxjzz.invalidTitle")
          : isVerified
            ? t("verifyEmail.verified")
            : t("verifyEmail.title")
      }
    >
      <div className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">
          {t("verifyEmail.title")}
        </h1>
        {!isVerified && !isExpired ? (
          <p className="text-sm text-muted-foreground">
            {t("verifyEmail.description")}
          </p>
        ) : null}
      </div>
      {isExpired ? (
        <p className="text-sm text-destructive" role="alert">
          {t("verifyEmail.expired")}
        </p>
      ) : isVerified ? (
        <p className="text-sm font-medium" role="status">
          {alreadyVerified
            ? t("verifyEmail.alreadyVerified")
            : t("verifyEmail.verified")}
        </p>
      ) : session.data &&
        !session.data.emailVerified &&
        options.data?.emailPassword ? (
        <div className="space-y-3">
          <Button
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
            type="button"
          >
            {resend.isPending
              ? t("verifyEmail.resending")
              : t("verifyEmail.resend")}
          </Button>
          {resend.isSuccess ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("verifyEmail.resent")}
            </p>
          ) : null}
          {resend.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {t("verifyEmail.failed")}
            </p>
          ) : null}
        </div>
      ) : null}
      <Link
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        to="/sign"
      >
        {t("verifyEmail.signIn")}
      </Link>
    </AuthShell>
  );
}
