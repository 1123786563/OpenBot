import { IconChevronDown, IconShieldLock } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { GuidanceBacktestField } from "@/components/approvals/guidance-backtest";
import { GovernancePage } from "@/components/astryx-pilot/governance";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  backtestReviewerGuidance,
  checkReviewerGuidance,
  GUIDANCE_LIMIT,
  type GuidanceReading,
} from "@/lib/reviewer-guidance/check";
import {
  removeReviewerGuidanceMutationOptions,
  saveReviewerGuidanceMutationOptions,
} from "@/lib/reviewer-guidance/mutations";
import {
  guidanceBacktestPreviewQueryOptions,
  reviewerGuidanceQueryOptions,
} from "@/lib/reviewer-guidance/queries";

export const Route = createFileRoute("/_authed/admin/approvals_/guidance")({
  component: ReviewerGuidancePage,
});

const BACK = {
  label: "Approvals",
  linkProps: { to: "/admin/approvals" as const },
};

/**
 * Guidance for auto-review, in the admin's words, with the describe screen's pattern: write it, check
 * it, test it on recent decisions, then save it.
 *
 * Check hands the words to a call that sees nothing else, which says what they change and whether they
 * read as guidance at all. The replay costs one model call a request, so it runs only when the admin
 * presses for it, after being told how many. Save reads the words again on the server, and only
 * guidance that still reads as guidance is saved, on the trail, with the words.
 */
