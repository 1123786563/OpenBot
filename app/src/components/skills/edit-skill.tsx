import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { SkillAgents } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";
import type { SkillFormValues } from "@/lib/skills/form";

/**
 * Editing a skill, in the same panel that writes one.
 *
 * THERE IS NO EDIT ENDPOINT, AND NONE IS NEEDED. `POST /api/plugins/skills` upserts on the slug:
 * `installSkill` does `onConflictDoUpdate` and deliberately leaves `owner_user_id` alone, so a
 * re-save changes the words and never quietly changes whose skill it is. The route has already
 * refused anyone editing a skill that is not theirs before it gets that far.
 */
export function EditSkill({
  slug,
  draftValues,
  draftDirty,
  onDraftChange,
}: {
  slug: string;
  draftValues?: SkillFormValues;
  draftDirty?: boolean;
  onDraftChange?: (values: SkillFormValues, dirty: boolean) => void;
}) {
  const { t } = useTranslation("skills");
  const queryClient = useQueryClient();
  // The save rides the scope this screen holds (MT088 AC3): the write carries the selection pair.
  const scope = useScopedCache();
  const navigate = useNavigate();
  const { data, isPending } = useQuery(pluginsPageQueryOptions());

  /*
   * Read from the list already on screen rather than fetched again. It is the same request the page
   * behind this panel just made, so react-query serves it from cache and the form is filled on the
   * first frame instead of flashing empty fields at somebody who came here to change one word.
   */
  const skill = data?.skills.find((candidate) => candidate.slug === slug);

  const saveSkill = useMutation(saveSkillMutationOptions(queryClient, scope));

  /* Nothing while it loads. "Missing" and "not yet arrived" must not read the same. */
  if (isPending) return null;

  /*
   * No list is not a missing skill. `isPending` goes false on a failed read too, and the sentence
   * below tells somebody their skill is gone, or was never theirs, on no evidence at all.
   */
  if (!data) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        <p className="text-destructive text-sm" role="alert">
          {t("editing.loadError")}
        </p>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
        {/*
         * Said plainly rather than shown as an empty form. A skill can be missing because it was
         * deleted in another tab, or because the link names one that is somebody else's — and an
         * empty form here would invite them to write it back into existence under a slug they may
         * not own.
         */}
        <p className="text-muted-foreground text-sm">{t("editing.missing")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">{t("editing.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          <Trans
            i18nKey="editing.changesApply"
            t={t}
            values={{ slug: skill.slug }}
            components={{ code: <code /> }}
          />
        </p>
      </header>

      <SkillFields
        defaultValues={{
          slug: skill.slug,
          title: skill.title,
          summary: skill.summary ?? "",
          instructions: skill.instructions,
          // Defaulted, so a skill written before this field existed opens with nothing ticked rather
          // than with an undefined the form would refuse to submit.
          tools: skill.tools ?? [],
        }}
        draftValues={draftValues}
        draftDirty={draftDirty}
        error={saveSkill.error}
        onDraftChange={onDraftChange}
        /*
         * Passed down rather than rendered after the form, so it lands above Save changes. Granting
         * still saves on its own the instant a button is pressed — `SkillFields` keeps it out of the
         * form's state and only decides where it sits.
         */
        footer={<SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />}
        onSubmit={async (values) => {
          await saveSkill.mutateAsync(values);
          await navigate({ search: {}, to: "/skills" });
        }}
        slugLocked
        submitLabel={t("editing.save")}
      />
    </div>
  );
}
