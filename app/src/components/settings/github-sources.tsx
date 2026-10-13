import { IconBrandGithub, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  createGithubBindingMutationOptions,
  githubBindingsQueryOptions,
  removeGithubBindingMutationOptions,
} from "@/lib/responsibilities";
import { queryClient } from "@/query-client";

/**
 * The repositories whose GitHub events can start this person's responsibilities. One per person, not
 * per Bot: an event reaches every responsibility subscribed to it, whichever Bot holds it.
 *
 * Each repository is a row carrying the webhook address to paste into GitHub. Adding one is two
 * inputs, so it is a dialog opened from the section's action.
 */
export function GithubSources() {
  const { t } = useTranslation("settings");
  const bindings = useQuery(githubBindingsQueryOptions());
  const remove = useMutation(removeGithubBindingMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  const error = bindings.error ?? remove.error;
  return (
    <PageSection
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          {t("githubSources.add")}
        </Button>
      }
      description={t("githubSources.description")}
      title={t("githubSources.title")}
    >
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {bindings.isPending || !bindings.data ? null : bindings.data.length ===
        0 ? (
        <PageEmpty>{t("githubSources.empty")}</PageEmpty>
      ) : (
        <PageRows>
          {bindings.data.map((binding, index) => (
            <Fragment key={binding.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconBrandGithub />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{binding.repository}</ItemTitle>
                  <ItemDescription className="line-clamp-none break-all font-mono text-xs">
                    {window.location.origin}/api/events/github/{binding.id}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(binding.id)}
                    size="sm"
                    variant="outline"
                  >
                    {t("githubSources.disconnect")}
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? <AddRepositoryDialog onClose={() => setAdding(false)} /> : null}
    </PageSection>
  );
}

/**
 * A repository and the webhook secret GitHub will sign its events with.
 */
function AddRepositoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation("settings");
  const formId = useId();
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation(createGithubBindingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("githubSources.add")}</DialogTitle>
          <DialogDescription>{t("githubSources.secretHint")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          {/* The submit button is in the footer and reaches this form by id, so DialogBody stays a
              direct child of DialogContent and keeps scrolling. */}
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(
                { repository, secret },
                {
                  onSuccess: () => {
                    setSecret("");
                    setRepository("");
                    onClose();
                  },
                },
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`${formId}-repository`}>
                  {t("githubSources.repositoryLabel")}
                </FieldLabel>
                <Input
                  autoFocus
                  id={`${formId}-repository`}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder={t("githubSources.repositoryPlaceholder")}
                  required
                  value={repository}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-secret`}>
                  {t("githubSources.secretLabel")}
                </FieldLabel>
                <Input
                  autoComplete="new-password"
                  id={`${formId}-secret`}
                  onChange={(event) => setSecret(event.target.value)}
                  required
                  type="password"
                  value={secret}
                />
              </Field>
            </FieldGroup>
          </form>
          {create.error ? (
            <p className="text-destructive text-sm" role="alert">
              {create.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={onClose} size="sm" variant="outline">
            {t("githubSources.cancel")}
          </Button>
          <Button
            disabled={create.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {t("githubSources.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
