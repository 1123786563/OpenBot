import {
  IconKey,
  IconLock,
  IconPointer,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/router-link";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  cancelSignInMutationOptions,
  confirmSavedLoginMutationOptions,
  finishSignInMutationOptions,
  submitSignInCodeMutationOptions,
  submitSignInMutationOptions,
  takeOverSignInMutationOptions,
} from "@/lib/passwords/mutations";
import {
  FINAL_SIGN_IN,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import { queryClient } from "@/query-client";

/**
 * The private sign-in form.
 *
 * Outside the conversation on purpose: what is typed here goes to the server in one request and from
 * there straight into the Bot's browser. It is never a chat message, a tool argument or a tool
 * result, so the model never sees it, and the transcript never holds it. The password lives in this
 * component's state until it is sent and is cleared the moment it is.
 *
 * Three answers while the request is open: type a login, confirm a saved one, or decline; a fourth
 * hands the browser over. A verification code is never asked for here up front. If the site, once it
 * has the password, sends one, the request reads `code_required` and the form asks for that code
 * alone, then sends it on its own, cleared from state the same way.
 */
export function SignInForm({ requestId }: { requestId: string }) {
  const { t } = useTranslation("common");
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    // Polled so a takeover finishing elsewhere, or the request expiring, shows here.
    refetchInterval: (query) =>
      query.state.data && FINAL_SIGN_IN.includes(query.state.data.status)
        ? false
        : 3_000,
  });
  const submit = useMutation(submitSignInMutationOptions(queryClient));
  const submitCode = useMutation(submitSignInCodeMutationOptions(queryClient));
  const confirmSaved = useMutation(
    confirmSavedLoginMutationOptions(queryClient),
  );
  const takeOver = useMutation(takeOverSignInMutationOptions(queryClient));
  const finish = useMutation(finishSignInMutationOptions(queryClient));
  const cancel = useMutation(cancelSignInMutationOptions(queryClient));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [save, setSave] = useState(false);
  // A failed send's sentence outlives the send: the mutations carrying what was typed are reset
  // once settled, so TanStack keeps no variables, and what the person needs to read is held here.
  const [failure, setFailure] = useState<string | null>(null);
  const id = useId();

  // The observers — and so the resets — are stable for the component's life; only the first pair
  // is kept, and those are the two that carry what was typed.
  const secretCarriers = useRef([submit, submitCode]);
  useEffect(
    // Unmount with a send still in the air: what was typed goes with the component, not into the
    // mutation cache, whose settled entries would otherwise outlive the form until gc.
    () => () => {
      for (const carrier of secretCarriers.current) carrier.reset();
    },
    [],
  );

  /** Leaving this step, one way or another: nothing typed stays anywhere. */
  const forgetTyped = () => {
    setUsername("");
    setPassword("");
    setCode("");
    setFailure(null);
    for (const carrier of secretCarriers.current) carrier.reset();
  };

  if (request.isPending) return null;
  if (request.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        {request.error.message}
      </p>
    );
  const data = request.data;
  const busy =
    submit.isPending ||
    submitCode.isPending ||
    confirmSaved.isPending ||
    takeOver.isPending ||
    finish.isPending ||
    cancel.isPending;

  if (FINAL_SIGN_IN.includes(data.status))
    return (
      <PageSection
        title={
          data.status === "signed_in"
            ? t("signInForm.signedIn")
            : t("signInForm.closed")
        }
      >
        <p className="text-muted-foreground text-sm">
          {data.outcome ?? t("signInForm.noLongerOpen")}
        </p>
      </PageSection>
    );

  if (data.status === "code_required")
    return (
      <PageSection
        title={t("signInForm.codeTitle")}
        description={t("signInForm.codeDescription")}
      >
        {/* The step appeared without any action of theirs; say so where a screen reader hears it. */}
        <p className="sr-only" role="status">
          {t("signInForm.codeStepNotice")}
        </p>
        <form
          className="flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const value = code.trim();
            if (!value) return;
            setFailure(null);
            submitCode.mutate(
              { id: requestId, code: value },
              {
                // Cleared whatever happened: a code is good once, and a wrong one is retyped.
                onSettled: (_data, error) => {
                  setCode("");
                  setFailure(error?.message ?? null);
                  submitCode.reset();
                },
              },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-code`}>
            {t("signInForm.code")}
            <Input
              id={`${id}-code`}
              autoComplete="one-time-code"
              autoFocus
              inputMode="numeric"
              name="code"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {data.outcome ? (
            <p className="text-destructive text-sm" role="alert">
              {data.outcome}
            </p>
          ) : null}
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !code.trim()}>
              <IconShieldCheck />
              {submitCode.isPending
                ? t("signInForm.checking")
                : t("signInForm.finishSignIn")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                forgetTyped();
                takeOver.mutate(requestId, {
                  onSettled: (_data, error) =>
                    setFailure(error?.message ?? null),
                });
              }}
            >
              <IconPointer />
              {t("signInForm.takeOver")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                forgetTyped();
                cancel.mutate(requestId, {
                  onSettled: (_data, error) =>
                    setFailure(error?.message ?? null),
                });
              }}
            >
              {t("signInForm.cancel")}
            </Button>
          </div>
        </form>
      </PageSection>
    );

  if (data.status === "taken_over")
    return (
      <PageSection
        title={t("signInForm.takeOverTitle")}
        description={t("signInForm.takeOverDescription")}
      >
        <div className="flex flex-wrap gap-2">
          <ButtonLink
            size="sm"
            variant="outline"
            to="/bot"
            search={{ agent: data.botId, watch: true }}
          >
            {t("signInForm.openBrowser")}
          </ButtonLink>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              finish.mutate(requestId, {
                onSettled: (_data, error) => setFailure(error?.message ?? null),
              })
            }
          >
            {finish.isPending
              ? t("signInForm.finishing")
              : t("signInForm.iHaveSignedIn")}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              forgetTyped();
              cancel.mutate(requestId, {
                onSettled: (_data, error) => setFailure(error?.message ?? null),
              });
            }}
          >
            {t("signInForm.cancel")}
          </Button>
        </div>
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
      </PageSection>
    );

  // The login is on its way to the site and this form has nothing to add: any control here would
  // ask the server for a second attempt it must refuse while one is running. The poll brings the
  // answer — signed in, a code step, or a refusal worth reading — within seconds.
  if (data.status === "filling")
    return (
      <PageSection
        title={t("signInForm.signingIn")}
        description={t("signInForm.workingDescription")}
      >
        {data.outcome ? (
          <p className="text-destructive text-sm" role="alert">
            {data.outcome}
          </p>
        ) : null}
        {failure ? (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        ) : null}
      </PageSection>
    );

  return (
    <>
      {data.outcome ? (
        <p className="text-destructive text-sm" role="alert">
          {data.outcome}
        </p>
      ) : null}
      {data.savedLogins.length > 0 ? (
        <PageSection
          title={t("signInForm.useSavedTitle")}
          description={t("signInForm.useSavedDescription", {
            origin: data.origin,
          })}
        >
          <PageRows>
            {data.savedLogins.map((login, index) => (
              <div key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{login.username}</ItemTitle>
                    <ItemDescription>{data.origin}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        confirmSaved.mutate(
                          { id: requestId, loginId: login.id },
                          {
                            onSettled: (_data, error) =>
                              setFailure(error?.message ?? null),
                          },
                        )
                      }
                    >
                      {t("signInForm.confirmAndSignIn")}
                    </Button>
                  </ItemActions>
                </Item>
              </div>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        title={t("signInForm.enterTitle")}
        description={t("signInForm.enterDescription")}
      >
        <form
          className="flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (!password) return;
            setFailure(null);
            submit.mutate(
              {
                id: requestId,
                input: {
                  ...(username ? { username } : {}),
                  password,
                  save,
                },
              },
              {
                // Cleared whatever happened: a failed attempt is retyped, never kept.
                onSettled: (_data, error) => {
                  setPassword("");
                  setFailure(error?.message ?? null);
                  submit.reset();
                },
              },
            );
          }}
        >
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-username`}
          >
            {t("signInForm.username")}
            <Input
              id={`${id}-username`}
              autoComplete="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-password`}
          >
            {t("signInForm.password")}
            <Input
              id={`${id}-password`}
              autoComplete="current-password"
              name="password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {data.passwordManager ? (
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={`${id}-save`}
            >
              <Checkbox
                id={`${id}-save`}
                checked={save}
                onCheckedChange={(checked) => setSave(checked === true)}
              />
              {t("signInForm.saveToPasswords")}
            </label>
          ) : null}
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={busy || !password}>
              <IconLock />
              {submit.isPending
                ? t("signInForm.signingIn")
                : t("signInForm.signIn")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                forgetTyped();
                takeOver.mutate(requestId, {
                  onSettled: (_data, error) =>
                    setFailure(error?.message ?? null),
                });
              }}
            >
              <IconPointer />
              {t("signInForm.takeOver")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                forgetTyped();
                cancel.mutate(requestId, {
                  onSettled: (_data, error) =>
                    setFailure(error?.message ?? null),
                });
              }}
            >
              {t("signInForm.decline")}
            </Button>
          </div>
        </form>
      </PageSection>
    </>
  );
}
