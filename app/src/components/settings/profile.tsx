import { Text } from "@astryxdesign/core/Text";
import { IconChevronRight, IconUserCircle } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { updateProfileNameMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { canKeepCachedRead } from "@/lib/client";
import { queryClient } from "@/query-client";

/**
 * The person's name as a row on General: the name itself, and a dialog to change it. A free-text value is a summary
 * and a dialog on these screens, so the page reads as a list of answers rather than a form.
 */
export function NameRow() {
  const profile = useQuery(currentUserQueryOptions());
  const user = canKeepCachedRead(profile.error) ? profile.data : null;
  const save = useMutation(updateProfileNameMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const formId = useId();
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const name = user && !user.needsName ? (user.name ?? "") : "";
  const stale = profile.isError && !!user;
  const text = draft ?? name;
  const dirty = draft !== null && text.trim() !== name.trim();
  const canSave =
    dirty && !!text.trim() && profile.isSuccess && !save.isPending;

  function close() {
    setOpen(false);
    setDraft(null);
    save.reset();
  }
  return (
    <>
      <Item
        render={
          <button
            onClick={() => {
              setSaved(false);
              setOpen(true);
            }}
            ref={opener}
            type="button"
          />
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconUserCircle />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle>Name</ItemTitle>
          <ItemDescription className="line-clamp-none wrap-anywhere">
            {profile.isPending
              ? "Loading your name…"
              : profile.isError && !user
                ? "Couldn’t load your name."
                : name || "Not set yet."}
          </ItemDescription>
          {stale ? (
            <Text as="p" color="secondary" display="block" size="base">
              Last loaded · Refresh before saving.
            </Text>
          ) : null}
        </ItemContent>
        <ItemActions>
          <IconChevronRight className="size-4 text-muted-foreground" />
        </ItemActions>
      </Item>
      {saved ? (
        <p role="status" className="px-4 pb-3 text-sm text-muted-foreground">
          Your name has been saved.
        </p>
      ) : null}
      <SettingsDraftDialog
        title="Your name"
        description="Choose the name OpenBot shows for you."
        open={open}
        dirty={dirty}
        guardNavigation={submitting}
        saving={save.isPending}
        opener={opener}
        onClose={close}
        action={
          user ? (
            <Button
              aria-disabled={!canSave}
              className="min-h-11"
              form={formId}
              type="submit"
            >
              {save.isPending ? "Saving…" : "Save name"}
            </Button>
          ) : undefined
        }
      >
        {profile.isPending ? (
          <ReadStatus kind="loading" message="Loading your name…" />
        ) : profile.isError || !user ? (
          <ReadError
            focusAfterRetry={() => field.current}
            message={
              stale ? "Couldn’t refresh your name." : "Couldn’t load your name."
            }
            description={
              stale
                ? dirty
                  ? "Your draft is still here. Refresh before saving."
                  : "Showing your last loaded name. Refresh before saving."
                : undefined
            }
            retry={profile.refetch}
            retryBelow
            retryLabel={stale ? "Refresh name" : undefined}
            retrying={profile.isFetching}
          />
        ) : null}
        {user ? (
          <form
            className="flex w-full flex-col gap-3"
            id={formId}
            onSubmit={async (event) => {
              event.preventDefault();
              if (!canSave || submitting.current) return;
              submitting.current = true;
              try {
                await save.mutateAsync(text.trim());
                setSaved(true);
                close();
              } catch {
                // The response is shown beside the draft.
              } finally {
                submitting.current = false;
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
              <Input
                id={`${formId}-name`}
                autoComplete="name"
                className="min-h-11"
                maxLength={100}
                required
                value={text}
                ref={field}
                readOnly={save.isPending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  save.reset();
                }}
              />
            </Field>
            {save.error ? (
              <p
                role="alert"
                className="text-sm text-destructive [overflow-wrap:anywhere]"
              >
                {save.error.message}
              </p>
            ) : null}
          </form>
        ) : null}
      </SettingsDraftDialog>
    </>
  );
}
