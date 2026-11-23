import { HStack } from "@astryxdesign/core/Stack";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { useRef, useState } from "react";
import {
  ChangeRows,
  PermissionsPreview,
} from "@/components/admin/controls/describe-capabilities";
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
  const submitting = useRef(false);
  const hasDraft = description.trim() !== "" || written !== null;
  useBlocker({
    enableBeforeUnload: hasDraft,
    shouldBlockFn: ({ current, next }) =>
      hasDraft &&
      current.pathname !== next.pathname &&
      !window.confirm("Leave without saving your permission changes?"),
  });
  const descriptionChanged =
    written !== null && written.text !== description.trim();

  const preview = useQuery({
    ...capabilityChangesPreviewQueryOptions(changes),
    enabled: !descriptionChanged && changes.length > 0,
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
        onSubmit={(event) => {
          event.preventDefault();
          saveChanges();
        }}
      >
        <PageCard
          footer={
            <>
              <Button
                render={(props) => <Link {...props} to="/admin/permissions" />}
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={!ready} type="submit">
                {save.isPending ? "Saving…" : "Save changes"}
              </Button>
            </>
          }
        >
          <FieldGroup>
            <DescribeField
              action="Write changes"
              disabled={save.isPending}
              description="Say in a sentence who may or may not do something, and your model writes the changes from this OpenBot's roles and groups. A second reading that never sees your words says what the changes do."
              id="permissions-english"
              label="Describe the change"
              onTextChange={setDescription}
              onWritingChange={setWriting}
              placeholder="Contractors can't use their own computer"
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
            {descriptionChanged ? (
              <ReadStatus
                kind="loading"
                message="Your description changed. Choose Write changes to update the draft before saving."
              />
            ) : null}
            {written ? (
              <ReadingStatus
                check={written.check}
                edited={
                  edited
                    ? "You've removed a change since they were written. The check and the reading above are for the written changes, not your edit."
                    : null
                }
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
            {changes.length > 0 ? (
              <FieldSet
                disabled={writing || save.isPending || descriptionChanged}
              >
                <ChangeRows
                  changes={changes}
                  onRemove={(index) => {
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
            {removed ? (
              <HStack gap={3} vAlign="center" wrap="wrap">
                <p className="text-muted-foreground text-sm" role="status">
                  Removed one change.
                </p>
                <Button
                  disabled={writing || save.isPending || descriptionChanged}
                  onClick={() => {
                    const at = Math.min(removed.index, changes.length);
                    setChanges([
                      ...changes.slice(0, at),
                      removed.change,
                      ...changes.slice(at),
                    ]);
                    setRemoved(null);
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Undo
                </Button>
              </HStack>
            ) : null}
            {!descriptionChanged &&
            current &&
            !current.check.ok &&
            current.check.problems.length === 0 ? (
              <p className="text-destructive text-sm">{current.check.error}</p>
            ) : null}
            {!descriptionChanged && changes.length > 0 ? (
              <PermissionsPreview preview={preview} />
            ) : null}
          </FieldGroup>
          {save.error ? (
            <p className="mt-5 text-destructive text-sm" role="alert">
              {save.error.message}
            </p>
          ) : null}
        </PageCard>
      </form>
    </GovernancePage>
  );
}
