import { Text } from "@astryxdesign/core/Text";
import {
  IconCheck,
  IconCode,
  IconShieldX,
  IconSparkles,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { GovernancePage } from "@/components/astryx-pilot/governance";
import {
  DescribeRule,
  type WrittenRule,
} from "@/components/boundaries/describe-rule";
import { RulePreview } from "@/components/boundaries/rule-preview";
import { RuleReading } from "@/components/boundaries/rule-reading";
import {
  RULE_EXPRESSION_HELP_ID,
  RuleExpressionHelp,
  RuleReference,
} from "@/components/boundaries/rule-reference";
import {
  PageCard,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
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
import { Textarea } from "@/components/ui/textarea";
import { RULE_TEMPLATES, type RuleTemplate } from "@/lib/boundaries/rules";
import { ClientError } from "@/lib/client";
import { isComposing } from "@/lib/composing";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import {
  type ActionPolicy,
  actionPolicyQueryOptions,
  policyDryRunQueryOptions,
} from "@/lib/computers/queries";
import { newId } from "@/lib/new-id";

export const Route = createFileRoute("/_authed/admin/boundaries_/new")({
  component: NewRulePage,
});

const BACK = {
  label: "Boundaries",
  linkProps: { to: "/admin/boundaries" as const },
};

/** How long the rule has to rest before it is replayed, so typing it is not a request per keystroke. */
const PREVIEW_DELAY_MS = 400;

type Start = RuleTemplate | "describe" | "custom";

type Draft = {
  name: string;
  description: string;
  rule: string;
  prompt: string;
  written: WrittenRule | null;
  filled: { name: string; description: string };
};

function startDraft(start: Start | null): Draft {
  const template = start && typeof start !== "string" ? start : null;
  return {
    name: template?.name ?? "",
    description: template?.description ?? "",
    rule: template?.rule ?? "",
    prompt: "",
    written: null,
    filled: { name: "", description: "" },
  };
}

/**
 * Adding a rule: describe it, pick a template or write one, see what it would have stopped, then
 * add it.
 *
 * A template fills the form rather than adding itself, so its name, its cost and the rule it is
 * made of are all read before it applies to every Bot. A description does the same: the model's rule
 * lands in the CEL field beside an independent reading of it, and only Add rule saves it. What the
 * rule would have stopped is worked out as it is written, over a Bot's computer actions and its app
 * calls alike, so its reach is on screen before Add rule rather than behind a button somebody may
 * never press.
 */
function NewRulePage() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const [chosen, setChosen] = useState<Start | null>(null);
  const [showStarters, setShowStarters] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<string, Draft>>>({});
  const [problem, setProblem] = useState<Error | null>(null);
  const [writing, setWriting] = useState(false);
  const submitting = useRef(false);
  const ruleHeading = useRef<HTMLHeadingElement>(null);
  const starterHeading = useRef<HTMLHeadingElement>(null);
  const policyRecovery = useRef<HTMLElement>(null);
  const hasDraft = Object.entries(drafts).some(([id, value]) => {
    if (!value) return false;
    const original = startDraft(
      RULE_TEMPLATES.find((template) => template.rule === id) ?? null,
    );
    return Boolean(
      value.written ||
        value.prompt.trim() ||
        value.rule !== original.rule ||
        value.name !== original.name ||
        value.description !== original.description,
    );
  });
  useLayoutEffect(() => {
    if (showStarters) starterHeading.current?.focus();
    else if (chosen) ruleHeading.current?.focus();
  }, [chosen, showStarters]);

  const key = typeof chosen === "string" ? chosen : chosen?.rule;
  const draft = (key && drafts[key]) || startDraft(chosen);
  const { name, description, rule, prompt, written } = draft;
  const updateDraft = (update: (current: Draft) => Partial<Draft>) => {
    if (!key) return;
    if (problem && !needsPolicyRefresh) setProblem(null);
    setDrafts((previous) => {
      const current = previous[key] ?? startDraft(chosen);
      return { ...previous, [key]: { ...current, ...update(current) } };
    });
  };

  const policy = stored.data;
  const trimmed = rule.trim();
  const duplicate = Boolean(policy?.deny.includes(trimmed));
  const promptChanged = written !== null && prompt.trim() !== written.text;
  /*
   * The model's rule, unedited, that the compiler refused. Its error is already under the rule, from
   * the writing, so it is neither replayed nor offered to Add rule.
   */
  const broken = Boolean(
    written && !written.compile.ok && written.rule.trim() === trimmed,
  );
  /*
   * The rule as it stood a moment ago, debounced as People's search is. A template's rule arrives
   * whole, and is replayed as soon as it rests.
   */
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  /*
   * This rule on its own, with everything else allowed, replayed over recent recorded actions.
   * Nothing is saved. Every action it would refuse that went through is one this rule would have
   * stopped, and nothing else is.
   *
   * Not the policy in force plus this rule. Replayed against what happened, that also refuses every
   * action a rule added since then stops, and they were listed here as this rule's: a rule about
   * password fields "would have stopped" the Salesforce writes the rule before it now stops. The
   * labels are left out too: nothing evaluates them, and a renamed rule needs no new answer.
   */
  const canPreview = Boolean(
    policy && trimmed && !duplicate && !broken && !promptChanged && !writing,
  );
  const candidate: ActionPolicy | null =
    policy && canPreview && settled === trimmed
      ? { mode: policy.mode, deny: [settled], allow: ["true"] }
      : null;
  const preview = useQuery({
    ...policyDryRunQueryOptions(
      candidate ?? { mode: "enforce", deny: [], allow: [] },
    ),
    enabled: candidate !== null,
  });
  const previewStatus =
    preview.error instanceof ClientError ? preview.error.status : null;
  const needsPolicyRefresh =
    problem instanceof ClientError && problem.status === 409;
  useLayoutEffect(() => {
    if (needsPolicyRefresh) policyRecovery.current?.focus();
  }, [needsPolicyRefresh]);
  const ready = Boolean(
    candidate &&
      name.trim() &&
      stored.isSuccess &&
      !preview.isPending &&
      !preview.isFetching &&
      (preview.isSuccess || previewStatus === 501) &&
      !needsPolicyRefresh,
  );

  const reloadPolicy = async () => {
    const result = await stored.refetch();
    if (result.isSuccess) setProblem(null);
  };

  const choose = (next: Start) => {
    setShowStarters(false);
    setChosen(next);
    if (!needsPolicyRefresh) setProblem(null);
  };

  /* The model's rule goes into the CEL field, where the preview picks it up as it would any rule. */
  const takeWritten = (next: WrittenRule) => {
    updateDraft((current) => {
      const ours = (value: string, last: string) =>
        !value.trim() || value === last;
      const nextName = next.text.slice(0, 80);
      const nextDescription = next.summary?.slice(0, 300) ?? "";
      const takeName = ours(current.name, current.filled.name);
      const takeDescription =
        Boolean(nextDescription) &&
        ours(current.description, current.filled.description);
      return {
        written: next,
        rule: next.rule,
        name: takeName ? nextName : current.name,
        description: takeDescription ? nextDescription : current.description,
        filled: {
          name: takeName ? nextName : current.filled.name,
          description: takeDescription
            ? nextDescription
            : current.filled.description,
        },
      };
    });
  };

  const add = () => {
    if (!policy || !ready || submitting.current) return;
    submitting.current = true;
    setProblem(null);
    savePolicy.mutate(
      {
        ...policy,
        expected: policy,
        deny: [...policy.deny, trimmed],
        labels: {
          ...policy.labels,
          [trimmed]: {
            name: name.trim(),
            description: description.trim(),
            id: `r-${newId()}`,
          },
        },
        ...(written
          ? { authoring: { source: "english" as const, text: written.text } }
          : {}),
      },
      {
        onError: setProblem,
        onSuccess: () =>
          void navigate({ to: "/admin/boundaries", ignoreBlocker: true }),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  const options: { key: string; value: Start }[] = [
    { key: "describe", value: "describe" },
    ...RULE_TEMPLATES.map((template) => ({
      key: template.rule,
      value: template,
    })),
    { key: "custom", value: "custom" },
  ];

  const starters = (
    <PageSection
      className={chosen && !showStarters ? "hidden" : undefined}
      headingRef={starterHeading}
      id="boundary-starters"
      title="Start from"
    >
      <PageRows>
        {options.map((option, index) => {
          const custom = option.value === "custom";
          const describe = option.value === "describe";
          const template =
            custom || describe ? null : (option.value as RuleTemplate);
          const selected = chosen === option.value;
          const taken = template
            ? policy?.deny.includes(template.rule) && !drafts[option.key]
            : false;
          return (
            <Fragment key={option.key}>
              <Item
                aria-pressed={selected}
                render={
                  <button
                    disabled={taken || writing || savePolicy.isPending}
                    type="button"
                  />
                }
                onClick={() => choose(option.value)}
                size="sm"
              >
                <ItemMedia variant="icon">
                  {describe ? (
                    <IconSparkles />
                  ) : custom ? (
                    <IconCode />
                  ) : (
                    <IconShieldX />
                  )}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {template
                      ? template.name
                      : describe
                        ? "Describe it in words"
                        : "Write your own"}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    {template
                      ? taken
                        ? "Already one of your rules."
                        : template.description
                      : describe
                        ? "Say what no Bot may do, and your model writes the rule."
                        : "Describe the action yourself, in CEL."}
                  </ItemDescription>
                  {template && !taken ? (
                    <ItemDescription className="line-clamp-none text-sm">
                      {template.cost}
                    </ItemDescription>
                  ) : null}
                </ItemContent>
                {selected ? (
                  <ItemActions>
                    <IconCheck aria-hidden className="size-4" />
                  </ItemActions>
                ) : null}
              </Item>
              {index !== options.length - 1 && <Separator />}
            </Fragment>
          );
        })}
      </PageRows>
    </PageSection>
  );

  return (
    <GovernancePage
      backButton={BACK}
      description="Define an action that no Bot may take. This boundary applies to every Bot’s next action."
      title="Add rule"
    >
      {stored.isError || needsPolicyRefresh ? (
        <section
          aria-label="Boundary status"
          ref={policyRecovery}
          tabIndex={-1}
        >
          <ReadError
            description={stored.error?.message ?? problem?.message}
            focusAfterRetry={() =>
              ruleHeading.current ?? starterHeading.current
            }
            message="Reload the current boundaries before adding your rule."
            retry={reloadPolicy}
            retryBelow
            retrying={stored.isFetching}
          />
        </section>
      ) : stored.isPending ? (
        <ReadStatus kind="loading" message="Loading current boundaries…" />
      ) : null}
      {chosen ? null : starters}

      {chosen ? (
        <PageSection
          headingRef={ruleHeading}
          description={
            chosen === "describe"
              ? "From a description"
              : chosen === "custom"
                ? "Written in CEL"
                : `From the “${chosen.name}” template`
          }
          title="The rule"
          action={
            <Button
              aria-controls="boundary-starters"
              aria-expanded={showStarters}
              className="min-h-12"
              onClick={() => {
                if (showStarters) starterHeading.current?.focus();
                else setShowStarters(true);
              }}
              type="button"
              variant="outline"
            >
              Change starting point
            </Button>
          }
        >
          <form
            className="mt-4"
            noValidate
            onKeyDown={(event) => {
              // Nothing submits on Enter any more, but the Enter that confirms a composed
              // character is still stopped: no half-typed name may ever reach a submit path.
              if (event.key === "Enter" && isComposing(event))
                event.preventDefault();
            }}
            onSubmit={(event) => event.preventDefault()}
          >
            <PageCard
              footer={
                <>
                  <Button
                    className="min-h-12"
                    disabled={savePolicy.isPending}
                    render={(props) => (
                      <Link {...props} to="/admin/boundaries" />
                    )}
                    variant="outline"
                  >
                    Cancel
                  </Button>
                  <Button
                    className="min-h-12"
                    disabled={!ready || savePolicy.isPending}
                    onClick={add}
                    type="button"
                  >
                    {savePolicy.isPending ? "Adding…" : "Add rule"}
                  </Button>
                </>
              }
            >
              <FieldGroup>
                {chosen === "describe" ? (
                  <DescribeRule
                    disabled={savePolicy.isPending}
                    onTextChange={(prompt) => updateDraft(() => ({ prompt }))}
                    onWritten={takeWritten}
                    onWritingChange={setWriting}
                    text={prompt}
                  />
                ) : null}
                {promptChanged ? (
                  <Text as="p" color="secondary" role="status" size="sm">
                    Your description changed. Choose Write rule to update the
                    draft before adding it.
                  </Text>
                ) : null}
                {promptChanged ? null : (
                  <>
                    <Field>
                      <FieldLabel htmlFor="rule-name">Name</FieldLabel>
                      <Input
                        className="min-h-12"
                        id="rule-name"
                        readOnly={savePolicy.isPending}
                        maxLength={80}
                        onChange={(event) => {
                          const name = event.target.value;
                          updateDraft(() => ({ name }));
                        }}
                        placeholder="Never delete files"
                        value={name}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="rule-description">
                        What it stops
                      </FieldLabel>
                      <FieldDescription>
                        One sentence, shown under the name in the list.
                      </FieldDescription>
                      <Input
                        className="min-h-12"
                        id="rule-description"
                        readOnly={savePolicy.isPending}
                        maxLength={300}
                        onChange={(event) => {
                          const description = event.target.value;
                          updateDraft(() => ({ description }));
                        }}
                        value={description}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="rule-expression">Rule</FieldLabel>
                      <RuleExpressionHelp />
                      <Textarea
                        aria-describedby={
                          candidate && previewStatus === 400
                            ? `${RULE_EXPRESSION_HELP_ID} rule-validation-error`
                            : RULE_EXPRESSION_HELP_ID
                        }
                        aria-invalid={
                          duplicate ||
                          broken ||
                          (candidate && previewStatus === 400)
                            ? true
                            : undefined
                        }
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="min-h-20 font-mono text-sm"
                        id="rule-expression"
                        onChange={(event) => {
                          const rule = event.target.value;
                          updateDraft(() => ({ rule }));
                        }}
                        readOnly={writing || savePolicy.isPending}
                        spellCheck={false}
                        value={rule}
                      />
                      {duplicate ? (
                        <p className="text-destructive text-sm">
                          This rule is already in place.
                        </p>
                      ) : null}
                      {chosen !== "custom" && chosen !== "describe" ? (
                        <p className="text-amber-600 text-sm dark:text-amber-500">
                          {chosen.cost}
                        </p>
                      ) : null}
                      {written && !promptChanged && !writing ? (
                        <RuleReading rule={rule} written={written} />
                      ) : null}
                      {candidate && previewStatus === 400 ? (
                        <Text
                          as="p"
                          className="text-destructive"
                          id="rule-validation-error"
                          role="alert"
                          size="sm"
                        >
                          {preview.error?.message}
                        </Text>
                      ) : null}
                      <RuleReference />
                    </Field>
                    {canPreview && !stored.isError ? (
                      !candidate ||
                      preview.isPending ||
                      (preview.isFetching && !preview.error) ? (
                        <Text as="p" color="secondary" role="status" size="sm">
                          Checking this rule…
                        </Text>
                      ) : previewStatus === 501 ? (
                        <Text as="p" color="secondary" role="status" size="sm">
                          Rule checked. This deployment has no readable audit
                          history to preview.
                        </Text>
                      ) : preview.isError && previewStatus !== 400 ? (
                        <ReadError
                          description={preview.error.message}
                          message="Couldn’t check this rule."
                          retry={() => preview.refetch()}
                          retryBelow
                          retrying={preview.isFetching}
                        />
                      ) : preview.isSuccess ? (
                        <RulePreview preview={preview} />
                      ) : null
                    ) : null}
                  </>
                )}
              </FieldGroup>

              {problem && !needsPolicyRefresh ? (
                <p className="mt-5 text-destructive text-sm" role="alert">
                  {problem.message} Your draft is still here. Try adding the
                  rule again.
                </p>
              ) : null}
            </PageCard>
          </form>
        </PageSection>
      ) : null}
      {chosen ? starters : null}
      <DraftLeaveConfirmation
        hasDraft={hasDraft}
        saving={savePolicy.isPending}
        submitting={submitting}
        title="Discard boundary draft?"
      />
    </GovernancePage>
  );
}
