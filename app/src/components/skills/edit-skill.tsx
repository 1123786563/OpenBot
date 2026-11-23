import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef } from "react";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SkillAgents } from "@/components/skills/skill-agents";
import { SkillFields } from "@/components/skills/skill-fields";
import { ClientError } from "@/lib/client";
import { saveSkillMutationOptions } from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * Editing a skill, in the same panel that writes one.
 *
 * THERE IS NO EDIT ENDPOINT, AND NONE IS NEEDED. `POST /api/plugins/skills` upserts on the slug:
 * `installSkill` does `onConflictDoUpdate` and deliberately leaves `owner_user_id` alone, so a
 * re-save changes the words and never quietly changes whose skill it is. The route has already
 * refused anyone editing a skill that is not theirs before it gets that far.
 */
export function EditSkill({ slug }: { slug: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data, error, isFetching, isPending, refetch } = useQuery(
    pluginsPageQueryOptions(),
  );

  /*
   * Read from the list already on screen rather than fetched again. It is the same request the page
   * behind this panel just made, so react-query serves it from cache and the form is filled on the
   * first frame instead of flashing empty fields at somebody who came here to change one word.
   */
  const skill = data?.skills.find((candidate) => candidate.slug === slug);

  const saveSkill = useMutation(saveSkillMutationOptions(queryClient));

  const denied =
    error instanceof ClientError &&
    (error.status === 401 || error.status === 403);
  const heading = useRef<HTMLHeadingElement>(null);
  const unavailable = !data || denied;

  async function retrySkill() {
    const opener = document.activeElement;
    const result = await refetch();
    if (!result.isSuccess) return;
    requestAnimationFrame(() => {
      const title = heading.current;
      const active = document.activeElement;
      if (
        active === opener ||
        active === document.body ||
        active === title?.closest('[role="dialog"]')
      ) {
        title?.focus();
      }
    });
  }

  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold" ref={heading} tabIndex={-1}>
          Edit skill
        </h1>
        {!unavailable && skill ? (
          <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            Changes apply the next time someone uses {skill.title}. Bots that
            have it keep it.
          </p>
        ) : null}
      </header>
      {isPending ? (
        <ReadStatus kind="loading" message="Loading skill…" />
      ) : unavailable ? (
        <ReadError
          message="Couldn't load this skill."
          retry={retrySkill}
          retryBelow
          retrying={isFetching}
        />
      ) : !skill ? (
        <p className="text-muted-foreground text-sm">
          This skill was deleted, or it isn't yours to edit.
        </p>
      ) : (
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
          error={saveSkill.error}
          /*
           * Passed down rather than rendered after the form, so it lands above Save changes. Granting
           * still saves on its own the instant a button is pressed — `SkillFields` keeps it out of the
           * form's state and only decides where it sits.
           */
          footer={<SkillAgents grantedTo={skill.grantedTo} slug={skill.slug} />}
          onSubmit={async (values) => {
            await saveSkill.mutateAsync(values);
            await navigate({ search: {}, to: "/capabilities/skills" });
          }}
          slugLocked
          submitLabel="Save changes"
        />
      )}
    </section>
  );
}
