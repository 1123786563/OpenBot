import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { recoveryAuthClient } from "@/lib/auth/client";
import { signOutMutationOptions } from "@/lib/auth/mutations";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  head: () => ({ meta: [{ name: "referrer", content: "no-referrer" }] }),
  component: ResetIxdaxjzzPage,
});

const INVALID_CODES = new Set([
  "IDENTITY_RECOVERY_TOKEN_UNKNOWN",
  "IDENTITY_RECOVERY_TOKEN_INVALID",
  "IDENTITY_RECOVERY_TOKEN_NOT_CONSUMED",
  "INVALID_TOKEN",
]);

function ResetIxdaxjzzPage() {
  const { t } = useTranslation("common");
  const { token, error } = Route.useSearch();
  const queryClient = useQueryClient();
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const [newPassword, setNewPassword] = useState("");
  const [state, setState] = useState<"form" | "done" | "invalid" | "failed">(
    error || !token ? "invalid" : "form",
  );
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return setState("invalid");
    setPending(true);
    try {
      const result = await recoveryAuthClient.resetPassword({
        token,
        newPassword,
      });
      if (result.error) {
        setState(
          INVALID_CODES.has(result.error.code ?? "") ? "invalid" : "failed",
        );
        return;
      }
      await signOut.mutateAsync().catch(() => {});
      setState("done");
    } catch {
      setState("failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-medium tracking-tight">
            {t("resetIxdaxjzz.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("resetIxdaxjzz.description")}
          </p>
        </div>
        {state === "invalid" ? (
          <p className="text-sm text-destructive" role="alert">
            {t("resetIxdaxjzz.invalid")}
          </p>
        ) : state === "done" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("resetIxdaxjzz.done")}
          </p>
        ) : (
          <form className="space-y-3" onSubmit={(event) => void submit(event)}>
            <label className="sr-only" htmlFor="new-password">
              {t("resetIxdaxjzz.newIxdaxjzz")}
            </label>
            <Input
              autoComplete="new-password"
              disabled={pending}
              id="new-password"
              minLength={8}
              onChange={(event) => setNewPassword(event.target.value)}
              required
              type="password"
              value={newPassword}
            />
            <Button className="w-full" disabled={pending} type="submit">
              {pending
                ? t("resetIxdaxjzz.resetting")
                : t("resetIxdaxjzz.reset")}
            </Button>
            {state === "failed" ? (
              <p className="text-sm text-destructive" role="alert">
                {t("resetIxdaxjzz.failed")}
              </p>
            ) : null}
          </form>
        )}
        {state === "invalid" ? (
          <Link
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            to="/forgot-password"
          >
            {t("resetIxdaxjzz.requestNew")}
          </Link>
        ) : state === "done" ? (
          <Link
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            to="/sign"
          >
            {t("resetIxdaxjzz.signIn")}
          </Link>
        ) : null}
      </div>
    </main>
  );
}
