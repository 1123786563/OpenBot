import { Text } from "@astryxdesign/core/Text";
import { IconBrandGithub, IconPlus } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useRef, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
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
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { newId } from "@/lib/new-id";
import {
  createGithubBindingMutationOptions,
  type GithubBindingRecord,
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
  const [added, setAdded] = useState("");
  const addTrigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const { requestConfirmation, confirmation } = useActionConfirmation();
  function closeAdd() {
    setAdding(false);
    requestAnimationFrame(() => {
      const trigger = addTrigger.current;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
      else heading.current?.focus();
    });
  }
  return (
    <PageSection
      action={
        <Button
          className="confirmation-action"
          disabled={!bindings.isSuccess}
          onClick={() => {
            setAdded("");
            setAdding(true);
          }}
          ref={addTrigger}
          size="sm"
          variant="ghost"
        >
          <IconPlus />
          Add a repository
        </Button>
      }
      description="Repository events can start work on a goal. For each repository you add, use its webhook address and your secret to set up the webhook in GitHub."
      headingRef={heading}
      title="Repositories"
    >
      {added ? (
        <Text
          as="p"
          role="status"
          size="sm"
          style={{ marginBlockStart: "var(--spacing-3)" }}
        >
          Added {added}. Copy its webhook address to finish setup in GitHub.
        </Text>
      ) : null}
      {bindings.isPending ? (
        <ReadStatus kind="loading" message="Loading your repositories…" />
      ) : bindings.isError ? (
        <ReadError
          message="Couldn’t load your repositories"
          retry={bindings.refetch}
          retryBelow
          retryLabel="Retry repositories"
          retrying={bindings.isFetching}
        />
      ) : bindings.data.length === 0 ? (
        <PageEmpty icon={IconBrandGithub} title="No repositories yet">
          Add a repository to get its webhook address.
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
                <ItemContent style={{ minInlineSize: 0 }}>
                  <ItemTitle
                    style={{
                      display: "block",
                      overflowWrap: "anywhere",
                      WebkitLineClamp: "unset",
                    }}
                  >
                    {binding.repository}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    className="confirmation-action"
                    disabled={remove.isPending}
                    onClick={(event) =>
                      requestConfirmation({
                        title: `Disconnect ${binding.repository}?`,
                        description:
                          "Events from this repository will stop starting work. Remove its webhook in GitHub to stop delivery.",
                        confirmLabel: "Disconnect",
                        pendingLabel: "Disconnecting…",
                        failureMessage: `Couldn't disconnect ${binding.repository}. Try again.`,
                        variant: "destructive",
                        trigger: event.currentTarget,
                        fallbackFocus: () => heading.current,
                        successMessage: `Disconnected ${binding.repository}.`,
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
                <WebhookAddress binding={binding} />
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {adding ? (
        <AddRepositoryDialog
          onClose={closeAdd}
          onSaved={(repository) => {
            setAdded(repository);
            closeAdd();
          }}
        />
      ) : null}
      {confirmation}
    </PageSection>
  );
}

function WebhookAddress({ binding }: { binding: GithubBindingRecord }) {
  const address = `${window.location.origin}/api/events/github/${binding.id}`;
  const addressText = useRef<HTMLElement>(null);
  const [copyResult, setCopyResult] = useState<"copied" | "manual" | null>(
    null,
  );
  async function copyAddress() {
    if (await copyText(address, navigator.clipboard)) {
      setCopyResult("copied");
      return;
    }
    setCopyResult("manual");
    const target = addressText.current;
    const selection = window.getSelection();
    if (!target || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(target);
    target.focus();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  return (
    <ItemFooter style={{ flexWrap: "wrap" }}>
      <Text
        as="p"
        color="secondary"
        ref={addressText}
        size="sm"
        style={{ flex: 1, minInlineSize: 0, overflowWrap: "anywhere" }}
        tabIndex={-1}
      >
        {address}
      </Text>
      <Button
        aria-label={`Copy webhook address for ${binding.repository}`}
        className="confirmation-action"
        onClick={() => void copyAddress()}
        size="sm"
        type="button"
        variant="ghost"
      >
        Copy
      </Button>
      {copyResult ? (
        <Text
          as="p"
          color="secondary"
          role="status"
          size="sm"
          style={{ flexBasis: "100%" }}
        >
          {copyResult === "copied" ? "Copied" : "Copy the selected address."}
        </Text>
      ) : null}
    </ItemFooter>
  );
}

/**
 * A repository and the webhook secret GitHub will sign its events with.
 */
function AddRepositoryDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (repository: string) => void;
}) {
  const formId = useId();
  const [repository, setRepository] = useState("");
  const [secret, setSecret] = useState("");
  const create = useMutation(createGithubBindingMutationOptions(queryClient));
  const saving = useRef(false);
  const requestId = useRef<string | null>(null);
  return (
    <Dialog
      onOpenChange={(next, event) => {
        if (next) return;
        if (saving.current) event.cancel();
        else onClose();
      }}
      open
    >
      <DialogContent showCloseButton={false}>
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
              if (saving.current) return;
              saving.current = true;
              requestId.current ??= newId();
              create.mutate(
                { repository, secret, requestId: requestId.current },
                {
                  onSuccess: (binding) => onSaved(binding.repository),
                  onError: () => {
                    saving.current = false;
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
                  onChange={(event) => {
                    requestId.current = null;
                    setRepository(event.target.value);
                  }}
                  placeholder="owner/repository"
                  readOnly={create.isPending}
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
                  onChange={(event) => {
                    requestId.current = null;
                    setSecret(event.target.value);
                  }}
                  readOnly={create.isPending}
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
          <Button
            disabled={create.isPending}
            onClick={onClose}
            size="sm"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            aria-disabled={create.isPending}
            form={formId}
            size="sm"
            type="submit"
          >
            {create.isPending ? "Adding repository…" : "Add repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
