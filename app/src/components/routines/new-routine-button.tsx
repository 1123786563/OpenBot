import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { IconClock, IconPlus } from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import { type ComponentProps, useCallback } from "react";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Opens the Routine create screen, optionally with one Bot selected. */
export function NewRoutineButton({ agentId }: { agentId?: string }) {
  const RoutineLink = useCallback(
    ({ href: _href, ...props }: ComponentProps<"a">) => (
      <Link {...props} search={agentId ? { agentId } : {}} to="/routines/new" />
    ),
    [agentId],
  );
  // A list drawn with no router around it, as standalone component tests draw it, has nowhere to link to.
  if (!useRouter({ warn: false })) return null;
  return (
    <AstryxButton
      as={RoutineLink}
      href={
        agentId
          ? `/routines/new?agentId=${encodeURIComponent(agentId)}`
          : "/routines/new"
      }
      icon={<IconPlus aria-hidden />}
      label="New routine"
      size="sm"
      style={{
        minBlockSize: "var(--spacing-11, 2.75rem)",
        paddingInline: "calc(var(--spacing) * 3)",
      }}
      variant="primary"
    />
  );
}

/**
 * The clock beside a conversation's `+`: set up a routine for this Bot, posting here.
 *
 * Opens the same create screen as the Routines page, with the Bot and this conversation already
 * chosen, so the person only says what to do and when. A screen rather than a starter typed into the
 * box, because the box sends to the Bot and the Bot would then have to ask when.
 */
export function RoutineComposerButton({
  agentId,
  channelId,
}: {
  agentId: string;
  channelId: string;
}) {
  /*
   * A link needs a router to follow. The conversation always has one in the app; a conversation
   * drawn on its own, as its tests draw it, has nowhere to go, so it draws no clock.
   */
  if (!useRouter({ warn: false })) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Set up a routine"
            data-slot="composer-routine"
            render={(props) => (
              <Link
                {...props}
                search={{ agentId, channelId }}
                to="/routines/new"
              />
            )}
            size="icon"
            variant="ghost"
          >
            <IconClock className="size-5" />
          </Button>
        }
      />
      <TooltipContent>Set up a routine</TooltipContent>
    </Tooltip>
  );
}
