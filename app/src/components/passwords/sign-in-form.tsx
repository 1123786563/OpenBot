import { HStack } from "@astryxdesign/core/HStack";
import {
  IconKey,
  IconLock,
  IconPointer,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
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
  type SignInRequest,
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
 * Four answers: type a login, confirm a saved one, take over the browser, or decline.
 *
 * A verification code is never asked for here up front. If the site, once it has the password, sends
 * one, the server reports `code_required` and this form asks for that code alone, then sends it on
 * its own, cleared from state the same way.
 */
export function SignInForm({
  requestId,
  inDialog = false,
}: {
  requestId: string;
  /** Drawn in the chat's sign-in dialog rather than on the page of its own. */
  inDialog?: boolean;
}) {
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    // Polled so a takeover finishing elsewhere, or the request expiring, shows here.
    refetchInterval: (query) =>
      query.state.data && FINAL_SIGN_IN.includes(query.state.data.status)
        ? false
        : 3_000,
  });
  if (request.isPending) return null;
  if (request.error)
    return (
      <p className="text-destructive text-sm" role="alert">
        {request.error.message}
      </p>
    );

  return (
    <SignInFields
      key={requestId}
      requestId={requestId}
      data={request.data}
      inDialog={inDialog}
    />
  );
}

export function SignInFields({
  requestId,
  data,
  inDialog = false,
}: {
  requestId: string;
  data: SignInRequest;
  inDialog?: boolean;
}) {
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
  const id = useId();
  const codeField = useRef<HTMLInputElement>(null);
  const browserLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body) {
      if (data.status === "code_required") codeField.current?.focus();
      if (data.status === "taken_over") browserLink.current?.focus();
    }
  }, [data.status]);
  /*
   * In a dialog the sections stack in its body's own 16px rhythm. The 48px a page puts above each
   * section, to keep unrelated decisions apart, left the dialog mostly empty space above each heading.
   */
  const section = inDialog ? "mt-0" : "mt-6";
  const touchTarget = inDialog ? undefined : "min-h-11";

  const busy =
    data.status === "filling" ||
    submit.isPending ||
    submitCode.isPending ||
    confirmSaved.isPending ||
    takeOver.isPending ||
    finish.isPending ||
    cancel.isPending;
  const failure =
    submitCode.error ??
    submit.error ??
    confirmSaved.error ??
    takeOver.error ??
    finish.error ??
    cancel.error;

  if (FINAL_SIGN_IN.includes(data.status))
    return (
      <PageSection
        className={section}
        title={data.status === "signed_in" ? "Signed in" : "Closed"}
      >
        <p className="text-muted-foreground text-sm">
          {data.outcome ?? "This sign-in has ended."}
        </p>
      </PageSection>
    );

  if (data.status === "code_required")
    return (
      <PageSection
        className={section}
        title="Enter the verification code"
        description="The site sent a verification code. Enter it to finish signing in."
      >
        <form
          className="mt-4 flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            const value = code.trim();
            if (busy || !value) return;
            submitCode.mutate(
              { id: requestId, code: value },
              // Cleared whatever happened: a code is good once, and a wrong one is retyped.
              { onSettled: () => setCode("") },
            );
          }}
        >
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-code`}>
            Verification code
            <Input
              id={`${id}-code`}
              className={touchTarget}
              autoComplete="one-time-code"
              inputMode="numeric"
              name="code"
              required
              ref={codeField}
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          {failure || data.outcome ? (
            <p className="text-destructive text-sm" role="alert">
              {failure?.message ?? data.outcome}
            </p>
          ) : null}
          <HStack gap={2} hAlign="end" wrap="wrap">
            <Button
              className={touchTarget}
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              Cancel
            </Button>
            <Button
              className={touchTarget}
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => takeOver.mutate(requestId)}
            >
              <IconPointer />
              Take over to finish
            </Button>
            <Button
              className={touchTarget}
              size="sm"
              type="submit"
              disabled={busy || !code.trim()}
            >
              <IconShieldCheck />
              {submitCode.isPending ? "Checking…" : "Finish signing in"}
            </Button>
          </HStack>
        </form>
      </PageSection>
    );

  if (data.status === "taken_over")
    return (
      <PageSection
        className={section}
        title="Sign in by hand"
        description="Open the Bot's browser and sign in yourself. Then choose I've signed in and the Bot carries on."
      >
        <HStack gap={2} hAlign="end" paddingBlockStart={4} wrap="wrap">
          <Button
            className={touchTarget}
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => cancel.mutate(requestId)}
          >
            Cancel
          </Button>
          <Button
            className={touchTarget}
            size="sm"
            variant="outline"
            render={
              <Link
                ref={browserLink}
                to="/bot"
                search={{ agent: data.botId, watch: true }}
              />
            }
          >
            Open the Bot's browser
          </Button>
          <Button
            className={touchTarget}
            size="sm"
            disabled={busy}
            onClick={() => finish.mutate(requestId)}
          >
            {finish.isPending ? "Finishing…" : "I've signed in"}
          </Button>
        </HStack>
        {failure ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
      </PageSection>
    );

  return (
    <>
      {data.status === "filling" ? (
        <p role="status">Your Bot is checking the sign-in in its browser.</p>
      ) : null}
      {data.outcome ? (
        <p className="text-destructive text-sm" role="alert">
          {data.outcome}
        </p>
      ) : null}
      {data.savedLogins.length > 0 ? (
        <PageSection
          className={section}
          title="Use a saved login"
          description="Choose the account you want the Bot to use."
        >
          <PageRows>
            {data.savedLogins.map((login, index) => (
              <Fragment key={login.id}>
                {index > 0 ? <Separator /> : null}
                <Item className="flex-wrap" size="sm">
                  <ItemMedia variant="icon">
                    <IconKey />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="min-w-0 break-all">
                      {login.username}
                    </ItemTitle>
                  </ItemContent>
                  <ItemActions className="w-full sm:w-auto">
                    <Button
                      className={touchTarget}
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        confirmSaved.mutate({
                          id: requestId,
                          loginId: login.id,
                        })
                      }
                    >
                      Confirm and sign in
                    </Button>
                  </ItemActions>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}
      <PageSection
        className={section}
        title="Enter your login"
        description="This goes straight into the Bot's browser. The Bot only learns whether it worked."
      >
        <form
          className="mt-4 flex flex-col gap-3"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !password) return;
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
                onSettled: () => setPassword(""),
              },
            );
          }}
        >
          <label
            className="flex flex-col gap-1 text-sm"
            htmlFor={`${id}-username`}
          >
            Username or email
            <Input
              id={`${id}-username`}
              className={touchTarget}
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
            Password
            <Input
              id={`${id}-password`}
              className={touchTarget}
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
              Save this login
            </label>
          ) : null}
          {failure ? (
            <p className="text-destructive text-sm" role="alert">
              {failure.message}
            </p>
          ) : null}
          <HStack gap={2} hAlign="end" wrap="wrap">
            <Button
              className={touchTarget}
              size="sm"
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => cancel.mutate(requestId)}
            >
              Decline
            </Button>
            <Button
              className={touchTarget}
              size="sm"
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => takeOver.mutate(requestId)}
            >
              <IconPointer />
              Take over to sign in
            </Button>
            <Button
              className={touchTarget}
              size="sm"
              type="submit"
              disabled={busy || !password}
            >
              <IconLock />
              {submit.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </HStack>
        </form>
      </PageSection>
    </>
  );
}
