import { HStack } from "@astryxdesign/core/Stack";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import {
  RuleRowsEditor,
  RulesBacktest,
} from "@/components/approvals/describe-rules";
import { GovernancePage } from "@/components/astryx-pilot/governance";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard } from "@/components/layout/page-shell";
import { ReadStatus } from "@/components/layout/read-status";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { saveTeamRulesMutationOptions } from "@/lib/approval-rules/mutations";
import { approvalRulesBacktestQueryOptions } from "@/lib/approval-rules/queries";
import {
  type ApprovalRuleTranslation,
  translateApprovalRules,
} from "@/lib/approval-rules/translate";
import type { ApprovalRuleInput } from "@/lib/approvals";
import { newId } from "@/lib/new-id";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/approvals_/describe")({
  component: DescribeTeamRulesPage,
});

const BACK = {
  label: "Approvals",
  linkProps: { to: "/admin/approvals" as const },
};

/** How long the rules rest before they are replayed, so typing is not a request per keystroke. */
const PREVIEW_DELAY_MS = 400;

/** What came back for one description, kept beside the words it came from. */
type WrittenRules = ApprovalRuleTranslation & { text: string };

const same = (
  a: readonly ApprovalRuleInput[],
  b: readonly ApprovalRuleInput[],
) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Team approval rules described in words, as a boundary is on Add rule.
 *
 * The model's rules land as fields the admin can change, beside an independent reading of them and
 * whether they check. What they would have changed is replayed over the approval gate's own history
 * as they are edited: the asks they would remove, and which of those a person had denied, and the
 * asks they would add. Only Save adds them, with the sentence they were written from.
 */
