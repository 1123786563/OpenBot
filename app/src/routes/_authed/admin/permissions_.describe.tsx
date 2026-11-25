import { HStack } from "@astryxdesign/core/Stack";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import {
  ChangeRows,
  PermissionsPreview,
} from "@/components/admin/controls/describe-capabilities";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { GovernancePage } from "@/components/astryx-pilot/governance";
import { DescribeField } from "@/components/boundaries/describe-rule";
import { ReadingStatus } from "@/components/boundaries/rule-reading";
import { PageCard } from "@/components/layout/page-shell";
import { ReadStatus } from "@/components/layout/read-status";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { saveCapabilityChangesMutationOptions } from "@/lib/capability-changes/mutations";
import { capabilityChangesPreviewQueryOptions } from "@/lib/capability-changes/queries";
import {
  type CapabilityChange,
  type CapabilityTranslation,
  translateCapabilityChanges,
} from "@/lib/capability-changes/translate";
import { enterpriseOverviewQueryOptions } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/permissions_/describe")({
  component: DescribePermissionsPage,
});

const BACK = {
  label: "Permissions",
  linkProps: { to: "/admin/permissions" as const },
};

/** What came back for one description, kept beside the words it came from. */
type WrittenChanges = CapabilityTranslation & { text: string };

