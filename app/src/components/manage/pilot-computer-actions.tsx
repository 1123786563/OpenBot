import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DeviceAction } from "@/components/astryx-pilot/device-action";
import { DevicePage } from "@/components/astryx-pilot/device-page";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemTitle,
} from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { browserKeys } from "@/lib/browser/queries";
import { client } from "@/lib/client";
import {
  computerKeys,
  type PilotComputerLifecycle,
  pilotComputerQueryOptions,
} from "@/lib/computers/queries";

export function PilotComputerPage() {
  const lifecycle = useQuery(pilotComputerQueryOptions()).data;
  const bots = useQuery(agentListQueryOptions()).data;
  const user = useQuery(currentUserQueryOptions()).data;
  return (
    <DevicePage title="Computer">
      {lifecycle ? (
        <PilotComputerActions
          {...lifecycle}
          bots={(bots ?? []).filter(
            (bot) =>
              !bot.isolationActive &&
              (bot.visibility === "public" ||
                bot.mine ||
                user?.role === "admin"),
          )}
        />
      ) : null}
    </DevicePage>
  );
}

const actions = {
  "stop-personal": {
    label: "Stop personal computer",
    description:
      "Closes your browsers and ends all associated commands and terminals. Files and sign-ins are kept.",
    destructive: false,
  },
  "stop-execution": {
    label: "Stop Bot execution",
    description:
      "Ends this Bot’s commands and terminal. The workspace and browser stay available.",
    destructive: false,
  },
  "reset-profile": {
    label: "Reset browser profile",
    description:
      "Clears this browser profile. You’ll need to sign in again. Bot workspace files are kept.",
    destructive: true,
  },
  "clear-workspace": {
    label: "Clear workspace",
    description:
      "Ends this Bot’s execution and permanently deletes its workspace files. Browser sign-ins are kept.",
    destructive: true,
  },
};

export function PilotComputerActions({
  browserId,
  browser,
  execution,
  bots,
}: PilotComputerLifecycle & { bots: { id: string; name: string }[] }) {
  const queryClient = useQueryClient();
  const { requestConfirmation, confirmation } = useActionConfirmation();

  function button(action: keyof typeof actions, id: string, name: string) {
    const { label, description, destructive } = actions[action];
    return (
      <DeviceAction
        aria-label={`${label} for ${name}`}
        variant="outline"
        onClick={(event) =>
          requestConfirmation({
            title: `${label} for ${name}?`,
            description,
            confirmLabel: label,
            pendingLabel: "Working…",
            successMessage: `Completed for ${name}.`,
            failureMessage: `Couldn't complete this action for ${name}.`,
            variant: destructive ? "destructive" : "default",
            trigger: event.currentTarget,
            run: async () => {
              await client(
                `/api/computers/${encodeURIComponent(id)}/computers/${action}`,
                {
                  method: "POST",
                  body: destructive ? { confirmation: action } : {},
                },
              );
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: computerKeys.all }),
                queryClient.invalidateQueries({ queryKey: browserKeys.all }),
              ]);
            },
          })
        }
      >
        {label}
      </DeviceAction>
    );
  }

  return (
    <PageSection title="Your personal computer">
      {confirmation}
      <PageRows>
        {browser && execution && (
          <Item>
            <ItemContent>
              <ItemTitle>All sessions</ItemTitle>
            </ItemContent>
            <ItemActions>
              {button("stop-personal", browserId, "your OpenBot account")}
            </ItemActions>
          </Item>
        )}
        {browser && (
          <Item>
            <ItemContent>
              <ItemTitle>Your OpenBot browser</ItemTitle>
            </ItemContent>
            <ItemActions>
              {button("reset-profile", browserId, "your OpenBot browser")}
            </ItemActions>
          </Item>
        )}
        {bots.map(({ id, name }) => (
          <Item key={id}>
            <ItemContent>
              <ItemTitle>{name}</ItemTitle>
            </ItemContent>
            <ItemActions>
              {execution && button("stop-execution", id, name)}
              {browser && button("reset-profile", id, name)}
              {execution && button("clear-workspace", id, name)}
            </ItemActions>
          </Item>
        ))}
      </PageRows>
    </PageSection>
  );
}
