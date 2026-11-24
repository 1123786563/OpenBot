import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { IconChevronRight, IconNotes } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { canKeepCachedRead } from "@/lib/client";
import { saveInstructionsMutationOptions } from "@/lib/settings/mutations";
import {
  INSTRUCTIONS_LIMIT,
  instructionsQueryOptions,
} from "@/lib/settings/queries";
import { queryClient } from "@/query-client";

/**
 * One box, applied to every coworker in every channel.
 *
 * WHAT IT IS FOR, said on the screen rather than left to be guessed. A coworker's role and this are
 * both durable instructions and a person meeting them for the first time has no reason to know which
 * belongs where, so the description draws the line the prompt draws: the role says what a coworker
 * is for, this says how the person wants things done. Without that sentence the obvious mistake is
 * to write a job description here and get it applied to every coworker at once.
 */
const DESCRIPTION =
  "Applies to every Bot in every conversation. A Bot's role says what it does. This says how you want it done, like your writing style.";

/**
 * The standing instructions as a row on General: what they say, cut to two lines, and a dialog to write them. A free
 * text is a summary and a dialog on these screens, so a long box does not take over the page.
 */
export function StandingInstructionsRow() {
  const stored = useQuery(instructionsQueryOptions());
  const save = useMutation(saveInstructionsMutationOptions(queryClient));
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const submitting = useRef(false);
  const countId = useId();
  const formId = useId();
  const written = stored.data?.trim();
  const text = draft ?? stored.data ?? "";
  const length = text.trim().length;
  const over = length > INSTRUCTIONS_LIMIT;
  const dirty = draft !== null && text.trim() !== (written ?? "");
  const readable = stored.data !== undefined && canKeepCachedRead(stored.error);
  const stale = readable && stored.isError;
  const canSave = dirty && !over && stored.isSuccess && !save.isPending;

  function close() {
    setOpen(false);
    setDraft(null);
    save.reset();
  }
  return (
    <>
      <Item
        render={
          <button onClick={() => setOpen(true)} ref={opener} type="button" />
        }
        size="sm"
      >
        <ItemMedia variant="icon">
          <IconNotes />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-auto">Standing instructions</ItemTitle>
          <ItemDescription className="line-clamp-none">
            Applies to every Bot in every conversation.
          </ItemDescription>
          <ItemDescription className="wrap-anywhere">
            {stored.isPending
              ? "Loading your instructions…"
              : stored.isError && !readable
                ? "Couldn’t load your instructions."
                : written || "None yet."}
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
      <SettingsDraftDialog
        title="Standing instructions"
        description={DESCRIPTION}
        open={open}
        dirty={dirty}
        guardNavigation={submitting}
        saving={save.isPending}
        opener={opener}
        onClose={close}
        action={
          readable ? (
            <Button
              aria-disabled={!canSave}
              className="min-h-11"
              form={formId}
              type="submit"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          ) : undefined
        }
      >
        {stored.isPending ? (
          <ReadStatus kind="loading" message="Loading your instructions…" />
        ) : stored.error ? (
          <ReadError
            focusAfterRetry={() => field.current}
            message={
              stale
                ? "Couldn’t refresh your instructions."
                : "Couldn’t load your instructions."
            }
            description={
              stale
                ? dirty
                  ? "Your draft is still here. Refresh before saving."
                  : "Showing your last loaded instructions. Refresh before saving."
                : undefined
            }
            retry={stored.refetch}
            retryBelow
            retryLabel={stale ? "Refresh instructions" : undefined}
            retrying={stored.isFetching}
          />
        ) : null}
        {readable ? (
          <form
            id={formId}
            onSubmit={async (event) => {
              event.preventDefault();
              if (!canSave || submitting.current) return;
              submitting.current = true;
              try {
                await save.mutateAsync(text);
                setDraft(null);
              } catch {
                // The response is shown beside the draft.
              } finally {
                submitting.current = false;
              }
            }}
          >
            <VStack gap={2}>
              <Textarea
                aria-describedby={countId}
                aria-invalid={over || undefined}
                aria-label="Standing instructions"
                className="min-h-40"
                readOnly={save.isPending}
                onChange={(event) => {
                  setDraft(event.target.value);
                  save.reset();
                }}
                placeholder="Use British English and write dates in day–month–year order."
                ref={field}
                value={text}
              />
              <Text
                as="p"
                className={over ? "text-destructive" : undefined}
                color="secondary"
                id={countId}
                size="sm"
              >
                {length} of {INSTRUCTIONS_LIMIT} characters
              </Text>
              {save.error ? (
                <Text
                  as="p"
                  className="text-destructive [overflow-wrap:anywhere]"
                  role="alert"
                  size="sm"
                >
                  {save.error.message}
                </Text>
              ) : save.isSuccess ? (
                <Text as="p" color="secondary" role="status" size="sm">
                  Saved
                </Text>
              ) : null}
            </VStack>
          </form>
        ) : null}
      </SettingsDraftDialog>
    </>
  );
}
