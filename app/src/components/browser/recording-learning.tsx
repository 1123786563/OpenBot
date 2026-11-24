import { VStack } from "@astryxdesign/core/Stack";
import type { OpenBotPersonalReview } from "@openbot/shared/direct-chat-learning";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { DirectChatLearning } from "@/components/channels/direct-chat-learning";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { personalReviewQueryOptions } from "@/lib/learning/queries";

export function RecordingLearning({
  id,
  title,
}: {
  id: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] =
    useState<OpenBotPersonalReview["conversations"][number]>();
  const review = useQuery({
    ...personalReviewQueryOptions(),
    enabled: open && !selected,
    staleTime: 0,
  });
  const conversations =
    review.data && "mode" in review.data ? review.data.conversations : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelected(undefined);
      }}
    >
      <DialogTrigger
        aria-label={`Learn from recording ${title}`}
        render={<Button size="sm" variant="outline" />}
      >
        Learn from recording
      </DialogTrigger>
      <DialogContent className="overflow-y-auto">
        {selected ? (
          <>
            <DirectChatLearning
              threadId={selected.threadId}
              agentId={selected.botId}
              conversationTitle={`${selected.botName} · ${selected.title}`}
              recording={{ id, title }}
            />
            <Button variant="outline" onClick={() => setSelected(undefined)}>
              Choose another conversation
            </Button>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Learn from {title}</DialogTitle>
              <DialogDescription>
                Choose the Bot conversation where you want to use the skill.
              </DialogDescription>
            </DialogHeader>
            <VStack gap={2}>
              {review.isError ? (
                <>
                  <p role="alert">{review.error.message}</p>
                  <Button
                    disabled={review.isFetching}
                    onClick={() => void review.refetch()}
                  >
                    Retry
                  </Button>
                </>
              ) : review.isPending ? (
                <p role="status">Loading conversations…</p>
              ) : conversations.length ? (
                conversations.map((conversation) => (
                  <Button
                    key={conversation.channelId}
                    variant="outline"
                    onClick={() => setSelected(conversation)}
                  >
                    {conversation.botName} · {conversation.title}
                  </Button>
                ))
              ) : (
                <>
                  <p>
                    Start a direct conversation with a Bot, then come back to
                    this recording.
                  </p>
                  <Button render={<Link to="/channel/new" />} variant="outline">
                    New conversation
                  </Button>
                </>
              )}
            </VStack>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
