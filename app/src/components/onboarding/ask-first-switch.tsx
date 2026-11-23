import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Switch } from "@base-ui/react/switch";
import { IconHandStop } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId } from "react";
import {
  ASK_FIRST_DESCRIPTION,
  ASK_FIRST_TITLE,
} from "@/components/approvals/ask-first-copy";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  approvalInboxOptions,
  approvalPreferencesMutationOptions,
} from "@/lib/approvals";
import { queryClient } from "@/query-client";

/**
 * The approval step's one setting, offered on the step rather than described: Extra vigilant, the
 * same switch and the same preference as Settings → Approvals, in the same words
 * (ask-first-copy.ts). It takes effect when switched, and a change that fails is said under it.
 *
 * The step is still a picture of what a Bot asks; the switch sits with the words, outside the
 * picture's frame, because it is the one real control here.
 */
export function AskFirstSwitch() {
  const description = useId();
  // Read once: the inbox's own polling is for the approvals page, not for a single switch.
  const inbox = useQuery({ ...approvalInboxOptions(), refetchInterval: false });
  const preferences = useMutation(
    approvalPreferencesMutationOptions(queryClient),
  );
  // While a change is on its way, the switch shows it rather than snapping back until it lands.
  const checked = preferences.isPending
    ? preferences.variables.enabled === true
    : (inbox.data?.enabled ?? false);
  return (
    <VStack className="w-full text-left" gap={2}>
      <Item size="sm" variant="outline">
        <ItemMedia variant="icon">
          <IconHandStop />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{ASK_FIRST_TITLE}</ItemTitle>
          <ItemDescription className="line-clamp-none" id={description}>
            {ASK_FIRST_DESCRIPTION}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Switch.Root
            aria-describedby={description}
            aria-label={ASK_FIRST_TITLE}
            checked={checked}
            className="group grid size-11 shrink-0 cursor-pointer place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-disabled:cursor-not-allowed data-disabled:opacity-60"
            disabled={inbox.isPending || preferences.isPending}
            onCheckedChange={(enabled) => preferences.mutate({ enabled })}
          >
            <HStack
              aria-hidden
              as="span"
              className="pointer-events-none h-6 w-10 rounded-full border border-muted-foreground bg-background p-0.5 group-data-checked:border-primary group-data-checked:bg-primary"
              vAlign="center"
            >
              <Switch.Thumb className="size-4 shrink-0 rounded-full bg-muted-foreground transition-transform data-checked:translate-x-4 data-checked:bg-primary-foreground motion-reduce:transition-none" />
            </HStack>
          </Switch.Root>
        </ItemActions>
      </Item>
      {preferences.error ? (
        <p className="text-sm text-destructive" role="alert">
          Couldn't change it. Try again or go to Settings → Approvals after
          setup.
        </p>
      ) : inbox.error ? (
        <p className="text-sm text-muted-foreground" role="status">
          Couldn’t load this preference. You can check it in Settings →
          Approvals after setup.
        </p>
      ) : null}
    </VStack>
  );
}
