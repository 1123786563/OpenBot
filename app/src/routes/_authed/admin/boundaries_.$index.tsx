import { Banner } from "@astryxdesign/core/Banner";
import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import {
  DescribeRule,
  type WrittenRule,
} from "@/components/boundaries/describe-rule";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import { RulePreview } from "@/components/boundaries/rule-preview";
import { RuleReading } from "@/components/boundaries/rule-reading";
import {
  RULE_EXPRESSION_HELP_ID,
  RuleExpressionHelp,
  RuleReference,
} from "@/components/boundaries/rule-reference";
import {
  PageCard,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import {
  boundaryListSearch,
  ruleId,
  ruleLabel,
  withoutRule,
  withRuleReplaced,
} from "@/lib/boundaries/rules";
import { ClientError } from "@/lib/client";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  policyDryRunQueryOptions,
  readActionPolicy,
} from "@/lib/computers/queries";

/** How long the rule has to rest before it is replayed, as on Add rule. */
const PREVIEW_DELAY_MS = 400;
const INLINE_REPLAY_LIMIT = 5;

export const Route = createFileRoute("/_authed/admin/boundaries_/$index")({
  validateSearch: boundaryListSearch,
  component: RulePage,
});

/**
 * One rule: what it is called, what it is made of, and what it has stopped lately.
 *
 * A rule link follows the same boundary through reordering and edits.
 */
function RulePage() {
  const { index: identifier } = Route.useParams();
  const legacy = /^\d+$/.test(identifier);
  const { q } = Route.useSearch();
  const back = {
    label: "Boundaries",
    linkProps: {
      to: "/admin/boundaries" as const,
      search: { q },
      state: { returnBoundaryRule: legacy ? undefined : identifier },
    },
  };
  const stored = useQuery({ ...actionPolicyQueryOptions(), enabled: !legacy });
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const denied =
    stored.error instanceof ClientError &&
    (stored.error.status === 401 || stored.error.status === 403);
  const policy = denied ? undefined : stored.data;
  const matches =
    legacy || !policy
      ? []
      : [...new Set(policy.deny)].filter(
          (entry) => ruleId(policy, entry) === identifier,
        );
  const rule = matches.length === 1 ? matches[0] : undefined;

  if (legacy) {
    return (
      <PageShell backButton={back} title="Choose a boundary">
        <p className="text-muted-foreground text-sm">
          This older link used a position in the list. The order may have
          changed. Return to Boundaries and find the rule by its name or
          expression.
        </p>
      </PageShell>
    );
  }

  if (!policy) {
    return (
      <PageShell backButton={back} title="Rule">
        {stored.error ? (
          <ReadError
            message="Couldn't load this boundary."
            retry={stored.refetch}
            retryBelow
            retrying={stored.isFetching}
          />
        ) : (
          <ReadStatus kind="loading" message="Loading boundary…" />
        )}
      </PageShell>
    );
  }
  if (rule === undefined) {
    return (
      <PageShell backButton={back} title="Rule">
        {confirmation}
        <p className="text-muted-foreground text-sm">
          This boundary isn't available at this link. Return to Boundaries to
          see the current rules.
        </p>
      </PageShell>
    );
  }
  // A bookmark keeps the same detail view while the saved expression changes.
  return (
    <>
      {confirmation}
      <RuleDetail
        key={identifier}
        policy={policy}
        rule={rule}
        back={back}
        onRemove={(trigger) => {
          const label = ruleLabel(policy, rule);
          requestConfirmation({
            title: `Remove “${label.name}”?`,
            description:
              "This boundary will stop applying to every Bot. Other boundaries and permissions still apply. To restore it, add the rule again.",
            confirmLabel: "Remove",
            pendingLabel: "Removing…",
            failureMessage: "Couldn't remove this boundary. Try again.",
            trigger,
            refresh: () => stored.refetch(),
            run: async () => {
              const { data: latest } = await stored.refetch({
                throwOnError: true,
              });
              if (
                !latest ||
                JSON.stringify(latest) !== JSON.stringify(policy)
              ) {
                throw new ActionUnavailable(
                  "The boundaries changed while you were reviewing them. Close this dialog and review the current policy.",
                );
              }
              try {
                await savePolicy.mutateAsync({
                  ...withoutRule(latest, rule),
                  expected: latest,
                });
              } catch (error) {
                const { data: verified } = await stored.refetch();
                if (verified && !verified.deny.includes(rule)) {
                  throw new ActionUnavailable(
                    "This boundary has been removed, but saving wasn't confirmed. Check Audit before making another change.",
                  );
                }
                throw error;
              }
              await navigate({ to: "/admin/boundaries", search: { q } });
            },
          });
        }}
      />
    </>
  );
}

