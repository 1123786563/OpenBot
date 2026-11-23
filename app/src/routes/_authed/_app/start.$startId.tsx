import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Stack } from "@astryxdesign/core/Stack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  ConversationIntro,
  ConversationIntroPlaceholder,
} from "@/components/channels/conversation-intro";
import {
  ConversationLoading,
  ConversationReadError,
} from "@/components/channels/conversation-status";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import { agentListQueryOptions, agentQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import type { BillingQuote } from "@/lib/billing/queries";
import { readPendingStart } from "@/lib/channels/pending-start";
import { CoworkerRoutingQuoteRequired } from "@/lib/channels/route";
import { resumeConversationStart } from "@/lib/channels/start";

export const Route = createFileRoute("/_authed/_app/start/$startId")({
  component: RouteComponent,
});

function RouteComponent() {
  const { startId } = Route.useParams();
  const { data: user } = useQuery(currentUserQueryOptions());
  return user ? (
    <StartHandoff
      owner={user.id}
      startId={startId}
      key={`${user.id}:${startId}`}
    />
  ) : null;
}

function StartHandoff({ owner, startId }: { owner: string; startId: string }) {
  const queryClient = useQueryClient();
  const [start, setStart] = useState(() => readPendingStart(owner, startId));
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [quote, setQuote] = useState<BillingQuote>();
  const [confirmation, setConfirmation] =
    useState<Pick<BillingQuote, "route" | "priceVersion">>();

  const hasStart = start?.state === "pending";
  useEffect(() => {
    // This state is intentionally a retry trigger. The effect must restart when the user taps Retry.
    void attempt;
    if (!hasStart) return;
    let current = true;
    void resumeConversationStart(
      queryClient,
      owner,
      startId,
      (next) => {
        if (current) setStart(next);
      },
      confirmation,
    ).then(
      (next) => {
        if (current) setStart(next);
      },
      (cause: unknown) => {
        if (!current) return;
        setStart(readPendingStart(owner, startId));
        if (cause instanceof CoworkerRoutingQuoteRequired) {
          setQuote(cause.quote);
          return;
        }
        setError(
          cause instanceof Error
            ? cause.message
            : "Try again to continue with your saved message.",
        );
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, confirmation, hasStart, owner, queryClient, startId]);

  const draft = hasStart ? start.draft : undefined;
  const agentId =
    draft?.recipient.kind === "direct" ? draft.recipient.agentId : undefined;
  const roster = useQuery(agentListQueryOptions());
  const listed = roster.data?.find((agent) => agent.id === agentId);
  const fetched = useQuery({
    ...agentQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId) && roster.data !== undefined && !listed,
  });
  const bot = listed ?? fetched.data;

  if (start?.state === "finished") {
    return start.group ? (
      <Navigate
        params={{ channelId: start.channelId }}
        replace
        to="/group/$channelId"
      />
    ) : (
      <Navigate
        params={{ channelId: start.channelId }}
        replace
        to="/channel/$channelId"
      />
    );
  }
  if (
    start?.state === "pending" &&
    start.draft.recipient.kind === "direct" &&
    start.progress.phase !== "creating"
  ) {
    return (
      <Navigate
        params={{ channelId: start.progress.channelId }}
        replace
        to="/channel/$channelId"
      />
    );
  }

  return (
    <Stack className="flex-1" minHeight={0}>
      <Stack
        direction="horizontal"
        align="center"
        justify="between"
        paddingInline={3}
        paddingBlock={2}
        gap={3}
        data-slot="conversation-header"
      >
        <Stack
          direction="horizontal"
          align="center"
          gap={2}
          className="min-w-0"
        >
          <SidebarToggle />
          {agentId ? (
            <ChannelAvatar participantIds={[agentId]} size={22} />
          ) : null}
          <h1 className="min-w-0 text-sm truncate">
            {bot?.name ?? "New conversation"}
          </h1>
        </Stack>
        <Link to="/">Back to Home</Link>
      </Stack>
      {start?.state === "pending" && draft ? (
        <ConversationView
          disabled
          intro={
            bot ? (
              <ConversationIntro agent={bot} />
            ) : (
              <ConversationIntroPlaceholder />
            )
          }
          messages={[seedMessage(draft.text, startId)]}
          notice={
            quote ? (
              <Banner
                status="info"
                title="Use Test Credits to pick a Bot?"
                description={`${quote.provider}/${quote.model} charges ${quote.price.inputPerMillion} input and ${quote.price.outputPerMillion} output microcredits per million tokens. Maximum ${quote.maxChargeMicrocredits} microcredits for routing. ${quote.usageDisclosure} Your conversation has a separate quote.`}
                endContent={
                  <Button
                    label="Confirm routing"
                    onClick={() => {
                      setConfirmation({
                        route: quote.route,
                        priceVersion: quote.priceVersion,
                      });
                      setQuote(undefined);
                      setAttempt((value) => value + 1);
                    }}
                  />
                }
              />
            ) : error ? (
              <ConversationReadError
                title="Couldn't continue the conversation."
                description={error}
                retry={() => {
                  setError(null);
                  setAttempt((value) => value + 1);
                }}
                retrying={false}
              />
            ) : (
              <ConversationLoading
                label={
                  draft.recipient.kind === "route"
                    ? "Picking a Bot…"
                    : start.progress.phase === "creating"
                      ? "Creating conversation…"
                      : "Checking the first message…"
                }
              />
            )
          }
          onSubmit={() => undefined}
        />
      ) : (
        <Banner
          status="warning"
          title="This conversation start is unavailable."
          description="Starts can be recovered in the browser where they were submitted."
          endContent={<Link to="/channel/new">New conversation</Link>}
        />
      )}
    </Stack>
  );
}