function ReviewerGuidancePage() {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const saved = useQuery(reviewerGuidanceQueryOptions());
  const preview = useQuery(guidanceBacktestPreviewQueryOptions());
  const save = useMutation(saveReviewerGuidanceMutationOptions(queryClient));
  const remove = useMutation(
    removeReviewerGuidanceMutationOptions(queryClient),
  );
  const check = useMutation({ mutationFn: checkReviewerGuidance });
  const backtest = useMutation({ mutationFn: backtestReviewerGuidance });
  /* Null until the admin types, so the saved guidance shows once it has loaded. */
  const [draft, setDraft] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const [checked, setChecked] = useState<{
    text: string;
    reading: GuidanceReading;
  } | null>(null);

  const text = (draft ?? saved.data ?? "").trim();
  const passed =
    checked !== null && checked.text === text && checked.reading.check.ok;
  const unchanged = text === (saved.data ?? "");
  const hasDraft = draft !== null && !unchanged;
  useBlocker({
    enableBeforeUnload: hasDraft,
    shouldBlockFn: ({ current, next }) =>
      hasDraft &&
      current.pathname !== next.pathname &&
      !window.confirm("Leave without saving your auto-review guidance?"),
  });
  const canWrite = saved.isSuccess && !remove.isPending;
  const ready =
    canWrite && passed && !unchanged && !check.isPending && !save.isPending;
  const back = () =>
    void navigate({ to: "/admin/approvals", ignoreBlocker: true });

  const runCheck = () => {
    if (!text || check.isPending || save.isPending) return;
    save.reset();
    setChecked(null);
    check.mutate(text, {
      onSuccess: (reading) => setChecked({ text, reading }),
    });
  };

  return (
    <GovernancePage
      backButton={BACK}
      description="Tell the reviewer what your organization needs a person for, or what is routine. It reads your guidance with every action it checks. Nothing changes until you save."
      title="Guidance for auto-review"
    >
      {confirmation}
      {saved.isError ? (
        <ReadError
          message="Couldn't load saved guidance."
          description={
            saved.data === undefined
              ? undefined
              : "Your draft will be here after you reload the saved guidance."
          }
          retry={saved.refetch}
          retrying={saved.isFetching}
        />
      ) : saved.isPending ? (
        <ReadStatus kind="loading" message="Loading saved guidance…" />
      ) : null}
      {saved.data !== undefined ? (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate(text, { onSuccess: back });
          }}
        >
          <PageCard
            footer={
              <>
                <Button
                  className="min-h-11"
                  render={(props) => <Link {...props} to="/admin/approvals" />}
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button className="min-h-11" disabled={!ready} type="submit">
                  {save.isPending ? "Saving…" : "Save guidance"}
                </Button>
              </>
            }
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="reviewer-guidance">Guidance</FieldLabel>
                <FieldDescription>
                  Write it the way you'd brief a colleague. A second reading
                  that sees only your words says what they change.
                </FieldDescription>
                <Textarea
                  disabled={save.isPending}
                  id="reviewer-guidance"
                  maxLength={GUIDANCE_LIMIT}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Anything that emails someone outside the company needs a person"
                  ref={editor}
                  rows={4}
                  value={draft ?? saved.data ?? ""}
                />
                <p className="text-muted-foreground text-sm">
                  Built-in safety always comes first.
                </p>
                <details className="group text-muted-foreground text-sm">
                  <summary className="flex min-h-11 cursor-pointer items-center gap-2 hover:text-foreground">
                    <IconShieldLock
                      aria-hidden="true"
                      className="size-4 shrink-0"
                    />
                    What built-in safety covers
                    <IconChevronDown
                      aria-hidden="true"
                      className="size-4 shrink-0 group-open:rotate-180"
                    />
                  </summary>
                  <p>
                    Deleting, sending, sharing, posting, paying and changing
                    account settings ask first. Members can allow each once, for
                    a conversation, or always, unless you set it to ask every
                    time. A person always changes passwords on websites
                    themselves.
                  </p>
                </details>
                <section
                  className="flex flex-wrap gap-2"
                  aria-label="Draft actions"
                >
                  <Button
                    className="min-h-11"
                    disabled={!text || check.isPending || save.isPending}
                    onClick={runCheck}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {check.isPending ? "Checking…" : "Check guidance"}
                  </Button>
                  {hasDraft ? (
                    <Button
                      className="min-h-11"
                      disabled={!canWrite || save.isPending}
                      onClick={(event) =>
                        requestConfirmation({
                          title: "Discard your guidance draft?",
                          description: saved.data
                            ? "This restores the last saved guidance and clears the draft’s check and test results."
                            : "This clears the editor and the draft’s check and test results.",
                          confirmLabel: saved.data
                            ? "Restore saved guidance"
                            : "Clear draft",
                          pendingLabel: "Discarding…",
                          failureMessage:
                            "Couldn't discard the draft. Try again.",
                          successMessage: saved.data
                            ? "Saved guidance restored."
                            : "Draft cleared.",
                          trigger: event.currentTarget,
                          fallbackFocus: () => editor.current,
                          run: async () => {
                            setDraft(null);
                            setChecked(null);
                            check.reset();
                            backtest.reset();
                            save.reset();
                          },
                        })
                      }
                      type="button"
                      variant="ghost"
                    >
                      {saved.data ? "Restore saved guidance" : "Clear draft"}
                    </Button>
                  ) : null}
                </section>
                {check.error ? (
                  <p className="text-destructive text-sm" role="alert">
                    {check.error.message}
                  </p>
                ) : null}
              </Field>
              {checked ? (
                <ReadingStatus
                  check={checked.reading.check}
                  edited={
                    checked.text !== text
                      ? "You've changed the guidance since it was checked. Check it again before you save."
                      : null
                  }
                  explanation={checked.reading.explanation}
                  failed="OpenBot won't save this."
                  heading="What this changes"
                  passed="Reads as guidance. Built-in safety still comes first."
                  warning={null}
                />
              ) : null}
              {passed && preview.isError ? (
                <ReadError
                  message="Couldn't load recent decisions for testing."
                  retry={preview.refetch}
                  retrying={preview.isFetching}
                />
              ) : passed && preview.isPending ? (
                <ReadStatus
                  kind="loading"
                  message="Loading recent decisions for testing…"
                />
              ) : passed ? (
                <GuidanceBacktestField
                  preview={preview.data}
                  run={backtest}
                  text={text}
                />
              ) : null}
            </FieldGroup>
            {save.error ? (
              <p className="mt-5 text-destructive text-sm" role="alert">
                {save.error.message}
              </p>
            ) : null}
          </PageCard>
        </form>
      ) : null}
      {saved.data ? (
        <PageSection
          description="The reviewer goes back to its own instructions from the next action it checks."
          title="Remove"
        >
          <Button
            className="mt-4 min-h-11"
            disabled={!canWrite || save.isPending}
            onClick={(event) => {
              requestConfirmation({
                title: "Remove the guidance?",
                description: hasDraft
                  ? "The reviewer goes back to its own instructions. Your unsaved guidance draft is also discarded."
                  : "The reviewer goes back to its own instructions from the next action it checks.",
                confirmLabel: "Remove guidance",
                pendingLabel: "Removing…",
                failureMessage: "Couldn't remove the guidance. Try again.",
                trigger: event.currentTarget,
                refresh: saved.refetch,
                run: async () => {
                  const latest = queryClient.getQueryState(
                    reviewerGuidanceQueryOptions().queryKey,
                  );
                  if (
                    latest?.status !== "success" ||
                    latest.data !== saved.data
                  )
                    throw new ActionUnavailable(
                      "The saved guidance changed. Close this dialog and review it before removing it.",
                    );
                  await remove.mutateAsync();
                  back();
                },
              });
            }}
            variant="destructive"
          >
            Remove guidance
          </Button>
        </PageSection>
      ) : null}
    </GovernancePage>
  );
}