function DescribeTeamRulesPage() {
  const navigate = Route.useNavigate();
  const save = useMutation(saveTeamRulesMutationOptions(queryClient));
  const [written, setWritten] = useState<WrittenRules | null>(null);
  const [rules, setRules] = useState<ApprovalRuleInput[]>([]);
  /* The last removed rule, so one removal is one step from undone. */
  const [removed, setRemoved] = useState<{
    index: number;
    rule: ApprovalRuleInput;
  } | null>(null);
  const [description, setDescription] = useState("");
  const [writing, setWriting] = useState(false);
  const submitting = useRef(false);
  const saveRequests = useRef(new Map<string, string>());
  const form = useRef<HTMLFormElement>(null);
  const backtest = useRef<HTMLElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const restoredRow = useRef<number | null>(null);
  const hasDraft = description.trim() !== "" || written !== null;
  const descriptionChanged =
    written !== null && written.text !== description.trim();
  const showDraft = written !== null && !descriptionChanged && !writing;

  useLayoutEffect(() => {
    if (removed) undo.current?.focus();
    if (restoredRow.current !== null) {
      form.current
        ?.querySelector<HTMLButtonElement>(
          `[data-approval-rule="${restoredRow.current}"] button[aria-expanded]`,
        )
        ?.focus();
      restoredRow.current = null;
    }
  }, [removed]);

  /* The rules as they stood a moment ago, debounced as Add rule's preview is. */
  const [settled, setSettled] = useState<ApprovalRuleInput[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(rules), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rules]);

  const settling = !same(settled, rules);
  const preview = useQuery({
    ...approvalRulesBacktestQueryOptions(settled),
    enabled: showDraft && !settling && settled.length > 0,
  });
  const current =
    preview.isSuccess && preview.fetchStatus === "idle" && !settling
      ? preview.data
      : null;
  const ready =
    written !== null &&
    !descriptionChanged &&
    !writing &&
    !save.isPending &&
    Boolean(current?.check.ok) &&
    rules.length > 0;
  const edited = written !== null && !same(rules, written.rules);

  const add = () => {
    if (!ready || !written || submitting.current) return;
    const draft = JSON.stringify([rules, written.text]);
    const requestId = saveRequests.current.get(draft) ?? newId();
    saveRequests.current.set(draft, requestId);
    submitting.current = true;
    save.mutate(
      {
        rules,
        authoring: { source: "english", text: written.text },
        requestId,
      },
      {
        onSuccess: () =>
          void navigate({ to: "/admin/approvals", ignoreBlocker: true }),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <GovernancePage
      backButton={BACK}
      description="Say what Bots should do before an action, and your model writes the team rules. Nothing changes until you save them."
      title="Describe team rules"
    >
      <form
        noValidate
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                className="min-h-12"
                disabled={save.isPending}
                render={(props) => <Link {...props} to="/admin/approvals" />}
                variant="outline"
              >
                Cancel
              </Button>
              <Button className="min-h-12" disabled={!ready} type="submit">
                {save.isPending ? "Saving…" : "Save rules"}
              </Button>
            </>
          }
        >
          <FieldGroup>
            <DescribeField
              action="Write rules"
              disabled={save.isPending}
              description="Name the Bot or app, the action, and what should happen before it runs. You’ll review the proposed rules and test them against recent activity."
              example="Ask before any Bot sends email from Gmail."
              id="team-rules-english"
              label="Describe the rules"
              onTextChange={(text) => {
                if (save.isError) save.reset();
                setDescription(text);
              }}
              onWritingChange={setWriting}
              text={description}
              write={async (described) => {
                const translation = await translateApprovalRules(described);
                save.reset();
                setWritten({ ...translation, text: described });
                setRules(translation.rules);
                setRemoved(null);
                return null;
              }}
            />
            {descriptionChanged && !writing ? (
              <ReadStatus
                kind="loading"
                message="Your description changed. Choose Write rules to update the draft before saving."
              />
            ) : null}
            {showDraft && !edited ? (
              <ReadingStatus
                check={written.check}
                edited={null}
                explanation={written.explanation}
                failed={
                  // No rules says so itself, with the model's reason.
                  written.rules.length === 0
                    ? ""
                    : "These rules don't check, so OpenBot won't save them."
                }
                heading="What these rules do"
                passed="Checks. Every rule matches tools and Bots this OpenBot has."
                warning={current ? null : written.warning}
              />
            ) : null}
            {showDraft && edited && !removed && rules.length > 0 ? (
              <ReadStatus
                kind="loading"
                message="Rule edited. Review the updated preview before saving."
              />
            ) : null}
            {showDraft && rules.length > 0 ? (
              <Button
                className="min-h-12 self-start"
                onClick={() => backtest.current?.focus()}
                type="button"
                variant="outline"
              >
                Review recent activity
              </Button>
            ) : null}
            {showDraft && rules.length > 0 ? (
              <FieldSet
                disabled={writing || save.isPending || descriptionChanged}
              >
                <RuleRowsEditor
                  onChange={(next) => {
                    if (save.isError) save.reset();
                    setRemoved(null);
                    setRules(next);
                  }}
                  onRemove={(index, rule) => {
                    if (save.isError) save.reset();
                    setRemoved({ index, rule });
                    setRules(rules.filter((_, at) => at !== index));
                  }}
                  problems={
                    current && !current.check.ok ? current.check.problems : []
                  }
                  rules={rules}
                />
              </FieldSet>
            ) : null}
            {showDraft && removed ? (
              <HStack gap={3} vAlign="center" wrap="wrap">
                <p className="text-muted-foreground text-sm" role="status">
                  {rules.length > 0
                    ? "Rule removed. Review the updated preview before saving."
                    : "There are no rules to save. Undo the last removal or write rules again."}
                </p>
                <Button
                  className="min-h-12"
                  disabled={writing || save.isPending || descriptionChanged}
                  onClick={() => {
                    if (save.isError) save.reset();
                    restoredRow.current = removed.index + 1;
                    setRules([
                      ...rules.slice(0, removed.index),
                      removed.rule,
                      ...rules.slice(removed.index),
                    ]);
                    setRemoved(null);
                  }}
                  size="sm"
                  ref={undo}
                  type="button"
                  variant="outline"
                >
                  Undo
                </Button>
              </HStack>
            ) : null}
            {showDraft &&
            current &&
            !current.check.ok &&
            current.check.problems.length === 0 ? (
              <p className="text-destructive text-sm">{current.check.error}</p>
            ) : null}
            {showDraft && rules.length > 0 ? (
              <section
                aria-label="Rule preview"
                className="scroll-mt-4 rounded-lg"
                ref={backtest}
                tabIndex={-1}
              >
                <RulesBacktest
                  asksMore={rules.some((rule) => rule.behaviour !== "allow")}
                  preview={preview}
                  settling={settling}
                />
              </section>
            ) : null}
          </FieldGroup>
          {save.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {save.error instanceof TypeError
                ? "Couldn't confirm the save. Choose Save rules again to check the same draft."
                : save.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
      <DraftLeaveConfirmation
        hasDraft={hasDraft}
        saving={save.isPending}
        submitting={submitting}
        title="Discard approval rules?"
      />
    </GovernancePage>
  );
}