function RuleDetail({
  back,
  policy,
  rule,
  onRemove,
}: {
  back: NonNullable<React.ComponentProps<typeof PageShell>["backButton"]>;
  policy: ActionPolicy;
  rule: string;
  onRemove: (trigger: HTMLElement) => void;
}) {
  const label = ruleLabel(policy, rule);
  const ruleField = useRef<HTMLTextAreaElement>(null);
  const focusAfterSave = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusAfterSave.current !== rule) return;
    focusAfterSave.current = null;
    if (document.activeElement === document.body) ruleField.current?.focus();
  }, [rule]);

  // Replay the current policy without this rule against recorded decisions, including trial refusals.
  const reach = useQuery(policyDryRunQueryOptions(withoutRule(policy, rule)));
  const changedDecisions =
    reach.data?.changes.filter((change) => change.would === "allowed") ?? [];
  const replayRows = (
    <DryRunChanges
      changes={changedDecisions}
      total={reach.data?.wouldAllow ?? 0}
      verdict="Would allow"
      verdictClassName="text-foreground"
    />
  );

  return (
    <PageShell
      backButton={back}
      description={label.description || undefined}
      title={label.name}
    >
      {policy.mode === "dry-run" ? (
        <p className="text-amber-600 text-sm dark:text-amber-500">
          Trial mode is on, so this rule records matching actions without
          stopping them.
        </p>
      ) : null}

      <PageSection
        description="Changing this rule updates what matches this boundary. Review the preview before saving."
        title="Rule"
      >
        <RuleEditor
          key={rule}
          onSaved={(expression) => {
            focusAfterSave.current = expression;
          }}
          policy={policy}
          rule={rule}
          ruleField={ruleField}
        />
      </PageSection>

      <PageSection
        description="Compare recent decisions against the current policy with this rule removed. Trial mode can record a refusal while allowing the action to continue."
        title="Replay without this rule"
      >
        {reach.isPending ? (
          <ReadStatus kind="loading" message="Replaying recent decisions…" />
        ) : reach.error ? (
          <ReadError
            message="Couldn't replay recent decisions."
            retry={reach.refetch}
            retryBelow
            retrying={reach.isFetching}
          />
        ) : reach.data.scanned === 0 ? (
          <p className="mt-4 text-muted-foreground text-sm">
            No recorded actions to replay yet.
          </p>
        ) : (
          <>
            <p className="mt-4 text-muted-foreground text-sm">
              {reach.data.wouldAllow === 0
                ? `None of the last ${reach.data.scanned} recorded decisions would change from refused to allowed.`
                : `${reach.data.wouldAllow} of the last ${reach.data.scanned} recorded decisions would change from refused to allowed.`}
            </p>
            {changedDecisions.length > INLINE_REPLAY_LIMIT ? (
              <details>
                <summary
                  style={{
                    cursor: "pointer",
                    minBlockSize: "var(--spacing-11)",
                    paddingBlock: "var(--spacing-3)",
                  }}
                >
                  {changedDecisions.length} changed decisions
                </summary>
                {replayRows}
              </details>
            ) : (
              replayRows
            )}
          </>
        )}
      </PageSection>

      <PageSection
        description="This boundary will stop applying to every Bot."
        title="Remove"
      >
        <Button
          className="mt-4 min-h-11"
          onClick={(event) => onRemove(event.currentTarget)}
          variant="destructive"
        >
          Remove rule
        </Button>
      </PageSection>
    </PageShell>
  );
}

