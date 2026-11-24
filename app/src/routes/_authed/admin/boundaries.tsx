import {
  IconChevronRight,
  IconListSearch,
  IconPlus,
  IconShieldX,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ComponentRef, useRef } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { StaggerItem } from "@/components/layout/stagger";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { boundaryListSearch, ruleId, ruleLabel } from "@/lib/boundaries/rules";
import { ClientError } from "@/lib/client";
import { saveActionPolicyMutationOptions } from "@/lib/computers/mutations";
import { actionPolicyQueryOptions } from "@/lib/computers/queries";

export const Route = createFileRoute("/_authed/admin/boundaries")({
  validateSearch: boundaryListSearch,
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
  const { q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const searchInput = useRef<HTMLInputElement>(null);
  const search = (value: string) =>
    void navigate({
      search: { q: value || undefined },
      replace: true,
      resetScroll: false,
    });
  const words = q?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const queryClient = useQueryClient();
  const stored = useQuery(actionPolicyQueryOptions());
  const savePolicy = useMutation(saveActionPolicyMutationOptions(queryClient));
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const trialSwitch = useRef<ComponentRef<typeof Switch>>(null);
  const denied =
    stored.error instanceof ClientError &&
    (stored.error.status === 401 || stored.error.status === 403);
  const policy = denied ? undefined : stored.data;
  const rules =
    policy?.deny.map((rule) => ({
      rule,
      label: ruleLabel(policy, rule),
    })) ?? [];
  const matches = words.length
    ? rules.filter(({ label, rule }) => {
        const text = `${label.name} ${label.description} ${rule}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
    : rules;
  const readStatus = stored.error ? (
    <section className="mt-6">
      <ReadError
        message={
          denied ? stored.error.message : "The boundary could not be read."
        }
        description={
          policy ? "The last loaded rules are still shown." : undefined
        }
        retry={stored.refetch}
        retryBelow
        retrying={stored.isFetching}
      />
    </section>
  ) : null;

  const addRule = (
    <Button
      className="min-h-11"
      render={(props) => <Link {...props} to="/admin/boundaries/new" />}
      size="sm"
      variant="ghost"
    >
      <IconPlus />
      Add rule
    </Button>
  );

  const trial = policy?.mode === "dry-run";
  const allowsEverythingElse =
    policy?.allow.length === 1 && policy.allow[0] === "true";

  return (
    <PageShell
      action={policy?.deny.length ? addRule : undefined}
      description={DESCRIPTION}
      title="Boundaries"
    >
      {confirmation}
      {readStatus}
      {stored.isPending ? (
        <PageSection>
          <ReadStatus kind="loading" message="Loading boundaries…" />
        </PageSection>
      ) : null}
      {policy ? (
        <>
          <PageSection title="Boundary rules">
            {rules.length > 0 ? (
              <Input
                aria-label="Search boundary rules"
                className="mt-4 min-h-12"
                maxLength={200}
                onChange={(event) => search(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && q) {
                    event.preventDefault();
                    search("");
                  }
                }}
                placeholder="Search by name, description, or rule"
                ref={searchInput}
                type="search"
                value={q ?? ""}
              />
            ) : null}
            {words.length > 0 && rules.length > 0 ? (
              <p className="mt-2 text-muted-foreground text-sm" role="status">
                {matches.length} of {rules.length} rules match
              </p>
            ) : null}
            {policy.deny.length === 0 ? (
              <PageEmpty
                action={
                  <Button
                    className="min-h-11"
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
                Add a rule to define a deployment-wide boundary for Bots.
              </PageEmpty>
            ) : matches.length === 0 ? (
              <PageEmpty
                action={
                  <Button
                    className="min-h-12"
                    onClick={() => {
                      search("");
                      searchInput.current?.focus();
                    }}
                    type="button"
                    variant="outline"
                  >
                    Clear search
                  </Button>
                }
                icon={IconListSearch}
                title="No matching rules"
              />
            ) : (
              <PageRows>
                {matches.map(({ rule, label }, position) => {
                  return (
                    <StaggerItem index={position} key={rule}>
                      <Item
                        render={(props) => (
                          <Link
                            {...props}
                            params={{ index: ruleId(policy, rule) }}
                            search={{ q }}
                            to="/admin/boundaries/$index"
                          />
                        )}
                        size="sm"
                      >
                        <ItemMedia variant="icon">
                          <IconShieldX />
                        </ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="line-clamp-2 w-full [display:-webkit-box] [overflow-wrap:anywhere]">
                            {label.name}
                          </ItemTitle>
                          {label.description ? (
                            <ItemDescription className="line-clamp-3 text-sm [overflow-wrap:anywhere]">
                              {label.description}
                            </ItemDescription>
                          ) : (
                            // A rule nobody named is still told apart from the next by what it says.
                            <ItemDescription className="line-clamp-1 font-mono">
                              {rule}
                            </ItemDescription>
                          )}
                        </ItemContent>
                        <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </Item>
                      {position !== matches.length - 1 && <Separator />}
                    </StaggerItem>
                  );
                })}
              </PageRows>
            )}
          </PageSection>

          <PageSection title="How rules apply">
            <PageRows>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>Trial mode</ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    {trial
                      ? "On. OpenBot records what a boundary would refuse in Audit. The action can continue if otherwise permitted."
                      : "Off. A matching action is stopped, and the Bot is told which rule stopped it."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Trial mode"
                    checked={trial}
                    className="after:top-1/2 after:bottom-auto after:h-11 after:-translate-y-1/2"
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
                        failureMessage:
                          "Couldn't update Trial mode. Try again.",
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
                  <ItemTitle>Boundary decisions in Audit</ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    Review enforced decisions and actions that a rule would have
                    stopped in Trial mode.
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
                  <ItemDescription className="line-clamp-none text-sm [overflow-wrap:anywhere]">
                    {allowsEverythingElse
                      ? "Actions outside these boundaries are allowed within each Bot’s permissions."
                      : policy.allow.length === 0
                        ? trial
                          ? "The policy records that all actions would be refused."
                          : "The policy refuses all actions."
                        : `Allow rules: ${policy.allow.join(" · ")}`}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </PageRows>
          </PageSection>
        </>
      ) : null}
    </PageShell>
  );
}
