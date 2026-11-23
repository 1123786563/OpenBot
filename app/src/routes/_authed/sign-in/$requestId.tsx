import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type ComponentProps, useEffect, useId, useRef, useState } from "react";
import { PageShell } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SignInFields } from "@/components/passwords/sign-in-form";
import { agentQueryOptions } from "@/lib/agents/queries";
import { channelListQueryOptions } from "@/lib/channels/queries";
import { ClientError } from "@/lib/client";
import {
  type SignInRequest,
  type SignInStatus,
  signInRequestQueryOptions,
} from "@/lib/passwords/queries";
import { cn } from "@/lib/utils";

const UNAVAILABLE = [400, 401, 403, 404, 410];
const PAGE_TITLE = "Sign in for your Bot";

const CLOSED = {
  pending: null,
  filling: null,
  code_required: null,
  taken_over: null,
  expired: {
    title: "This sign-in link expired",
    description:
      "Return to the conversation and ask your Bot to try again. If it still needs access, it can send a fresh link.",
  },
  cancelled: {
    title: "This sign-in was cancelled",
    description: "Return to the conversation to continue with your Bot.",
  },
  failed: {
    title: "This sign-in didn’t finish",
    description:
      "Return to the conversation and ask your Bot to try the task again.",
  },
  signed_in: {
    title: "Signed in",
    description: "Return to the conversation to see your Bot’s progress.",
  },
} satisfies Record<SignInStatus, { title: string; description: string } | null>;

function isUnavailable(error: unknown) {
  return error instanceof ClientError && UNAVAILABLE.includes(error.status);
}

/**
 * The private sign-in form, on a page of its own.
 *
 * Its own route, outside the chat layout, because this is where a link sent to Slack, SMS or a phone
 * lands: a person can answer a Bot that is working unattended without opening its conversation, and
 * nothing typed here is ever part of one.
 */
export const Route = createFileRoute("/_authed/sign-in/$requestId")({
  component: SignInPage,
});

function SignInPage() {
  const { requestId } = Route.useParams();
  return (
    <VStack as="main" style={{ flex: 1, minHeight: 0 }}>
      <SignInRequestPage key={requestId} requestId={requestId} />
    </VStack>
  );
}

function SignInRequestPage({ requestId }: { requestId: string }) {
  const [retrying, setRetrying] = useState(false);
  const request = useQuery({
    ...signInRequestQueryOptions(requestId),
    retry: (failureCount, error) => failureCount < 1 && !isUnavailable(error),
    refetchInterval: ({ state }) =>
      state.data && !isUnavailable(state.error) && !CLOSED[state.data.status]
        ? 3_000
        : false,
  });

  if (isUnavailable(request.error)) {
    return (
      <SignInRecovery
        title="This sign-in link is unavailable"
        description="Open your workspace to find the conversation and ask your Bot for a fresh private sign-in link."
      />
    );
  }
  if (!request.data && (retrying || request.isError)) {
    return (
      <PageShell title={PAGE_TITLE}>
        <VStack gap={3} hAlign="start">
          <ReadError
            message="We couldn’t check this sign-in link"
            description="Check your connection and try again."
            retry={async () => {
              setRetrying(true);
              try {
                await request.refetch();
              } finally {
                setRetrying(false);
              }
            }}
            retrying={retrying || request.isFetching}
            retryBelow
          />
          <Button
            as={WorkspaceLink}
            className="min-h-11"
            href="/"
            label="Open workspace"
            variant="ghost"
          />
        </VStack>
      </PageShell>
    );
  }

  if (!request.data || (request.isFetching && !request.isFetchedAfterMount)) {
    return (
      <PageShell title={PAGE_TITLE}>
        <ReadStatus kind="loading" message="Checking this sign-in link…" />
      </PageShell>
    );
  }

  const { data } = request;
  const closed = CLOSED[data.status];
  if (closed) {
    return <SignInRecovery {...closed} threadId={data.threadId} />;
  }
  return <ActiveSignIn request={data} refreshFailed={request.isRefetchError} />;
}

function ActiveSignIn({
  request,
  refreshFailed,
}: {
  request: SignInRequest;
  refreshFailed: boolean;
}) {
  const { data: bot } = useQuery(agentQueryOptions(request.botId));
  return (
    <PageShell
      title={PAGE_TITLE}
      description={
        <>
          <Text
            color="inherit"
            type="inherit"
            weight="semibold"
            wordBreak="break-word"
          >
            {request.origin}
          </Text>
          <br />
          <Text color="inherit" type="inherit" wordBreak="break-word">
            {bot?.name ?? "Your Bot"} needs access to continue.
            {request.reason ? ` ${request.reason}` : ""}
          </Text>{" "}
          Enter passwords and verification codes only on this private page.
        </>
      }
    >
      {refreshFailed ? (
        <Text as="p" color="secondary" role="status">
          Couldn’t refresh this sign-in. We’ll keep checking.
        </Text>
      ) : null}
      <SignInFields requestId={request.id} data={request} />
    </PageShell>
  );
}

function WorkspaceLink({ href: _href, ...props }: ComponentProps<"a">) {
  return <Link {...props} to="/" />;
}

function SignInRecovery({
  title,
  description,
  threadId,
}: {
  title: string;
  description: string;
  threadId?: string | null;
}) {
  const recovery = useRef<HTMLElement>(null);
  const descriptionId = useId();
  const router = useRouter();
  const roster = useInfiniteQuery({
    ...channelListQueryOptions(),
    enabled: Boolean(threadId),
  });
  const channel =
    threadId && roster.isSuccess && roster.isFetchedAfterMount
      ? roster.data.find((entry) => entry.threadId === threadId)
      : undefined;
  const conversationHref = channel
    ? router.buildLocation({
        to:
          channel.agentIds.length > 1
            ? "/group/$channelId"
            : "/channel/$channelId",
        params: { channelId: channel.id },
      }).href
    : undefined;

  useEffect(() => {
    if (document.activeElement === document.body) {
      recovery.current?.focus();
    }
  }, []);

  return (
    <PageShell title={title}>
      <VStack
        aria-label={title}
        aria-describedby={descriptionId}
        as="section"
        gap={4}
        hAlign="start"
        className="p-3"
        ref={recovery}
        tabIndex={-1}
      >
        <Text as="p" color="secondary" id={descriptionId}>
          {description}
        </Text>
        <HStack gap={2} wrap="wrap">
          {conversationHref ? (
            <Button
              className="min-h-11 rounded-lg! bg-primary! px-4! text-primary-foreground! hover:bg-primary/90!"
              href={conversationHref}
              label="Return to conversation"
              size="lg"
              variant="primary"
            />
          ) : null}
          <Button
            className={cn(
              "min-h-11 rounded-lg! px-4!",
              conversationHref
                ? "border border-border! bg-background! text-foreground! hover:bg-muted!"
                : "bg-primary! text-primary-foreground! hover:bg-primary/90!",
            )}
            as={WorkspaceLink}
            href="/"
            label="Open workspace"
            size="lg"
            variant={conversationHref ? "secondary" : "primary"}
          />
        </HStack>
      </VStack>
    </PageShell>
  );
}