const same = (a: readonly CapabilityChange[], b: readonly CapabilityChange[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Who can do what, described in words, as team approval rules are on Describe team rules.
 *
 * The model's switch changes land as rows the admin can remove, beside an independent reading of them
 * and whether they check. Who they would change is worked out on the server for every member, with
 * the recent use of what anybody would lose. Only Save writes them, together, with the sentence they
 * were written from.
 */
function DescribePermissionsPage() {
  const navigate = Route.useNavigate();
  const save = useMutation(saveCapabilityChangesMutationOptions(queryClient));
  const overview = useQuery(enterpriseOverviewQueryOptions());
  const [written, setWritten] = useState<WrittenChanges | null>(null);
  const [changes, setChanges] = useState<CapabilityChange[]>([]);
  /* The last removed change, so one Remove is one step from undone. */
  const [removed, setRemoved] = useState<{
    index: number;
    change: CapabilityChange;
  } | null>(null);
  const [description, setDescription] = useState("");
  const [writing, setWriting] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const impact = useRef<HTMLElement>(null);
  const undo = useRef<HTMLButtonElement>(null);
  const restoredRow = useRef<number | null>(null);
  const submitting = useRef(false);
  const hasDraft = description.trim() !== "" || written !== null;
  const descriptionChanged =
    written !== null && written.text !== description.trim();
  const showDraft = written !== null && !descriptionChanged && !writing;

  useLayoutEffect(() => {
    if (removed) undo.current?.focus();
    if (restoredRow.current !== null) {
      form.current
        ?.querySelector<HTMLButtonElement>(
          `[data-permission-change="${restoredRow.current}"]`,
        )
        ?.focus();
      restoredRow.current = null;
    }
  }, [removed]);

  const preview = useQuery({
    ...capabilityChangesPreviewQueryOptions(changes),
    enabled: showDraft && changes.length > 0,
  });
  const current =
    preview.isSuccess && preview.fetchStatus === "idle" ? preview.data : null;
  const ready =
    written !== null &&
    !descriptionChanged &&
    !writing &&
    !save.isPending &&
    Boolean(current?.check.ok) &&
    changes.length > 0;
  const edited = written !== null && !same(changes, written.changes);
  const titles = Object.fromEntries(
    (overview.data?.capabilities ?? []).map((capability) => [
      capability.capability,
      capability.title,
    ]),
  );

  const saveChanges = () => {
    if (!ready || !written || submitting.current) return;
    submitting.current = true;
    save.mutate(
      {
        changes,
        // What the impact above was worked out from. The server refuses the save if another admin
        // has changed a switch since, and the draft stays here beside the newest impact.
        basedOn: current?.basedOn,
        authoring: { source: "english", text: written.text },
      },
      {
        onSuccess: () =>
          void navigate({ to: "/admin/permissions", ignoreBlocker: true }),
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };

  return (
    <GovernancePage
      backButton={BACK}
      description="Say who may use what, and your model writes the permission changes. Nothing changes until you save them."
      title="Describe who can do what"
    >
      <form
        noValidate
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          saveChanges();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                className="min-h-12"
                disabled={save.isPending}
                render={(props) => <Link {...props} to="/admin/permissions" />}
                variant="outline"
              >
                Cancel
              </Button>
              <Button className="min-h-12" disabled={!ready} type="submit">
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <FieldGroup>
            <DescribeField
              action="Write changes"
              disabled={save.isPending}
              description="Describe what everyone, a role, or a group should be allowed or blocked from doing. You’ll review the proposed changes and who they affect."
              id="permissions-english"
              example="Contractors can't use their own computer."
              label="Describe the change"
              onTextChange={(text) => {
                if (save.isError) save.reset();
                setDescription(text);
              }}
              onWritingChange={setWriting}
              text={description}
              write={async (described) => {
                const translation = await translateCapabilityChanges(described);
                save.reset();
                setWritten({ ...translation, text: described });
                setChanges(translation.changes);
                setRemoved(null);
                return null;
              }}
            />
            {descriptionChanged && !writing ? (
              <ReadStatus
                kind="loading"
                message="Your description changed. Choose Write changes to update the draft before saving."
              />
            ) : null}
            {showDraft && !edited ? (
              <ReadingStatus
                check={written.check}
                edited={null}
                explanation={written.explanation}
                failed={
                  // No changes says so itself, with the model's reason.
                  written.changes.length === 0
                    ? ""
                    : "These changes don't check, so OpenBot won't save them."
                }
                heading="What these changes do"
                passed="Checks. Every change names a permission, role or group this OpenBot has."
                warning={written.warning}
              />
            ) : null}
            {showDraft && changes.length > 0 ? (
              <Button
                className="min-h-12 self-start"
                onClick={() => impact.current?.focus()}
                type="button"
                variant="outline"
              >
                Review impact
              </Button>
            ) : null}
            {showDraft && changes.length > 0 ? (
              <FieldSet
                disabled={writing || save.isPending || descriptionChanged}
              >
                <ChangeRows
                  changes={changes}
                  onRemove={(index) => {
                    if (save.isError) save.reset();
                    setRemoved({ index, change: changes[index] });
                    setChanges(changes.filter((_, at) => at !== index));
                  }}
                  problems={
                    current && !current.check.ok ? current.check.problems : []
                  }
                  titles={titles}
                />
              </FieldSet>
            ) : null}
            {showDraft && removed ? (
              <HStack gap={3} vAlign="center" wrap="wrap">
                <p className="text-muted-foreground text-sm" role="status">
                  {changes.length > 0
                    ? "Change removed. Review the updated impact before saving."
                    : "There are no changes to save. Undo the last removal or write changes again."}
                </p>
                <Button
                  disabled={writing || save.isPending || descriptionChanged}
                  onClick={() => {
                    const at = Math.min(removed.index, changes.length);
                    if (save.isError) save.reset();
                    restoredRow.current = at + 1;
                    setChanges([
                      ...changes.slice(0, at),
                      removed.change,
                      ...changes.slice(at),
                    ]);
                    setRemoved(null);
                  }}
                  size="sm"
                  className="min-h-12"
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
            {showDraft && changes.length > 0 ? (
              <section
                aria-label="Permission impact"
                className="scroll-mt-4 rounded-lg"
                ref={impact}
                tabIndex={-1}
              >
                <PermissionsPreview preview={preview} />
              </section>
            ) : null}
          </FieldGroup>
          {save.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
      <DraftLeaveConfirmation
        hasDraft={hasDraft}
        saving={save.isPending}
        submitting={submitting}
        title="Discard permission changes?"
      />
    </GovernancePage>
  );
}
