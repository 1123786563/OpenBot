import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { recoveryAuthClient } from "@/lib/auth/client";
import { authProvidersQueryOptions } from "@/lib/auth/queries";
import { invitationSessionQueryOptions } from "@/lib/enterprise/tenant/directory";

export const Route = createFileRoute("/verify-email")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
    verified: search.verified === "1",
  }),
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { t } = useTranslation("common");
  const { error, verified } = Route.useSearch();
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
  const isExpired = error === "TOKEN_EXPIRED" || error === "INVALID_TOKEN";
  const alreadyVerified = session.data?.emailVerified === true;

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {t("verifyEmail.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("verifyEmail.description")}
          </p>
        </div>
        {isExpired ? (
          <p className="text-sm text-destructive" role="alert">
            {t("verifyEmail.expired")}
          </p>
        ) : verified || alreadyVerified ? (
          <p className="text-sm text-muted-foreground" role="status">
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
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            {t("verifyEmail.description")}
          </p>
        )}
        <Link
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          to="/sign"
        >
          {t("verifyEmail.signIn")}
        </Link>
      </div>
    </main>
  );
}
