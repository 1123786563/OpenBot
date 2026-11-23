import { IconBrandGithub, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { copyText } from "@/components/settings/linked-accounts";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
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
  const bindings = useQuery(githubBindingsQueryOptions());
  const remove = useMutation(removeGithubBindingMutationOptions(queryClient));
  const [adding, setAdding] = useState(false);
  /** One Copy acknowledgment shared by the rows: the last address copied says "Copied". */
  const [copied, setCopied] = useState(false);
  /*
   * Disconnecting deletes the binding, and the webhook left in GitHub then points at an address
   * nothing answers, so it asks first rather than firing on the row's click.
   */
  const { requestConfirmation, confirmation } = useActionConfirmation();
  /*
   * The section's two failure kinds are said separately: the list that could not be read gets its
   * own sentence and its own Retry, and a failed disconnect keeps the mutation's message on the
   * row it was pressed on.
   */
  const readFailed = bindings.error !== null;
  const error = readFailed ? null : remove.error;
  return (
    <PageSection
      action={
        <Button onClick={() => setAdding(true)} size="sm" variant="ghost">
          <IconPlus />
          Add a repository
        </Button>
      }
      description="Add a repository here, then add a webhook in GitHub with the address below and the secret you chose here. Its events, like issues.opened, can then start work on a goal."
      title="Repositories"
    >
      {readFailed ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-destructive text-sm" role="alert">
            Couldn't load your repositories.
          </p>
          <Button
            disabled={bindings.isFetching}
            onClick={() => void bindings.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            {bindings.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      {bindings.isPending || !bindings.data ? null : bindings.data.length ===
        0 ? (
        <PageEmpty
          action={
            <Button onClick={() => setAdding(true)} size="sm" variant="outline">
              <IconPlus />
              Add a repository
            </Button>
          }
          icon={IconBrandGithub}
          title="No repositories yet"
        >
          Repositories you add show up here with their webhook address.
        </PageEmpty>
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
                  <ItemDescription className="line-clamp-none">
                    {/* `break-all`: a webhook address wraps somewhere, or it pushes the row wide. */}
                    <span className="break-all font-mono text-xs">
                      {window.location.origin}/api/events/github/{binding.id}
                    </span>
                    <Button
                      className="ms-2 h-6 px-2"
                      onClick={async () => {
                        setCopied(
                          await copyText(
                            `${window.location.origin}/api/events/github/${binding.id}`,
                            navigator.clipboard,
                          ),
                        );
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    disabled={remove.isPending}
                    onClick={(event) =>
                      requestConfirmation({
                        title: `Disconnect ${binding.repository}?`,
                        description:
                          "Its events can no longer start work. Remove the webhook in GitHub too, or GitHub keeps delivering to an address nothing answers.",
                        confirmLabel: "Disconnect",
                        pendingLabel: "Disconnecting…",
                        failureMessage: `Couldn't disconnect ${binding.repository}. Try again.`,
                        variant: "destructive",
                        trigger: event.currentTarget,
                        run: async () => {
                          await remove.mutateAsync(binding.id);
                        },
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    Disconnect
                  </Button>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? <AddRepositoryDialog onClose={() => setAdding(false)} /> : null}
      {confirmation}
    </PageSection>
  );
}

/**
 * A repository and the webhook secret GitHub will sign its events with.
 */
function AddRepositoryDialog({ onClose }: { onClose: () => void }) {
  const formId = useId();
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation(createGithubBindingMutationOptions(queryClient));
  return (
    <Dialog onOpenChange={(next) => !next && onClose()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a repository</DialogTitle>
          <DialogDescription>
            Use the same secret when you add the webhook in GitHub.
          </DialogDescription>
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
                  Repository
                </FieldLabel>
                <Input
                  autoFocus
                  id={`${formId}-repository`}
                  onChange={(event) => setRepository(event.target.value)}
                  placeholder="owner/repository"
                  required
                  value={repository}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-secret`}>
                  Webhook secret
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
            Cancel
          </Button>
          <Button
            disabled={create.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            Connect events
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
