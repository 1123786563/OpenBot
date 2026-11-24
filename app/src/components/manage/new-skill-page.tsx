import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { DraftLeaveConfirmation } from "@/components/admin/controls/draft-leave-confirmation";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { SkillFields } from "@/components/skills/skill-fields";
import { buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill for the whole deployment, on a screen of its own rather than in a dialog over the
 * list, as every other screen that adds something does (`new-credential-page.tsx`).
 *
 * Saving opens the skill's own page, because a skill no Bot offers does nothing yet: choosing the
 * Bots is the step that makes it work. In the personal edition every Bot already offers a new skill
 * (the server grants it, `personal-defaults.ts`), so there the page is where to turn one off.
 */
export function NewSkillPage() {
  const paths = useManagePaths();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const [dirty, setDirty] = useState(false);
  const submitting = useRef(false);

  const leave = paths.skills();

  return (
    <CapabilityPage
      backButton={{ label: "Skills", linkProps: paths.skills() }}
      description={
        personal
          ? "Give your Bots reusable instructions for the / menu. Saving makes the skill available to all your Bots."
          : "Write reusable instructions for the / menu. Save the skill, then choose which Bots can offer it."
      }
      title="New skill"
    >
      <SkillFields
        sections={{
          flush: true,
          cancel: () => (
            <Link
              {...leave}
              className={buttonVariants({
                className: "min-h-11",
                variant: "outline",
              })}
            >
              Cancel
            </Link>
          ),
        }}
        defaultValues={emptySkillForm}
        error={saveSkill.error}
        onDirtyChange={setDirty}
        saveDisabled={saveSkill.isPending}
        saving={saveSkill.isPending}
        onSubmit={async (values) => {
          if (submitting.current) return;
          submitting.current = true;
          try {
            // Deployment skills are shared. Personal drafts are made on Capabilities.
            await saveSkill.mutateAsync({ ...values, global: true });
            await navigate({
              ...paths.skill(values.slug.trim()),
              ignoreBlocker: true,
              replace: true,
            });
          } finally {
            submitting.current = false;
          }
        }}
        submitLabel="Save skill"
      />
      <DraftLeaveConfirmation
        description="The instructions, name, and tools you entered will be lost."
        hasDraft={dirty}
        saving={saveSkill.isPending}
        submitting={submitting}
        title="Discard this skill draft?"
      />
    </CapabilityPage>
  );
}
