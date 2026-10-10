import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPlayerStop } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cancelWorkshopTurn, type WorkshopStreamEvent } from "@/lib/workshop/client";
import { workshopSnapshotQueryOptions } from "@/lib/workshop/queries";
import { useWorkshopStream } from "@/lib/workshop/stream";
import { useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * The turn as it happens: the five event families, assembled into what a person reads.
 *
 * message_chunks concatenate into the answer being written; thoughts fold away (the model's
 * private scratchpad is a disclosure, not the product); tool calls show their shape and state;
 * progress is a badge; prompt_response is the period at the end. The stop button asks the
 * orchestrator to cancel — the stream then carries the settled turn and closes itself.
 */
export function WorkshopTurnView({
  channelId,
  botId,
}: {
  channelId: string;
  botId: string;
}) {
  const { t } = useTranslation("workshop");
  const queryClient = useQueryClient();
  const snapshot = useQuery(workshopSnapshotQueryOptions(channelId));
  const latestTurn = snapshot.data?.turns.at(-1);
  const running =
    latestTurn !== undefined &&
    (latestTurn.status === "running" || latestTurn.status === "queued");
  const [stopping, setStopping] = useState(false);

  const { events, connected } = useWorkshopStream({
    channelId,
    active: running,
  });

  const answer = useMemo(() => assembleAnswer(events), [events]);

  const stop = async () => {
    if (!latestTurn) return;
    setStopping(true);
    try {
      await cancelWorkshopTurn(channelId, latestTurn.id);
      await queryClient.invalidateQueries({
        queryKey: workshopSnapshotQueryOptions(channelId).queryKey,
      });
    } finally {
      setStopping(false);
    }
  };

  if (snapshot.data && snapshot.data.turns.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("turn.empty", { bot: botId })}
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span
            className={
              connected
                ? "size-2 shrink-0 rounded-full bg-emerald-500"
                : "size-2 shrink-0 rounded-full bg-muted-foreground/40"
            }
            aria-label={connected ? t("turn.live") : t("turn.reconnecting")}
          />
          <span className="truncate">
            {latestTurn
              ? t(`turn.status.${latestTurn.status}`)
              : t("turn.loading")}
          </span>
        </div>
        {running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={stopping}
            aria-label={t("turn.stop")}
            onClick={() => void stop()}
          >
            <IconPlayerStop className="size-3.5" />
            {stopping ? t("turn.stopping") : t("turn.stop")}
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {events.length === 0 && !running ? (
          <p className="text-sm text-muted-foreground">
            {latestTurn?.error ?? t("turn.noEvents")}
          </p>
        ) : null}
        {events.map((event) => (
          <EventLine key={event.seq} event={event} />
        ))}
        {answer ? (
          <div className="rounded-md border border-border bg-background p-3 text-sm whitespace-pre-wrap">
            {answer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The concatenated answer text the chunks have built so far. */
function assembleAnswer(events: WorkshopStreamEvent[]): string {
  return events
    .filter((event) => event.type === "message_chunk")
    .map((event) => (event.type === "message_chunk" ? event.text : ""))
    .join("");
}

function EventLine({ event }: { event: WorkshopStreamEvent }) {
  const { t } = useTranslation("workshop");
  switch (event.type) {
    case "thought":
      return (
        <details className="rounded-md border border-border/60 px-2 py-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            {t("turn.thought")}
          </summary>
          <p className="mt-1 whitespace-pre-wrap">{event.text}</p>
        </details>
      );
    case "tool_call":
      return (
        <p className="rounded-md bg-muted/50 px-2 py-1 text-xs">
          <span className="font-medium">{t("turn.tool")}</span>{" "}
          <code className="rounded bg-background px-1">{event.tool || "?"}</code>
        </p>
      );
    case "progress":
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-full bg-foreground/5 px-2 py-0.5">
            {event.label || t("turn.working")}
          </span>
        </p>
      );
    case "prompt_response":
      return (
        <p className="text-xs text-muted-foreground" role="status">
          {t("turn.done")}
        </p>
      );
    case "message_chunk":
    case "subagent":
    case "unknown":
      // The chunks render assembled in the answer box; unknown and subagent stay quiet —
      // visible in the raw stream if a developer looks, silent in the person's view.
      return null;
  }
}
