import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { SkillFields } from "@/components/skills/skill-fields";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
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
  const { requestConfirmation, confirmation } = useActionConfirmation();

  const leave = paths.skills();

  return (
    <CapabilityPage
      backButton={{ label: "Skills", linkProps: paths.skills() }}
      description={
        personal
          ? "Write instructions a Bot follows when you pick the skill from the / menu. Your Bots offer it as soon as you save."
          : "Write instructions a Bot follows when someone picks the skill from the / menu. After saving, choose which Bots offer it."
      }
      title="New skill"
    >
      <SkillFields
        sections={{
          flush: true,
          /* A draft with anything in it is worth one question before Cancel throws it away. */
          cancel: ({ dirty }) => (
            <Button
              onClick={(event) => {
                if (!dirty) return;
                event.preventDefault();
                requestConfirmation({
                  title: "Leave without saving?",
                  description:
                    "What you have written in this skill is discarded.",
                  confirmLabel: "Leave",
                  pendingLabel: "Leaving…",
                  failureMessage: "Couldn't leave this page. Try again.",
                  trigger: event.currentTarget,
                  run: async () => {
                    await navigate(leave);
                  },
                });
              }}
              render={(props) => <Link {...props} {...leave} />}
              variant="outline"
            >
              Cancel
            </Button>
          ),
        }}
        defaultValues={emptySkillForm}
        error={saveSkill.error}
        onSubmit={async (values) => {
          // Admin-authored skills are the deployment's; a person's own are made on Capabilities.
          await saveSkill.mutateAsync({ ...values, global: true });
          await navigate(paths.skill(values.slug.trim()));
        }}
        submitLabel="Save skill"
      />
      {confirmation}
    </CapabilityPage>
  );
}
