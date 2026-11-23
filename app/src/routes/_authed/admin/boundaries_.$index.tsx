import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  DescribeRule,
  type WrittenRule,
} from "@/components/boundaries/describe-rule";
import { DryRunChanges } from "@/components/boundaries/dry-run-changes";
import { RulePreview } from "@/components/boundaries/rule-preview";
import { RuleReading } from "@/components/boundaries/rule-reading";
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
import {
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
} from "@/lib/computers/queries";

/** How long the rule has to rest before it is replayed, as on Add rule. */
const PREVIEW_DELAY_MS = 400;

export const Route = createFileRoute("/_authed/admin/boundaries_/$index")({
  component: RulePage,
});

const BACK = {
  label: "Boundaries",
  linkProps: { to: "/admin/boundaries" as const },
};

/**
 * One rule: what it is called, what it is made of, and what it has stopped lately.
 *
 * Addressed by position because a rule has no id of its own, only its text. A position that no
 * longer holds a rule, because it was removed elsewhere, says so rather than showing a neighbour.
 */
function RulePage() {
  const { index } = Route.useParams();
  const stored = useQuery(actionPolicyQueryOptions());
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const denied =
    stored.error instanceof ClientError &&
    (stored.error.status === 401 || stored.error.status === 403);
  const policy = denied ? undefined : stored.data;
  const rule = policy?.deny[Number(index)];

  if (!policy) {
    return (
      <PageShell backButton={BACK} title="Rule">
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
      <PageShell backButton={BACK} title="Rule">
        {confirmation}
        <p className="text-muted-foreground text-sm">
          This rule isn't in place anymore. It may have been removed.
        </p>
      </PageShell>
    );
  }
  // Keyed by the rule, so a saved change starts the editor and its preview afresh from what is stored.
  return (
    <>
      {confirmation}
      <RuleDetail
        key={rule}
        policy={policy}
        rule={rule}
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
              await navigate({ to: "/admin/boundaries" });
            },
          });
        }}
      />
    </>
  );
}

function RuleDetail({
  policy,
  rule,
  onRemove,
}: {
  policy: ActionPolicy;
  rule: string;
  onRemove: (trigger: HTMLElement) => void;
}) {
  const label = ruleLabel(policy, rule);

  // Replay the current policy without this rule against recorded decisions, including trial refusals.
  const reach = useQuery(policyDryRunQueryOptions(withoutRule(policy, rule)));

  return (
    <PageShell
      backButton={BACK}
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
        description="Written in CEL. It is checked before every action a Bot takes."
        title="Rule"
      >
        <RuleEditor policy={policy} rule={rule} />
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
            <DryRunChanges
              changes={reach.data.changes.filter(
                (change) => change.would === "allowed",
              )}
              total={reach.data.wouldAllow}
              verdict="Would allow"
              verdictClassName="text-foreground"
            />
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
function RuleEditor({ policy, rule }: { policy: ActionPolicy; rule: string }) {
  const queryClient = useQueryClient();
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [draft, setDraft] = useState(rule);
  const [written, setWritten] = useState<WrittenRule | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const trimmed = draft.trim();
  const changed = trimmed !== rule;
  const duplicate = changed && policy.deny.includes(trimmed);
  // The model's rule, unedited, that the compiler refused: its error is already under the rule.
  const broken = Boolean(
    written && !written.compile.ok && written.rule.trim() === trimmed,
  );
  const ready = changed && Boolean(trimmed) && !duplicate && !broken;

  const [settled, setSettled] = useState(rule);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);
  const candidate: ActionPolicy | null =
    settled && settled !== rule && !policy.deny.includes(settled) && !broken
      ? { mode: policy.mode, deny: [settled], allow: ["true"] }
      : null;
  const preview = useQuery({
    ...policyDryRunQueryOptions(
      candidate ?? { mode: "enforce", deny: [], allow: [] },
    ),
    enabled: candidate !== null,
    placeholderData: keepPreviousData,
  });

  /* The model's rule goes into the CEL field, where the preview picks it up as it would any edit. */
  const takeWritten = (next: WrittenRule) => {
    setWritten(next);
    setDraft(next.rule);
  };

  const reset = () => {
    setDraft(rule);
    setWritten(null);
    setProblem(null);
  };

  const save = () => {
    if (!ready) return;
    setProblem(null);
    savePolicy.mutate(
      {
        ...withRuleReplaced(policy, rule, trimmed),
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      { onError: (thrown: Error) => setProblem(thrown.message) },
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
          changed ? (
            <>
              <Button onClick={reset} type="button" variant="outline">
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
          <DescribeRule onWritten={takeWritten} />
          <Field>
            <FieldLabel htmlFor="rule-expression">Rule</FieldLabel>
            <Textarea
              autoCapitalize="off"
              autoCorrect="off"
              className="min-h-20 font-mono text-xs"
              id="rule-expression"
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              value={draft}
            />
            {duplicate ? (
              <p className="text-destructive text-sm">
                This rule is already in place.
              </p>
            ) : null}
            {written ? <RuleReading rule={draft} written={written} /> : null}
          </Field>
          {changed && candidate && !duplicate ? (
            <RulePreview preview={preview} />
          ) : null}
        </FieldGroup>

        {/* A save refused for the reason the preview already gives says nothing twice. */}
        {problem && problem !== preview.error?.message ? (
          <p className="mt-5 text-destructive text-sm" role="alert">
            {problem}
          </p>
        ) : null}
      </PageCard>
    </form>
  );
}
