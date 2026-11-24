import { Text } from "@astryxdesign/core/Text";
import { IconShare } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useRef } from "react";
import { GovernanceAction } from "@/components/astryx-pilot/governance";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ClientError, canKeepCachedRead } from "@/lib/client";
import {
  decideSharedUseMutationOptions,
  describeApproval,
  type SharedUseApproval,
  type SharedUseRequest,
  type SharedUseRequestReason,
  sharedUseRequestsQueryOptions,
} from "@/lib/plugins/shared-use";

const WHY: Record<SharedUseRequestReason, string> = {
  refused_call:
    "An action was blocked. This Bot reaches more people than approved.",
  publish: "Its owner widened who can reach it.",
  trigger: "Its owner added a trigger that lets outside messages steer it.",
  grant: "It was given the app's actions.",
};

function accessSummary(approval: SharedUseApproval | null) {
  if (!approval) return "Not approved";
  const audience = describeApproval({ ...approval, outsideInput: false });
  return approval.outsideInput
    ? `${audience}. The Bot may use this account when triggered by outside events`
    : audience;
}

/**
 * Requests to use a shared account, for an administrator to approve or decline: one row each,
 * saying what is approved now against what is asked, with the decision beneath.
 */
export function SharedUseRequests() {
  const queryClient = useQueryClient();
  const me = useQuery(currentUserQueryOptions()).data;
  const isAdmin = me?.role === "admin";
  const requestOptions = sharedUseRequestsQueryOptions(isAdmin);
  const requests = useQuery(requestOptions);
  const decide = useMutation(decideSharedUseMutationOptions(queryClient));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const heading = useRef<HTMLHeadingElement>(null);
  if (!isAdmin) return null;

  const visible = canKeepCachedRead(requests.error) ? requests.data : undefined;
  const confirm = (
    request: SharedUseRequest,
    decision: "approve" | "decline",
    trigger: HTMLElement,
  ) => {
    const approving = decision === "approve";
    const label = approving ? "Approve" : "Decline";
    requestConfirmation({
      title: `${label} shared access for ${request.botName}?`,
      description: approving
        ? `${request.botName} will be allowed to use the shared ${request.title} account as requested. Requested access: ${accessSummary(request.proposed)}.`
        : `Declining this request keeps the current access to the shared ${request.title} account. Current access: ${accessSummary(request.current)}.`,
      confirmLabel: `${label} request`,
      pendingLabel: approving ? "Approving…" : "Declining…",
      successMessage: `Request ${approving ? "approved" : "declined"} for ${request.botName}.`,
      failureMessage: "Couldn't save the decision. Try again.",
      trigger,
      fallbackFocus: () => heading.current,
      variant: approving ? "default" : "destructive",
      run: async () => {
        const { data } = await requests.refetch({ throwOnError: true });
        const pending = data?.find((entry) => entry.id === request.id);
        if (!pending) {
          throw new ActionUnavailable(
            "This request is no longer awaiting a decision. Close this dialog to review the list.",
          );
        }
        if (
          JSON.stringify(pending.current) !== JSON.stringify(request.current)
        ) {
          throw new ActionUnavailable(
            "Access to this account changed while you were reviewing the request. Close this dialog and review the current access.",
          );
        }
        try {
          await decide.mutateAsync({ id: request.id, decision });
        } catch (error) {
          if (error instanceof ClientError && error.status === 409) {
            throw new ActionUnavailable(
              "This request is no longer awaiting a decision. Close this dialog to review the list.",
            );
          }
          const latest = queryClient.getQueryState(requestOptions.queryKey);
          if (
            canKeepCachedRead(error instanceof Error ? error : null) &&
            latest?.status === "success" &&
            !latest.data?.some((entry) => entry.id === request.id)
          ) {
            throw new ActionUnavailable(
              "This request is no longer in the list. The decision wasn't confirmed. Check Audit before making another change.",
            );
          }
          throw error;
        }
      },
    });
  };

  return (
    <PageSection headingRef={heading} title="Shared account requests">
      {confirmation}
      {requests.isError ? (
        <ReadError
          description={
            visible?.length
              ? "Showing the last loaded requests. Reload them to make a decision."
              : undefined
          }
          focusAfterRetry={() => heading.current}
          message="Couldn't load shared account requests."
          retry={requests.refetch}
          retryBelow
          retrying={requests.isFetching}
        />
      ) : requests.isPending ? (
        <ReadStatus kind="loading" message="Loading shared account requests…" />
      ) : visible?.length === 0 ? (
        <Text as="p" color="secondary" size="sm">
          No shared account requests awaiting review.
        </Text>
      ) : null}
      {visible?.length ? (
        <PageRows>
          {visible.map((request, index) => (
            <Fragment key={request.id}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShare />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle
                    className="line-clamp-none"
                    id={`shared-request-${request.id}`}
                  >
                    {request.botName} wants the shared {request.title} account
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {WHY[request.reason] ?? request.reason}
                  </ItemDescription>
                  <p className="text-sm">
                    Current access: {accessSummary(request.current)}
                  </p>
                  <p className="text-sm">
                    Requested access: {accessSummary(request.proposed)}
                  </p>
                </ItemContent>
                <ItemFooter
                  aria-labelledby={`shared-request-${request.id}`}
                  className="flex-wrap justify-start"
                  role="group"
                >
                  <GovernanceAction
                    className="min-h-11"
                    disabled={decide.isPending || requests.isError}
                    onClick={(event) =>
                      confirm(request, "approve", event.currentTarget)
                    }
                    label="Approve"
                  />
                  <GovernanceAction
                    className="min-h-11"
                    disabled={decide.isPending || requests.isError}
                    onClick={(event) =>
                      confirm(request, "decline", event.currentTarget)
                    }
                    label="Decline"
                    variant="outline"
                  />
                </ItemFooter>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : null}
    </PageSection>
  );
}
