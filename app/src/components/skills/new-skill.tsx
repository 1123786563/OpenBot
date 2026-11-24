import type { ComponentProps } from "react";
import { SkillFields } from "@/components/skills/skill-fields";
import { emptySkillForm } from "@/lib/skills/form";

/**
 * Writing a skill, in the detail panel beside the list.
 *
 * The panel rather than a page of its own, so the skills you already have stay on screen while you
 * write the next one — the usual reason to open this is to make a variant of one that exists.
 */
export function NewSkill({
  status,
  ...form
}: {
  status: "loading" | "unavailable" | "ready";
} & Pick<
  ComponentProps<typeof SkillFields>,
  "error" | "onDirtyChange" | "onSubmit" | "saving"
>) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">New skill</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          An instruction you start with <code>/</code>. Only you see it, and it
          works on Bots you own.
        </p>
      </header>

      {status !== "ready" ? (
        <p className="text-sm text-muted-foreground" role="status">
          {status === "loading"
            ? "Loading skills…"
            : "Saving is unavailable. Check the skills list for the latest status."}
        </p>
      ) : null}
      <SkillFields
        {...form}
        defaultValues={emptySkillForm}
        saveDisabled={status !== "ready"}
        submitLabel="Save skill"
      />
    </div>
  );
}
