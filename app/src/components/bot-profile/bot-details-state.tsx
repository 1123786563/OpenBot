import { Banner } from "@astryxdesign/core/Banner";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import type { AgentProfile } from "@/lib/agents/queries";
import { ClientError } from "@/lib/client";

export function botDetailsUnavailable(error: Error | null) {
  return (
    error instanceof ClientError &&
    (error.status === 403 || error.status === 404)
  );
}

export function BotDetailsState({
  query,
  children,
}: {
  query: UseQueryResult<AgentProfile>;
  children: (agent: AgentProfile) => ReactNode;
}) {
  if (botDetailsUnavailable(query.error)) {
    return (
      <Banner
        description="Open Bots to see the Bots you can access."
        role="alert"
        status="warning"
        title="This Bot was removed or is no longer shared with you"
      />
    );
  }
  if (query.isPending) {
    return <ReadStatus kind="loading" message="Loading Bot…" />;
  }
  if (!query.data) {
    return (
      <ReadError
        description="Try again to open this Bot."
        message="Couldn’t load this Bot"
        retry={() => query.refetch()}
        retryBelow
        retrying={query.isFetching}
      />
    );
  }
  return (
    <>
      {query.isRefetchError && (
        <ReadError
          description="The last loaded Bot details are shown below."
          message="Couldn’t refresh this Bot"
          retry={() => query.refetch()}
          retryBelow
          retrying={query.isFetching}
        />
      )}
      {children(query.data)}
    </>
  );
}
