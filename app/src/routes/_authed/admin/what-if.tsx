import { Text } from "@astryxdesign/core/Text";
import {
  EMPTY_WHAT_IF_ACTION,
  missingFrom,
  type WhatIfAction,
} from "@openbot/shared/what-if";
import { IconSparkles } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import {
  GovernanceAction,
  GovernancePage,
} from "@/components/astryx-pilot/governance";
import { PageCard, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ActionChips } from "@/components/what-if/action-chips";
import { WhatIfResultView } from "@/components/what-if/what-if-result";
import { isComposing } from "@/lib/composing";
import {
  askWhatIf,
  checkWhatIf,
  type WhatIfChecked,
} from "@/lib/what-if/check";
import {
  isWhatIfAccessDenied,
  whatIfKeys,
  whatIfVocabularyQueryOptions,
} from "@/lib/what-if/queries";

/**
 * `action` is an action to start from, as JSON: what "Try a change" on an Audit row's "Why did this
 * happen?" hands over, so the admin can change one thing and check again.
 */
export const Route = createFileRoute("/_authed/admin/what-if")({
  validateSearch: z.object({ action: z.string().optional() }),
  component: WhatIfPage,
});

/** The longest question the server takes. */
const QUESTION_LIMIT = 500;
type RequestKind = "ask" | "check";

function revealHeading(heading: HTMLHeadingElement | null) {
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: "start" });
}

/** An action handed over in the address, or none. Only the action's own fields are read. */
function actionFrom(raw: string | undefined): WhatIfAction | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    const action = { ...EMPTY_WHAT_IF_ACTION };
    for (const key of Object.keys(action) as (keyof WhatIfAction)[])
      if (typeof parsed[key] === "string")
        (action as Record<string, string>)[key] = parsed[key] as string;
    return action;
  } catch {
    return null;
  }
}

/**
 * "What would happen if…": an admin asks what OpenBot would do with one action. The model only reads
 * the question as the action, shown as chips the admin can change; Check then asks every control in
 * the order OpenBot asks them, and says which one decides.
 *
 * Under What happened in Admin, beside Audit, whose rows answer the same question about the past.
 */
function WhatIfPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const vocabulary = useQuery(whatIfVocabularyQueryOptions());
  const [text, setText] = useState("");
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<string | null>(null);
  /** The question the chips were read from, until the admin starts over. */
  const [asked, setAsked] = useState<string | null>(null);
  const [action, setActionState] = useState<WhatIfAction>(
    () => actionFrom(search.action) ?? EMPTY_WHAT_IF_ACTION,
  );
  const [checked, setChecked] = useState<WhatIfChecked | null>(null);
  const [pending, setPending] = useState<RequestKind | null>(null);
  const request = useRef<{ kind: RequestKind; controller: AbortController }>(
    null,
  );
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const askTrigger = useRef<HTMLButtonElement>(null);
  const questionInput = useRef<HTMLInputElement>(null);
  const accessAlert = useRef<HTMLDivElement>(null);
  const setAccessAlert = useCallback((alert: HTMLDivElement | null) => {
    accessAlert.current = alert;
  }, []);
  const focusAccessAlert = useRef(false);
  const actionHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const checkTrigger = useRef<HTMLButtonElement | null>(null);
  const exampleId = useId();
  const stagesId = useId();
  const question = text.trim();
  const questionChanged = asked !== null && asked !== question;
  const linkedAction = useRef(search.action);
  const accessLost =
    vocabulary.data === null || isWhatIfAccessDenied(vocabulary.error);
  const vocabularyReady = !accessLost && vocabulary.isSuccess;
  const asking = pending === "ask";
  const checking = pending === "check";

  const cancelPending = useCallback(() => {
    const previous = request.current;
    if (!previous) return;
    request.current = null;
    previous.controller.abort();
    setPending(null);
  }, []);

  useEffect(
    () => () => {
      const previous = request.current;
      request.current = null;
      previous?.controller.abort();
    },
    [],
  );

  const resetScenario = useCallback(
    (start?: string) => {
      cancelPending();
      setText("");
      setAsked(null);
      setUnclear(null);
      setAskProblem(null);
      setActionState(actionFrom(start) ?? EMPTY_WHAT_IF_ACTION);
      setChecked(null);
      setCheckProblem(null);
    },
    [cancelPending],
  );

  const forgetLink = useCallback(() => {
    linkedAction.current = undefined;
    if (search.action !== undefined)
      void navigate({ search: {}, replace: true });
  }, [navigate, search.action]);

  useLayoutEffect(() => {
    if (accessLost) {
      if (focusAccessAlert.current) {
        focusAccessAlert.current = false;
        const previousFocus = document.activeElement;
        requestAnimationFrame(() => {
          if (
            document.activeElement === previousFocus ||
            document.activeElement === document.body
          )
            accessAlert.current?.focus();
        });
      }
      resetScenario();
      forgetLink();
    } else if (linkedAction.current !== search.action) {
      linkedAction.current = search.action;
      resetScenario(search.action);
    }
  }, [accessLost, forgetLink, resetScenario, search.action]);

  const stillAuthorized = () =>
    queryClient.getQueryData(whatIfKeys.vocabulary) !== null;
  const revokeScenario = (restoreFocus: boolean) => {
    focusAccessAlert.current = restoreFocus;
    void queryClient.cancelQueries(
      { queryKey: whatIfKeys.vocabulary, exact: true },
      { revert: false },
    );
    queryClient.setQueryData(whatIfKeys.vocabulary, null);
  };

  useLayoutEffect(() => {
    if (checked && document.activeElement === checkTrigger.current) {
      revealHeading(resultHeading.current);
    }
  }, [checked]);

  const setAction = (next: WhatIfAction) => {
    setActionState(next);
    // The answer below is for the action as it was checked; a change makes it stale.
    setChecked(null);
    setCheckProblem(null);
  };

  function startRequest(kind: RequestKind) {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = { kind, controller };
    setPending(kind);
    return controller;
  }

  function finishRequest(controller: AbortController) {
    if (request.current?.controller !== controller) return;
    request.current = null;
    setPending(null);
  }

  const ask = async (form: HTMLFormElement) => {
    if (!question || !vocabularyReady) return;
    const controller = startRequest("ask");
    if (!controller) return;
    setAskProblem(null);
    setUnclear(null);
    try {
      const reading = await askWhatIf(question, controller.signal);
      if (request.current?.controller !== controller || !stillAuthorized())
        return;
      if (reading.understood === "no") setUnclear(reading.unclear);
      else {
        setAsked(question);
        setAction(reading.action);
        if (form.contains(document.activeElement)) {
          revealHeading(actionHeading.current);
        }
      }
    } catch (thrown) {
      if (request.current?.controller !== controller) return;
      if (isWhatIfAccessDenied(thrown))
        revokeScenario(
          document.activeElement === askTrigger.current ||
            document.activeElement === questionInput.current ||
            document.activeElement === document.body,
        );
      else if (stillAuthorized())
        setAskProblem(
          thrown instanceof Error
            ? thrown.message
            : "Couldn't read that question. Try again.",
        );
    } finally {
      finishRequest(controller);
    }
  };

  const missing = vocabulary.data
    ? missingFrom(action, vocabulary.data)
    : "Loading this OpenBot's Bots and apps.";

  /* Anything a Start over would throw away: a typed or asked question, chips set by hand or by a
     deep link, an answer, or a problem with either. */
  const started =
    asked !== null ||
    checked !== null ||
    text !== "" ||
    askProblem !== null ||
    unclear !== null ||
    JSON.stringify(action) !== JSON.stringify(EMPTY_WHAT_IF_ACTION);

  const check = async (trigger: HTMLButtonElement) => {
    if (missing || !vocabularyReady) return;
    const controller = startRequest("check");
    if (!controller) return;
    setChecked(null);
    setCheckProblem(null);
    try {
      const result = await checkWhatIf(
        action,
        asked ?? undefined,
        controller.signal,
      );
      if (request.current?.controller === controller && stillAuthorized()) {
        checkTrigger.current = trigger;
        setChecked(result);
      }
    } catch (thrown) {
      if (request.current?.controller !== controller) return;
      if (isWhatIfAccessDenied(thrown))
        revokeScenario(document.activeElement === trigger);
      else if (stillAuthorized())
        setCheckProblem(
          thrown instanceof Error
            ? thrown.message
            : "Couldn't check that action. Try again.",
        );
    } finally {
      finishRequest(controller);
    }
  };

  return (
    <GovernancePage
      description="Simulate whether a Bot action would be allowed, blocked, or need approval. The result shows which control decides."
      title="Test a policy"
    >
      <form
        className="flex flex-col gap-2"
        data-asking={asking ? "true" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void ask(event.currentTarget);
        }}
      >
        <InputGroup>
          <InputGroupAddon>
            <IconSparkles />
          </InputGroupAddon>
          <InputGroupInput
            aria-describedby={`${stagesId} ${exampleId}`}
            aria-label="Ask what would happen"
            disabled={accessLost}
            maxLength={QUESTION_LIMIT}
            onChange={(event) => {
              if (request.current?.kind === "ask") cancelPending();
              setText(event.target.value);
              setAskProblem(null);
              setUnclear(null);
            }}
            onKeyDown={(event) => {
              // A composing IME's Enter picks a word. It doesn't ask.
              if (event.key === "Enter" && isComposing(event))
                event.preventDefault();
            }}
            placeholder="Ask about one action a Bot could take"
            ref={questionInput}
            value={accessLost ? "" : text}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-disabled={asking || undefined}
              ref={askTrigger}
              disabled={!question || checking || !vocabularyReady}
              size="sm"
              type="submit"
              variant="default"
            >
              {asking ? "Reading…" : "Ask"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <p className="text-muted-foreground text-sm" id={stagesId}>
          Ask to prepare an action. Use Check to test it against the current
          policy.
        </p>
        <p className="text-muted-foreground text-sm" id={exampleId}>
          For example, could the Sales Bot send an email from Gmail during a
          routine?
        </p>
        {!accessLost && askProblem ? (
          <p
            className="text-destructive text-sm"
            data-what-if-problem
            role="alert"
          >
            {askProblem}
          </p>
        ) : !accessLost && unclear ? (
          <p
            className="text-amber-700 text-sm dark:text-amber-500"
            data-what-if-unclear
            role="status"
          >
            {unclear}
          </p>
        ) : null}
      </form>

      <PageSection
        description={
          !accessLost && asked ? (
            !questionChanged ? (
              "Review the action OpenBot prepared. Select Check to see what the policy would do."
            ) : (
              <Text as="span" style={{ overflowWrap: "anywhere" }}>
                {`This action is based on “${asked}”.`}
                {question ? " Ask again to use your edited question." : null}
              </Text>
            )
          ) : (
            "Ask a question above, or set the action yourself."
          )
        }
        headingRef={actionHeading}
        title="The action"
      >
        <PageCard
          className="mt-4"
          footer={
            <>
              {/* One step back to nothing: without it, starting a new question means
                  clearing chips one by one. */}
              {started && !accessLost ? (
                <GovernanceAction
                  label="Start over"
                  variant="outline"
                  onClick={() => {
                    resetScenario();
                    forgetLink();
                    questionInput.current?.focus();
                  }}
                  type="button"
                />
              ) : null}
              <GovernanceAction
                aria-describedby={stagesId}
                aria-disabled={checking || undefined}
                label={
                  checking ? "Checking…" : checkProblem ? "Try again" : "Check"
                }
                disabled={Boolean(missing) || asking || !vocabularyReady}
                onClick={(event) => void check(event.currentTarget)}
                type="button"
              />
            </>
          }
        >
          {accessLost || vocabulary.isError ? (
            <ReadError
              alertRef={accessLost ? setAccessAlert : undefined}
              message={
                accessLost
                  ? "Policy testing access is unavailable."
                  : "Couldn't load this OpenBot's Bots and apps."
              }
              description={
                accessLost
                  ? "Check that you still have access, then try again."
                  : checked
                    ? "The result below is from your last completed check. Retry before checking again."
                    : "Your question and action are still here."
              }
              focusAfterRetry={() => actionHeading.current}
              retry={vocabulary.refetch}
              retryLabel="Retry Bots and apps"
              retrying={vocabulary.isFetching}
              retryBelow
            />
          ) : !vocabulary.data ? (
            <ReadStatus kind="loading" message="Loading Bots and apps…" />
          ) : (
            <ActionChips
              action={action}
              onChange={(next) => {
                cancelPending();
                setAction(next);
              }}
              vocabulary={vocabulary.data}
            />
          )}
          {missing && vocabulary.isSuccess ? (
            <p
              className="mt-3 text-muted-foreground text-sm"
              data-what-if-missing
            >
              {missing}
            </p>
          ) : null}
          {checkProblem ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {checkProblem}
            </p>
          ) : null}
        </PageCard>
      </PageSection>

      {checked && !accessLost ? (
        <PageSection
          description="Each control, in the order OpenBot checks them."
          headingRef={resultHeading}
          title="What happens"
        >
          {questionChanged ? (
            <p className="mt-3 text-muted-foreground text-sm" role="status">
              This result is for the action above.
              {question
                ? " Select Ask to prepare an action from your edited question."
                : null}
            </p>
          ) : null}
          <WhatIfResultView result={checked.result} />
        </PageSection>
      ) : null}
    </GovernancePage>
  );
}
