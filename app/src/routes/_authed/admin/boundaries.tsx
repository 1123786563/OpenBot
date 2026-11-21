import {
  IconChevronRight,
  IconListSearch,
  IconPlus,
  IconShieldX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ruleLabel } from "@/lib/boundaries/rules";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import { actionPolicyQueryOptions } from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/boundaries")({
  component: BoundariesPage,
});

const DESCRIPTION =
  "Define actions that Bots must never take. OpenBot checks these rules before a Bot acts on its computer or in a connected app.";

/**
 * The deployment's boundaries, read as a list of things Bots may never do.
 *
 * It used to be one screen that was also the editor: the rule language explained in a paragraph of
 * attribute names, rules shown as raw CEL, and ready-made rules drawn as buttons. Nobody could tell
 * from it what the page was for. Now each rule is a row with a name, adding one is its own screen
 * (`boundaries_.new.tsx`) and a rule opens to what it has stopped (`boundaries_.$index.tsx`).
 */
function BoundariesPage() {
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const trialSwitch = useRef<HTMLButtonElement>(null);
  const policy = stored.data;

  const addRule = (
    <Button
      render={(props) => <Link {...props} to="/admin/boundaries/new" />}
      size="sm"
      variant="ghost"
    >
      <IconPlus />
      Add rule
    </Button>
  );

  if (!policy) {
    return (
      <PageShell description={DESCRIPTION} title="Boundaries">
        {/* Nothing until the policy is known: a rule list that guesses is worse than a blank. */}
        {stored.error ? (
          <p className="text-destructive text-sm" role="alert">
            {stored.error.message}
          </p>
        ) : null}
      </PageShell>
    );
  }

  const trial = policy.mode === "dry-run";
  const allowsEverythingElse =
    policy.allow.length === 1 && policy.allow[0] === "true";

  return (
    <PageShell action={addRule} description={DESCRIPTION} title="Boundaries">
      <PageSection title="Bots may never">
        {policy.deny.length === 0 ? (
          <PageEmpty
            action={
              <Button
                render={(props) => (
                  <Link {...props} to="/admin/boundaries/new" />
                )}
                size="sm"
                variant="outline"
              >
                <IconPlus />
                Add rule
              </Button>
            }
            icon={IconShieldX}
            title="No rules yet"
          >
            Bots can do anything their own permissions allow.
          </PageEmpty>
        ) : (
          <PageRows>
            {policy.deny.map((rule, index) => {
              const label = ruleLabel(policy, rule);
              return (
                <StaggerItem index={index} key={rule}>
                  <Item
                    render={(props) => (
                      <Link
                        {...props}
                        params={{ index: String(index) }}
                        to="/admin/boundaries/$index"
                      />
                    )}
                    size="sm"
                  >
                    <ItemMedia variant="icon">
                      <IconShieldX />
                    </ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle>{label.name}</ItemTitle>
                      {label.description ? (
                        <ItemDescription>{label.description}</ItemDescription>
                      ) : (
                        // A rule nobody named is still told apart from the next by what it says.
                        <ItemDescription className="line-clamp-1 font-mono">
                          {rule}
                        </ItemDescription>
                      )}
                    </ItemContent>
                    <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </Item>
                  {index !== policy.deny.length - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}
      </PageSection>

      <PageSection title="How rules apply">
        {confirmation}
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Trial mode</ItemTitle>
              <ItemDescription>
                {trial
                  ? "On. A matching action goes ahead and is recorded in Audit, so you can see what a rule catches before it stops anything."
                  : "Off. A matching action is stopped, and the Bot is told which rule stopped it."}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Trial mode"
                checked={trial}
                disabled={savePolicy.isPending}
                ref={trialSwitch}
                onCheckedChange={(checked) => {
                  const mode = checked ? "dry-run" : "enforce";
                  requestConfirmation({
                    title: checked
                      ? "Turn on Trial mode?"
                      : "Turn off Trial mode?",
                    description: checked
                      ? "For every Bot in this deployment, matches will go ahead if otherwise permitted and be recorded in Audit. You can turn enforcement back on here."
                      : "For every Bot in this deployment, actions that match a boundary will be stopped. You can return to Trial mode here.",
                    confirmLabel: checked
                      ? "Turn on Trial mode"
                      : "Enforce boundaries",
                    pendingLabel: "Saving…",
                    failureMessage: "Couldn't update Trial mode. Try again.",
                    successMessage: checked
                      ? "Trial mode is on."
                      : "Boundaries are enforced.",
                    trigger: trialSwitch.current ?? undefined,
                    variant: "default",
                    refresh: () => stored.refetch(),
                    run: async () => {
                      const { data: latest } = await stored.refetch({
                        throwOnError: true,
                      });
                      if (
                        !latest ||
                        JSON.stringify(latest) !== JSON.stringify(policy)
                      ) {
                        throw new ActionUnavailable(
                          "The boundaries changed while you were reviewing them. Close this dialog and review the current policy.",
                        );
                      }
                      try {
                        await savePolicy.mutateAsync({
                          ...latest,
                          mode,
                          expected: latest,
                        });
                      } catch (error) {
                        const { data: verified } = await stored.refetch();
                        if (verified?.mode === mode) {
                          throw new ActionUnavailable(
                            "The new mode is in effect, but saving wasn't confirmed. Check Audit before making another change.",
                          );
                        }
                        throw error;
                      }
                    },
                  });
                }}
              />
            </ItemActions>
          </Item>
          <Separator />
          <Item
            render={(props) => <Link {...props} to="/admin/audit" />}
            size="sm"
          >
            <ItemMedia variant="icon">
              <IconListSearch />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Stopped actions</ItemTitle>
              <ItemDescription>
                In Audit, choose Blocked to see every action a rule stopped and
                which rule it was.
              </ItemDescription>
            </ItemContent>
            <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Item>
          <Separator />
          {/*
           * Read-only, and only interesting when it is not the default. Allow rules are checked after
           * the list above and an empty list refuses everything, so a deployment that narrowed them
           * in configuration needs to see that here rather than wonder why every action is refused.
           */}
          <Item size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>Everything else</ItemTitle>
              <ItemDescription
                className={allowsEverythingElse ? undefined : "font-mono"}
              >
                {allowsEverythingElse
                  ? "Allowed. A Bot can do anything no rule above stops, within its own permissions."
                  : policy.allow.length === 0
                    ? "Nothing else is allowed. Every action is refused."
                    : `Only what these allow: ${policy.allow.join(" · ")}`}
              </ItemDescription>
            </ItemContent>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
