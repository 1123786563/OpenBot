import { IconFileText, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { PageRowsSkeleton } from "@/components/layout/page-skeletons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  removeSkillMutationOptions,
  saveSkillMutationOptions,
  setPluginGrantMutationOptions,
} from "@/lib/plugins/mutations";
import { pluginsPageQueryOptions } from "@/lib/plugins/queries";

/**
 * The deployment's skills: named instructions a person invokes with `/` and a Bot follows.
 *
 * Its own screen rather than a tab on Plugins, because a skill is not a connector. It adds no
 * capability at all — it can only ask a Bot to use tools that Bot was already granted, and every one
 * of those calls is still decided, policy-checked and audited. That is why anybody may write one for
 * themselves on their own Skills page, while adding an MCP server stays an administrator's decision.
 * Sitting in a list of vendors made it look like a third kind of thing a Bot could reach.
 */
export const Route = createFileRoute("/_authed/admin/skills")({
  component: RouteComponent,
});

const EMPTY_DRAFT = { slug: "", title: "", summary: "", instructions: "" };

function RouteComponent() {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginsPageQueryOptions());
  const { data: agents } = useQuery(agentListQueryOptions());
  const nameFor = useBotNames();

  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const report = { onError: (thrown: Error) => setError(thrown.message) };
  const saveSkill = useMutation({
    ...saveSkillMutationOptions(queryClient),
    ...report,
  });
  const removeSkill = useMutation({
    ...removeSkillMutationOptions(queryClient),
    ...report,
  });
  const setGrant = useMutation({
    ...setPluginGrantMutationOptions(queryClient),
    ...report,
  });

  const bots = (agents ?? []).map((agent: { id: string }) => ({
    id: agent.id,
    name: nameFor(agent.id),
  }));
  const skills = plugins.data?.skills ?? [];

  return (
    <PageShell
      action={
        <Button onClick={() => setWriting(true)} size="lg" type="button">
          <IconPlus />
          {t("skills.write")}
        </Button>
      }
      description={t("skills.description")}
      title={t("skills.title")}
    >
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <PageSection
        description={t("skills.installed.description")}
        title={t("skills.installed.title")}
      >
        {/* A read that failed says so; `isPending` goes false on it too, and it is not "none". */}
        {plugins.isPending ? (
          <PageRowsSkeleton />
        ) : !plugins.data ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {t("skills.installed.loadError")}
          </p>
        ) : skills.length === 0 ? (
          <PageEmpty>{t("skills.installed.empty")}</PageEmpty>
        ) : (
          <PageRows>
            {skills.map((skill, index) => (
              <React.Fragment key={skill.slug}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconFileText className="size-4" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      <code className="font-mono text-foreground/80 text-xs">
                        /{skill.slug}
                      </code>{" "}
                      {skill.title}
                    </ItemTitle>
                    <ItemDescription>{skill.summary}</ItemDescription>
                    {/* A set, so it wraps onto its own line rather than crowding the title. */}
                    <ItemFooter>
                      <div className="flex flex-wrap gap-2">
                        {bots.map((bot) => {
                          const held = skill.grantedTo.includes(bot.id);
                          return (
                            <Button
                              key={bot.id}
                              onClick={() =>
                                setGrant.mutate({
                                  agentId: bot.id,
                                  granted: !held,
                                  kind: "skill",
                                  ref: skill.slug,
                                })
                              }
                              size="sm"
                              type="button"
                              variant={held ? "default" : "outline"}
                            >
                              {bot.name}
                            </Button>
                          );
                        })}
                      </div>
                    </ItemFooter>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      onClick={() => removeSkill.mutate(skill.slug)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("skills.installed.remove")}
                    </Button>
                  </ItemActions>
                </Item>
                {index !== skills.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      <Dialog onOpenChange={setWriting} open={writing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("skills.dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("skills.dialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="skill-slug">
                  {t("skills.dialog.slug")}
                </FieldLabel>
                <Input
                  id="skill-slug"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      slug: event.target.value,
                    }))
                  }
                  placeholder="standup-notes"
                  value={draft.slug}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-title">
                  {t("skills.dialog.titleField")}
                </FieldLabel>
                <Input
                  id="skill-title"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder={t("skills.dialog.titlePlaceholder")}
                  value={draft.title}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-summary">
                  {t("skills.dialog.summary")}
                </FieldLabel>
                <Input
                  id="skill-summary"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      summary: event.target.value,
                    }))
                  }
                  placeholder={t("skills.dialog.summaryPlaceholder")}
                  value={draft.summary}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="skill-instructions">
                  {t("skills.dialog.instructions")}
                </FieldLabel>
                <Textarea
                  className="h-28 font-mono text-sm"
                  id="skill-instructions"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      instructions: event.target.value,
                    }))
                  }
                  placeholder={t("skills.dialog.instructionsPlaceholder")}
                  value={draft.instructions}
                />
              </Field>
            </FieldGroup>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => setWriting(false)} size="sm" variant="ghost">
              {t("skills.cancel")}
            </Button>
            <Button
              disabled={!(draft.slug && draft.title && draft.instructions)}
              onClick={() => {
                // Admin-authored skills are the deployment's; a person's own are made elsewhere.
                saveSkill.mutate({ ...draft, global: true });
                setDraft(EMPTY_DRAFT);
                setWriting(false);
              }}
              size="sm"
            >
              {t("skills.dialog.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
