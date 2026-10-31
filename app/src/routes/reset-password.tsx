import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import AuthShell from "@/components/auth/auth-shell";
import { Button, buttonVariants } from "@/components/ui/button";
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
  const passwordRef = useRef<HTMLInputElement>(null);

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
        if (!INVALID_CODES.has(result.error.code ?? "")) {
          passwordRef.current?.focus();
        }
        return;
      }
      await signOut.mutateAsync().catch(() => {});
      setState("done");
    } catch {
      setState("failed");
      passwordRef.current?.focus();
    } finally {
      setPending(false);
    }
  }

  // A dead link is the page's whole subject; the "set a new password" heading on top of it
  // contradicted the sentence below it.
  const heading =
    state === "invalid"
      ? t("resetIxdaxjzz.invalidTitle")
      : t("resetIxdaxjzz.title");

  return (
    <AuthShell title={heading}>
      <div className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">{heading}</h1>
        {state !== "invalid" ? (
          <p className="text-sm text-muted-foreground">
            {t("resetIxdaxjzz.description")}
          </p>
        ) : null}
      </div>
      {state === "invalid" ? (
        <div className="space-y-4">
          <p className="text-sm text-destructive" role="alert">
            {t("resetIxdaxjzz.invalid")}
          </p>
          {/* The page's one action is a button now, not the quietest text on the screen. */}
          <Link
            className={buttonVariants({ class: "w-full" })}
            to="/forgot-password"
          >
            {t("resetIxdaxjzz.requestNew")}
          </Link>
        </div>
      ) : state === "done" ? (
        <div className="space-y-4">
          <p className="text-sm font-medium" role="status">
            {t("resetIxdaxjzz.done")}
          </p>
          <Link className={buttonVariants({ class: "w-full" })} to="/sign">
            {t("resetIxdaxjzz.signIn")}
          </Link>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={submit}>
          <label
            className="block text-left text-sm font-medium"
            htmlFor="new-password"
          >
            {t("resetIxdaxjzz.newIxdaxjzz")}
          </label>
          <Input
            aria-describedby="new-password-hint"
            autoComplete="new-password"
            disabled={pending}
            id="new-password"
            minLength={8}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder={t("signIn.passwordLabel")}
            ref={passwordRef}
            required
            type="password"
            value={newPassword}
          />
          <p
            className="text-left text-xs text-muted-foreground"
            id="new-password-hint"
          >
            {t("resetIxdaxjzz.newIxdaxjzzHint")}
          </p>
          <Button className="w-full" disabled={pending} size="lg" type="submit">
            {pending ? t("resetIxdaxjzz.resetting") : t("resetIxdaxjzz.reset")}
          </Button>
          {state === "failed" ? (
            <p className="text-sm text-destructive" role="alert">
              {t("resetIxdaxjzz.failed")}
            </p>
          ) : null}
        </form>
      )}
    </AuthShell>
  );
}