/**
 * The rule, editable in CEL or rewritten from a description, and saved only by Save rule.
 *
 * A changed rule is replayed on its own as it rests, as Add rule replays a new one, so what the new
 * version would have stopped sits right above what the rule in force has stopped. Saved, it takes
 * the old rule's place and name.
 */
function RuleEditor({
  onSaved,
  policy,
  rule,
  ruleField,
}: {
  onSaved: (expression: string) => void;
  policy: ActionPolicy;
  rule: string;
  ruleField: RefObject<HTMLTextAreaElement | null>;
}) {
  const queryClient = useQueryClient();
  const saveOptions = saveActionPolicyMutationOptions(queryClient);
  const savePolicy = useMutation({
    ...saveOptions,
    onSuccess: (...args) => {
      if (args[0].deny.includes(trimmed)) onSaved(trimmed);
      toast.add({ title: "Rule saved", type: "success" });
      return saveOptions.onSuccess?.(...args);
    },
  });
  const [draft, setDraft] = useState(rule);
  const [prompt, setPrompt] = useState("");
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<WrittenRule | null>(null);
  const [problem, setProblem] = useState<Error | null>(null);
  const submitting = useRef(false);
  const recovery = useRef<HTMLElement>(null);
  const conflicted = problem instanceof ClientError && problem.status === 409;
  const {
    data: latest,
    error: refreshError,
    isPending: refreshing,
    mutateAsync: reloadPolicy,
    reset: resetRefresh,
  } = useMutation({
    mutationFn: readActionPolicy,
    onSuccess: (updated) => {
      if (
        updated.deny.includes(rule) &&
        ruleId(updated, rule) === ruleId(policy, rule)
      ) {
        queryClient.setQueryData(actionPolicyQueryOptions().queryKey, updated);
        setProblem(null);
      }
    },
  });
  const recoveryState = conflicted ? (latest ? "unavailable" : "reload") : null;

  useLayoutEffect(() => {
    if (recoveryState) recovery.current?.focus();
  }, [recoveryState]);

  const trimmed = draft.trim();
  const changed = trimmed !== rule;
  const hasDraft = draft !== rule || Boolean(prompt.trim());
  const promptChanged = written !== null && prompt.trim() !== written.text;
  const duplicate = changed && policy.deny.includes(trimmed);
  // The model's rule, unedited, that the compiler refused: its error is already under the rule.
  const broken = Boolean(
    written && !written.compile.ok && written.rule.trim() === trimmed,
  );
  const canCheck =
    changed &&
    Boolean(trimmed) &&
    !duplicate &&
    !broken &&
    !promptChanged &&
    !writing;

  const [settled, setSettled] = useState(rule);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const candidate: ActionPolicy | null =
    canCheck && settled === trimmed
      ? { mode: policy.mode, deny: [trimmed], allow: ["true"] }
      : null;
  const preview = useQuery({
    ...policyDryRunQueryOptions(
      candidate ?? { mode: "enforce", deny: [], allow: [] },
    ),
    enabled: candidate !== null,
  });
  const previewStatus =
    preview.error instanceof ClientError ? preview.error.status : null;
  const invalid = candidate !== null && previewStatus === 400;
  const checking =
    canCheck && (!candidate || preview.isPending || preview.isFetching);
  const ready =
    candidate !== null &&
    !checking &&
    (preview.isSuccess || previewStatus === 501) &&
    !conflicted;

  /* The model's rule goes into the CEL field, where the preview picks it up as it would any edit. */
  const takeWritten = (next: WrittenRule) => {
    setWritten(next);
    setDraft(next.rule);
  };

  const reset = () => {
    setDraft(rule);
    setPrompt("");
    setWritten(null);
    if (!conflicted) setProblem(null);
  };

  const save = () => {
    if (!ready || submitting.current) return;
    submitting.current = true;
    setProblem(null);
    savePolicy.mutate(
      {
        ...withRuleReplaced(policy, rule, trimmed),
        expected: policy,
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      {
        onError: (error) => {
          resetRefresh();
          setProblem(error);
        },
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <form
      className="mt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <PageCard
        footer={
          hasDraft ? (
            <>
              <Button
                disabled={writing || savePolicy.isPending}
                onClick={reset}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={!ready || savePolicy.isPending} type="submit">
                {savePolicy.isPending ? "Saving…" : "Save rule"}
              </Button>
            </>
          ) : undefined
        }
      >
        <FieldGroup>
          {recoveryState ? (
            <section
              aria-label="Boundary save conflict"
              ref={recovery}
              tabIndex={-1}
            >
              {recoveryState === "unavailable" ? (
                <Banner
                  description="Your draft is still in the Rule field. Copy it before returning to Boundaries to review the current policy."
                  role="alert"
                  status="error"
                  title="This rule was changed or removed."
                />
              ) : (
                <ReadError
                  description={
                    refreshError?.message ??
                    "Your draft is still here. Reload the policy before saving."
                  }
                  focusAfterRetry={() => ruleField.current}
                  message="The boundaries changed while you were editing."
                  retry={() => reloadPolicy().catch(() => undefined)}
                  retryBelow
                  retryLabel="Reload current boundaries"
                  retrying={refreshing}
                />
              )}
            </section>
          ) : null}
          <DescribeRule
            disabled={savePolicy.isPending}
            onTextChange={setPrompt}
            onWritingChange={setWriting}
            onWritten={takeWritten}
            text={prompt}
          />
          <Field>
            <FieldLabel htmlFor="rule-expression">Rule</FieldLabel>
            <RuleExpressionHelp />
            <Textarea
              aria-describedby={
                invalid || duplicate
                  ? `${RULE_EXPRESSION_HELP_ID} rule-validation-error`
                  : RULE_EXPRESSION_HELP_ID
              }
              aria-invalid={invalid || duplicate || undefined}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-h-20 font-mono text-sm"
              id="rule-expression"
              onChange={(event) => setDraft(event.target.value)}
              readOnly={writing || savePolicy.isPending}
              ref={ruleField}
              spellCheck={false}
              value={draft}
            />
            {duplicate || invalid ? (
              <Text
                as="p"
                className="text-destructive"
                id="rule-validation-error"
                role="alert"
                size="sm"
              >
                {duplicate
                  ? "This rule is already in place."
                  : preview.error?.message}
              </Text>
            ) : null}
            {promptChanged ? (
              <Text as="p" color="secondary" size="sm">
                Write the rule again to use your updated description.
              </Text>
            ) : written && !writing ? (
              <RuleReading rule={draft} written={written} />
            ) : null}
            <RuleReference />
          </Field>
          {checking ? (
            <ReadStatus kind="loading" message="Checking this rule…" />
          ) : candidate && previewStatus === 501 ? (
            <ReadStatus
              kind="loading"
              message="Rule checked. This deployment has no readable audit history to preview."
            />
          ) : candidate && preview.isError && !invalid ? (
            <ReadError
              description={preview.error.message}
              focusAfterRetry={() => ruleField.current}
              message="Couldn’t check this rule."
              retry={() => preview.refetch()}
              retryBelow
              retrying={preview.isFetching}
            />
          ) : candidate && preview.isSuccess ? (
            <RulePreview preview={preview} />
          ) : null}
        </FieldGroup>

        {/* A save refused for the reason the preview already gives says nothing twice. */}
        {problem &&
        !conflicted &&
        problem.message !== preview.error?.message ? (
          <p className="mt-5 text-destructive text-sm" role="alert">
            {problem.message}
          </p>
        ) : null}
      </PageCard>
      <DraftLeaveConfirmation
        hasDraft={hasDraft || writing}
        saving={savePolicy.isPending}
        submitting={submitting}
        title="Discard boundary draft?"
      />
    </form>
  );
}
