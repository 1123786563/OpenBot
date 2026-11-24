import { Text } from "@astryxdesign/core/Text";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@/components/ui/item";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { clearTeamBotConsentsMutationOptions } from "@/lib/team-bots";

/**
 * A Bot someone shared with you uses its owner's connected apps unless you let it use yours on the
 * card it shows you. This forgets every one of those answers, so each such Bot asks again.
 *
 * On Approvals rather than Connections because it is an answer to "may this Bot use my apps",
 * which is the question every other row on Approvals answers, not a connection of its own.
 */
export function TeamBotConsents() {
  const capabilities = useQuery(deploymentCapabilitiesQueryOptions());
  const clear = useMutation(clearTeamBotConsentsMutationOptions());
  const { confirmation, requestConfirmation } = useActionConfirmation();
  if (capabilities.isError) {
    return (
      <ReadError
        message="Couldn't check whether shared Bot controls are available."
        retry={capabilities.refetch}
        retrying={capabilities.isFetching}
      />
    );
  }
  if (capabilities.data?.edition !== "team") return null;
  return (
    <PageSection
      description="A Bot shared with you uses its owner's apps. It uses yours only where you said yes in a conversation."
      title="Shared Bots"
    >
      <PageRows>
        <Item className="flex-wrap items-start" size="sm">
          <ItemContent className="min-w-0 basis-56">
            <ItemTitle className="line-clamp-none">
              Apps you let shared Bots use
            </ItemTitle>
            <Text as="p" color="secondary" size="sm">
              Clear saved answers so shared Bots ask again before using your
              apps.
            </Text>
          </ItemContent>
          <ItemActions>
            <Button
              className="min-h-11"
              disabled={clear.isPending}
              onClick={(event) => {
                requestConfirmation({
                  title: "Reset all shared Bot permissions?",
                  description:
                    "OpenBot will clear every answer you saved about shared Bots using your connected apps. Each shared Bot will ask again before it uses your apps.",
                  confirmLabel: "Reset all permissions",
                  pendingLabel: "Resetting…",
                  failureMessage:
                    "Couldn't reset shared Bot permissions. Try again.",
                  successMessage:
                    "Shared Bot permissions reset. Each shared Bot will ask again.",
                  trigger: event.currentTarget,
                  run: () => clear.mutateAsync(),
                });
              }}
              size="sm"
              variant="outline"
            >
              Reset permissions
            </Button>
          </ItemActions>
        </Item>
      </PageRows>
      {confirmation}
    </PageSection>
  );
}
