import {
  EMPTY_WHAT_IF_ACTION,
  missingFrom,
  type WhatIfAction,
} from "@openbot/shared/what-if";
import { IconSparkles } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState } from "react";
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
import { whatIfVocabularyQueryOptions } from "@/lib/what-if/queries";

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
  const vocabulary = useQuery(whatIfVocabularyQueryOptions());
  const [text, setText] = useState("");
  const [asking, setAsking] = useState(false);
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<string | null>(null);
  /** The question the chips were read from, until the admin starts over. */
  const [asked, setAsked] = useState<string | null>(null);
  const [action, setActionState] = useState<WhatIfAction>(
    () => actionFrom(search.action) ?? EMPTY_WHAT_IF_ACTION,
  );
  const [checked, setChecked] = useState<WhatIfChecked | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkProblem, setCheckProblem] = useState<string | null>(null);
  const questionRevision = useRef(0);
  const actionRevision = useRef(0);
  const questionInput = useRef<HTMLInputElement>(null);
  const actionHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const checkTrigger = useRef<HTMLButtonElement | null>(null);
  const exampleId = useId();
  const question = text.trim();

  useLayoutEffect(() => {
    if (checked && document.activeElement === checkTrigger.current) {
      revealHeading(resultHeading.current);
    }
  }, [checked]);

  const setAction = (next: WhatIfAction) => {
    actionRevision.current += 1;
    setActionState(next);
    // The answer below is for the action as it was checked; a change makes it stale.
    setChecked(null);
    setCheckProblem(null);
  };

  const ask = async (form: HTMLFormElement) => {
    if (!question || asking || checking) return;
    const questionVersion = questionRevision.current;
    const actionVersion = actionRevision.current;
    const isCurrent = () =>
      questionVersion === questionRevision.current &&
      actionVersion === actionRevision.current;
    setAskProblem(null);
    setUnclear(null);
    setAsking(true);
    try {
      const reading = await askWhatIf(question);
      if (!isCurrent()) return;
      if (reading.understood === "no") setUnclear(reading.unclear);
      else {
        setAsked(question);
        setAction(reading.action);
        if (form.contains(document.activeElement)) {
          revealHeading(actionHeading.current);
        }
      }
    } catch (thrown) {
      if (isCurrent())
        setAskProblem(
          thrown instanceof Error
            ? thrown.message
            : "Couldn't read that question. Try again.",
        );
    } finally {
      setAsking(false);
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
    if (missing || checking || asking || vocabulary.isError) return;
    const version = actionRevision.current;
    setChecked(null);
    setCheckProblem(null);
    setChecking(true);
    try {
      const result = await checkWhatIf(action, asked ?? undefined);
      if (version === actionRevision.current) {
        checkTrigger.current = trigger;
        setChecked(result);
      }
    } catch (thrown) {
      if (version === actionRevision.current)
        setCheckProblem(
          thrown instanceof Error
            ? thrown.message
            : "Couldn't check that action. Try again.",
        );
    } finally {
      setChecking(false);
    }
  };

  return (
    <GovernancePage
      description="Ask what OpenBot would do if a Bot took an action. Every control answers in the order OpenBot checks them, and you see which one decides."
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
            aria-describedby={exampleId}
            aria-label="Ask what would happen"
            maxLength={QUESTION_LIMIT}
            onChange={(event) => {
              questionRevision.current += 1;
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
            value={text}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              aria-disabled={asking || undefined}
              disabled={!question || checking}
              size="sm"
              type="submit"
              variant="default"
            >
              {asking ? "Reading…" : "Ask"}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <p className="text-muted-foreground text-sm" id={exampleId}>
          For example, could the Sales Bot send an email from Gmail during a
          routine?
        </p>
        {askProblem ? (
          <p
            className="text-destructive text-sm"
            data-what-if-problem
            role="alert"
          >
            {askProblem}
          </p>
        ) : unclear ? (
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
          asked
            ? asked === question
              ? "Review how OpenBot read your question, then check the action."
              : `This action is based on “${asked}”. Ask again to use your edited question.`
            : "Ask a question above, or set the action yourself."
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
              {started ? (
                <GovernanceAction
                  label="Start over"
                  variant="outline"
                  onClick={() => {
                    questionRevision.current += 1;
                    actionRevision.current += 1;
                    setText("");
                    setAsked(null);
                    setUnclear(null);
                    setAskProblem(null);
                    setActionState(EMPTY_WHAT_IF_ACTION);
                    setChecked(null);
                    setCheckProblem(null);
                    questionInput.current?.focus();
                  }}
                  type="button"
                />
              ) : null}
              <GovernanceAction
                aria-disabled={checking || undefined}
                label={
                  checking ? "Checking…" : checkProblem ? "Try again" : "Check"
                }
                disabled={Boolean(missing) || asking || vocabulary.isError}
                onClick={(event) => void check(event.currentTarget)}
                type="button"
              />
            </>
          }
        >
          {vocabulary.isError ? (
            <ReadError
              message="Couldn't load this OpenBot's Bots and apps."
              description="Your question and action are still here."
              retry={vocabulary.refetch}
              retrying={vocabulary.isFetching}
              retryBelow
            />
          ) : vocabulary.isPending ? (
            <ReadStatus kind="loading" message="Loading Bots and apps…" />
          ) : (
            <ActionChips
              action={action}
              onChange={setAction}
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

      {checked ? (
        <PageSection
          description="Each control, in the order OpenBot checks them."
          headingRef={resultHeading}
          title="What happens"
        >
          <WhatIfResultView result={checked.result} />
        </PageSection>
      ) : null}
    </GovernancePage>
  );
}
