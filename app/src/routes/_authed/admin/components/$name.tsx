import { HStack } from "@astryxdesign/core/Stack";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconClock,
  IconCode,
  IconDatabase,
  IconFileText,
  IconTag,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { CapabilityPage } from "@/components/astryx-pilot/capability-surface";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { AdminComponentPreview } from "@/components/component-preview";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { SettingsItemBackground } from "@/components/settings/background";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
import {
  ActionIncomplete,
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { canKeepCachedRead, ClientError } from "@/lib/client";
import {
  saveComponentDraftMutationOptions,
  setComponentFunctionMutationOptions,
  setComponentGrantMutationOptions,
  setComponentPublishedMutationOptions,
} from "@/lib/components/mutations";
import {
  type ComponentRecord,
  componentListQueryOptions,
  dataFunctionsQueryOptions,
} from "@/lib/components/queries";
import { RENDERABLE_NAMES } from "@/lib/copilot/gallery-registry";

/**
 * Governance for one compiled component: publication, per-Bot grants, the model-facing description,
 * and which data functions it may read.
 */
/** The same way back from every state this route can be in. */
const BACK = {
  label: "UI components",
  linkProps: { to: "/admin/components" },
} as const;

/** "ClaimSummary" -> "Claim summary": the name a person gave it, as far as the slug holds it. */
function fallbackTitle(name: string) {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const Route = createFileRoute("/_authed/admin/components/$name")({
  component: RouteComponent,
});

function RouteComponent() {
  const { name } = Route.useParams();
  const components = useQuery(componentListQueryOptions());
  const heading = useRef<HTMLHeadingElement>(null);

  /*
   * Read out of the list rather than held in state, so a change made here is reflected here.
   */
  const component = canKeepCachedRead(components.error)
    ? components.data?.find((entry) => entry.name === name)
    : undefined;

  /*
   * Pending first, as the list page's own placeholder shape: the alternative is worse than a
   * blank — "no such component" while the list is still in flight says something false about a
   * component that is about to appear.
   */
  if (components.isPending) {
    return (
      <CapabilityPage backButton={BACK} title={fallbackTitle(name)}>
        <div
          aria-busy="true"
          aria-label="Loading"
          className="mt-8"
          role="status"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="mt-3 h-3 w-72" />
          <Skeleton className="mt-8 aspect-square w-full rounded-lg border border-border" />
        </div>
      </CapabilityPage>
    );
  }

  if (components.error && !component) {
    return (
      <CapabilityPage
        backButton={BACK}
        headingRef={heading}
        title={fallbackTitle(name)}
      >
        <ReadError
          focusAfterRetry={() => heading.current}
          message="Couldn't load this component."
          retry={components.refetch}
          retryBelow
          retryLabel="Retry component"
          retrying={components.isFetching}
        />
      </CapabilityPage>
    );
  }

  if (!component) {
    /*
     * A name in the URL is a claim, not a promise: it can be stale, mistyped, or a component this
     * build no longer ships.
     */
    return (
      <CapabilityPage
        backButton={BACK}
        description="There is no component with that name."
        title="No such component"
      >
        <Empty className="mt-12 min-h-[30dvh] border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{name}</EmptyTitle>
            <EmptyDescription className="text-pretty">
              It may have been renamed, or this deployment no longer ships it.
            </EmptyDescription>
          </EmptyHeader>
          <Button
            render={<Link to="/admin/components" />}
            size="sm"
            variant="outline"
          >
            Back to components
          </Button>
        </Empty>
      </CapabilityPage>
    );
  }

  return (
    /*
     * Keyed on the name so the draft is seeded from the component actually being looked at. The
     * route component is reused when only the parameter changes, so without it the text held from
     * the last one opened would be what a save wrote back.
     */
    <ComponentDetail
      component={component}
      components={components}
      heading={heading}
      key={component.name}
    />
  );
}

/** Which sub-dialog is open, if any. */
type Sheet = "description" | "grants" | "functions" | null;

/**
 * A row that states something and cannot be changed. No chevron, because there is nothing behind it.
 */
function FactRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      <ItemActions className="text-muted-foreground text-sm">
        {children}
      </ItemActions>
    </Item>
  );
}

/**
 * A row whose detail is a dialog. The whole row is the button, as it is in the settings screens this
 * follows — a chevron on the right announces where it goes, but it is not the only thing you can hit.
 */
function SheetRow({
  icon,
  label,
  summary,
  onOpen,
  buttonRef,
  testId,
}: {
  icon: ReactNode;
  label: string;
  summary: string;
  onOpen: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  testId: string;
}) {
  return (
    <Item
      className="w-full text-left transition-colors hover:bg-muted/50"
      /*
       * No children on the render element. `useRender` merges props, and children given here would
       * replace the row's own — which is how this first drew as three empty rows. The button takes
       * its accessible name from the title and summary inside instead.
       */
      render={
        <button
          data-testid={testId}
          onClick={onOpen}
          ref={buttonRef}
          type="button"
        />
      }
      size="sm"
    >
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{summary}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <IconChevronRight className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  );
}

/**
 * One component in full: what it is, what it looks like, what the model is told about it, and who
 * may use it.
 *
 * Settings-screen shape rather than a form. Each row states where something stands and, if it can be
 * changed, opens a dialog to change it; nothing is saved by a button at the bottom of the page,
 * because there is no page-level state to save. Publication and the grants take effect as they are
 * switched, and the description is the one thing held while it is being typed — which is why it is
 * the only dialog with a Cancel.
 */
function ComponentDetail({
  component,
  components,
  heading,
}: {
  component: ComponentRecord;
  components: UseQueryResult<ComponentRecord[]>;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const queryClient = useQueryClient();
  const botsQuery = useQuery(agentListQueryOptions());
  const functionsQuery = useQuery(dataFunctionsQueryOptions());
  const bots = botsQuery.data ?? [];
  const dataFunctions = functionsQuery.data ?? [];
  const setGrant = useMutation(setComponentGrantMutationOptions(queryClient));
  const setFunction = useMutation(
    setComponentFunctionMutationOptions(queryClient),
  );
  const setPublished = useMutation(
    setComponentPublishedMutationOptions(queryClient),
  );
  const publishDescription = useMutation(
    setComponentPublishedMutationOptions(queryClient),
  );
  const saveDraft = useMutation(saveComponentDraftMutationOptions(queryClient));
  const { confirmation, requestConfirmation } = useActionConfirmation();
  const publicationSwitch = useRef<HTMLButtonElement>(null);
  const descriptionButton = useRef<HTMLButtonElement>(null);
  const grantsHeading = useRef<HTMLHeadingElement>(null);
  const functionsHeading = useRef<HTMLHeadingElement>(null);
  const savingDraft = useRef(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState(component.draftDescription);
  const [notice, setNotice] = useState("");
  const withheld = new Set(component.withheldFrom);
  const heldFunctions = new Set(component.functions);
  const isPlaygroundComponent = component.kind === "sandboxed";
  const renderable =
    RENDERABLE_NAMES.has(component.name) || isPlaygroundComponent;
  const canWrite = renderable && components.isSuccess;
  const draftChanged = draft !== component.draftDescription;
  const descriptionMissing = draftChanged && !draft.trim();
  const publicationBusy =
    setPublished.isPending || publishDescription.isPending;

  function confirmDescriptionPublication(trigger: HTMLButtonElement) {
    /* Kept here, not in render state: the dialog keeps one `run` for every Try again. */
    let unrecorded = false;
    requestConfirmation({
      title: "Publish this description?",
      description: `Bots allowed to use ${component.title} will read the saved draft. The component stays published and Bot access stays the same.`,
      confirmLabel: "Publish description",
      pendingLabel: "Publishing…",
      failureMessage: "Couldn't publish the description. Try again.",
      successMessage: "Description published.",
      variant: "default",
      trigger,
      fallbackFocus: () => publicationSwitch.current,
      run: async () => {
        const latest = await components.refetch({ throwOnError: true });
        const current = latest.data?.find(
          (entry) => entry.name === component.name,
        );
        if (
          !current?.published ||
          current.draftDescription !== component.draftDescription
        ) {
          throw new ActionUnavailable(
            "The saved draft or publication status changed. Review the current settings and try again.",
          );
        }
        // After a save only the trail refused, nothing is left to publish: the same write records it.
        if (current.hasUnpublishedChanges || unrecorded) {
          try {
            await publishDescription.mutateAsync({
              name: component.name,
              published: true,
            });
          } catch (error) {
            // A 500 carries the server's sentence about what landed, as a boundary's does.
            if (error instanceof ClientError && error.status === 500) {
              unrecorded = true;
              throw new ActionIncomplete(error.message);
            }
            throw error;
          }
        }
      },
    });
  }

  const granted = bots.filter((bot) => !withheld.has(bot.id));
  const held = dataFunctions.filter((fn) => heldFunctions.has(fn.name));

  const grantSummary = botsQuery.isError
    ? "Couldn't check Bots"
    : botsQuery.isPending
      ? "Checking Bots…"
      : bots.length === 0
        ? "No Bots yet"
        : granted.length === bots.length
          ? `All ${bots.length} Bots`
          : granted.length === 0
            ? "No Bots"
            : `${granted.length} of ${bots.length} Bots`;

  const functionSummary = functionsQuery.isError
    ? "Couldn't check data functions"
    : functionsQuery.isPending
      ? "Checking data functions…"
      : dataFunctions.length === 0
        ? "This deployment has no data functions"
        : held.length === 0
          ? "Nothing. It shows only what the Bot passes it."
          : held.map((fn) => fn.name).join(", ");

  return (
    <CapabilityPage
      backButton={BACK}
      description={
        component.published
          ? (component.publishedDescription ?? undefined)
          : "Not published. No Bot can see it."
      }
      headingRef={heading}
      title={component.title}
    >
      {confirmation}
      {components.isError ? (
        <ReadError
          description="Showing the last loaded settings. Retry to make changes."
          focusAfterRetry={() => heading.current}
          message="Couldn't refresh this component."
          retry={components.refetch}
          retryBelow
          retryLabel="Retry component"
          retrying={components.isFetching}
        />
      ) : null}
      {notice ? (
        <p className="text-muted-foreground text-sm" role="status">
          {notice}
        </p>
      ) : null}
      {/*
       * The render at the top of the page. Bordered and rounded rather than bleeding to the edges:
       * inside a prose column that is what the tiles do, and a page has no dialog edge to reach for.
       */}
      <div className="relative mt-8 aspect-[2/1] overflow-hidden rounded-lg border border-border bg-card">
        <div className="absolute inset-0">
          <SettingsItemBackground className="h-full w-full" />
        </div>
        <div className="absolute inset-0 z-10">
          <AdminComponentPreview
            focusAfterRetry={() => heading.current}
            kind={component.kind}
            name={component.name}
          />
        </div>
      </div>

      <PageSection
        description="Describe this component and choose which Bots can display it."
        title="Configuration"
      >
        <PageRows>
          {/*
           * First, and only when it applies: a component this build cannot draw is a fact that
           * outranks everything under it, because none of it can have any effect.
           */}
          {renderable ? null : (
            <>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconAlertTriangle className="text-amber-600 dark:text-amber-400" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Not in this build</ItemTitle>
                  <ItemDescription>
                    This build cannot draw it, so the settings below have no
                    effect.
                  </ItemDescription>
                </ItemContent>
              </Item>
              <Separator />
            </>
          )}

          <Item size="sm">
            <ItemMedia variant="icon">
              <IconWorld />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Published</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {publicationBusy
                  ? "Updating publication…"
                  : !renderable
                    ? "Publication is unavailable in this build."
                    : component.published
                      ? "Bots can answer with it."
                      : "No Bot can use it."}
                {component.hasUnpublishedChanges && !isPlaygroundComponent
                  ? " A saved description draft is ready to publish."
                  : null}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {/*
               * A component this build cannot draw has no effect however it is set, so the
               * switch says so by being inert rather than contradicting the notice above it.
               */}
              <Switch
                aria-label="Published"
                checked={component.published}
                data-testid={`publish-${component.name}`}
                ref={publicationSwitch}
                disabled={!canWrite || publicationBusy || saveDraft.isPending}
                onCheckedChange={(published) =>
                  setPublished.mutate({ name: component.name, published })
                }
              />
            </ItemActions>
          </Item>
          {setPublished.isError ? (
            /*
             * The server's own sentence, which says what is already in force when the switch landed
             * and only the trail failed. Try again sends the same publication, not the opposite one:
             * the switch beside it now reads what OpenBot holds, so pressing it would undo the change.
             */
            <HStack
              gap={3}
              paddingBlock={2}
              paddingInline={4}
              vAlign="center"
              wrap="wrap"
            >
              <p className="text-destructive text-sm" role="alert">
                {setPublished.error.message}
              </p>
              <Button
                className="min-h-11"
                disabled={publicationBusy}
                onClick={() => {
                  if (setPublished.variables)
                    setPublished.mutate(setPublished.variables);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            </HStack>
          ) : null}

          <Separator />

          {isPlaygroundComponent ? (
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconFileText />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>Description</ItemTitle>
                <ItemDescription className="line-clamp-none wrap-anywhere">
                  Open {component.title} under Saved here to edit and publish
                  its draft in Playground.
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Link
                  className={buttonVariants({
                    className: "min-h-11",
                    variant: "outline",
                  })}
                  hash="playground-saved"
                  to="/admin/playground"
                >
                  Open Playground
                </Link>
              </ItemActions>
            </Item>
          ) : (
            <>
              <SheetRow
                icon={<IconFileText />}
                label="Description"
                buttonRef={descriptionButton}
                onOpen={() => {
                  saveDraft.reset();
                  setNotice("");
                  setDraft(component.draftDescription);
                  setSheet("description");
                }}
                summary={component.draftDescription || "Nothing yet"}
                testId={`description-${component.name}`}
              />
              {component.published && component.hasUnpublishedChanges ? (
                <Item size="sm">
                  <Button
                    className="min-h-11"
                    disabled={
                      !canWrite || publicationBusy || saveDraft.isPending
                    }
                    onClick={(event) =>
                      confirmDescriptionPublication(event.currentTarget)
                    }
                    type="button"
                    variant="outline"
                  >
                    Publish description
                  </Button>
                </Item>
              ) : null}
            </>
          )}

          <Separator />

          <SheetRow
            icon={<IconUsers />}
            label="Available to"
            onOpen={() => setSheet("grants")}
            summary={grantSummary}
            testId={`grants-${component.name}`}
          />

          <Separator />

          <SheetRow
            icon={<IconDatabase />}
            label="Can read"
            onOpen={() => setSheet("functions")}
            summary={functionSummary}
            testId={`functions-${component.name}`}
          />
        </PageRows>
      </PageSection>

      <PageSection title="Details">
        <PageRows>
          <FactRow icon={<IconTag />} label="Kind">
            {component.kind}
          </FactRow>
          <Separator />
          <FactRow icon={<IconCode />} label="Called as">
            <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs">
              {component.name}
            </code>
          </FactRow>
          <Separator />
          <FactRow icon={<IconClock />} label="Last changed">
            {new Date(component.updatedAt).toLocaleString()}
            {component.updatedBy ? ` by ${component.updatedBy}` : null}
          </FactRow>
        </PageRows>
      </PageSection>

      {/*
       * The one dialog holding state of its own, so the one with something to discard. The draft is
       * reset on close either way, so reopening reads what is actually stored rather than what was
       * abandoned.
       */}
      <SettingsDraftDialog
        title="Description"
        description="Bots read the published description when deciding whether to use this component. Save your draft, then publish it from Configuration."
        open={sheet === "description"}
        dirty={draftChanged}
        saving={saveDraft.isPending}
        opener={descriptionButton}
        onClose={() => setSheet(null)}
        action={
          <Button
            className="min-h-11"
            disabled={
              !draftChanged ||
              !draft.trim() ||
              !canWrite ||
              saveDraft.isPending ||
              publicationBusy
            }
            onClick={async () => {
              if (savingDraft.current) return;
              savingDraft.current = true;
              try {
                await saveDraft.mutateAsync({
                  name: component.name,
                  description: draft,
                });
                setNotice("Description draft saved.");
                setSheet(null);
              } catch {
                // The dialog shows the mutation error beside the preserved draft.
              } finally {
                savingDraft.current = false;
              }
            }}
            type="button"
          >
            {saveDraft.isPending ? "Saving draft…" : "Save draft"}
          </Button>
        }
      >
        <Textarea
          aria-describedby={
            descriptionMissing ? "component-description-error" : undefined
          }
          aria-invalid={descriptionMissing}
          aria-label="Description"
          onChange={(event) => setDraft(event.target.value)}
          readOnly={!canWrite || saveDraft.isPending}
          rows={6}
          value={draft}
        />
        {descriptionMissing ? (
          <p
            className="mt-3 text-destructive text-sm"
            id="component-description-error"
          >
            Enter a description before saving.
          </p>
        ) : null}
        {saveDraft.isError ? (
          <p className="mt-3 text-destructive text-sm" role="alert">
            Couldn't save this description. Your draft is still here.
          </p>
        ) : null}
      </SettingsDraftDialog>

      {/* Grants take effect as they are switched, so there is nothing here to save or to discard. */}
      <Dialog
        onOpenChange={(open, event) => {
          if (open) return;
          if (setGrant.isPending) event.cancel();
          else setSheet(null);
        }}
        open={sheet === "grants"}
      >
        <DialogContent {...astryxScope}>
          <DialogHeader>
            <DialogTitle ref={grantsHeading} tabIndex={-1}>
              Available to
            </DialogTitle>
            <DialogDescription>
              {renderable
                ? "Turn a Bot off to withhold this component from it."
                : "This build cannot draw this component. You can review the saved settings."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {botsQuery.isPending ? (
              <ReadStatus kind="loading" message="Loading Bots…" />
            ) : botsQuery.isError ? (
              <ReadError
                focusAfterRetry={() => grantsHeading.current}
                message="Couldn't load Bots."
                retry={botsQuery.refetch}
                retryBelow
                retryLabel="Retry Bots"
                retrying={botsQuery.isFetching}
              />
            ) : bots.length === 0 ? (
              <p className="text-muted-foreground text-sm">No Bots yet.</p>
            ) : (
              <div className="flex flex-col">
                {bots.map((bot, index) => {
                  const has = !withheld.has(bot.id);
                  return (
                    <div key={bot.id}>
                      {index === 0 ? null : <Separator />}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{bot.name}</ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          <Switch
                            aria-label={bot.name}
                            checked={has}
                            data-testid={`grant-${component.name}-${bot.id}`}
                            disabled={!canWrite || setGrant.isPending}
                            onCheckedChange={(next) =>
                              setGrant.mutate({
                                name: component.name,
                                agentId: bot.id,
                                granted: next,
                              })
                            }
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  );
                })}
              </div>
            )}
            {setGrant.isError ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                Couldn't change Bot access. Try the switch again.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              className="min-h-11"
              disabled={setGrant.isPending}
              onClick={() => setSheet(null)}
              size="sm"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open, event) => {
          if (open) return;
          if (setFunction.isPending) event.cancel();
          else setSheet(null);
        }}
        open={sheet === "functions"}
      >
        <DialogContent {...astryxScope}>
          <DialogHeader>
            <DialogTitle ref={functionsHeading} tabIndex={-1}>
              Can read
            </DialogTitle>
            <DialogDescription>
              The data this component can fetch to draw itself. This is separate
              from Available to. With all of these off, it shows only what the
              Bot passes it. Every read shows in Audit.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            {functionsQuery.isPending ? (
              <ReadStatus kind="loading" message="Loading data functions…" />
            ) : functionsQuery.isError ? (
              <ReadError
                focusAfterRetry={() => functionsHeading.current}
                message="Couldn't load data functions."
                retry={functionsQuery.refetch}
                retryBelow
                retryLabel="Retry data functions"
                retrying={functionsQuery.isFetching}
              />
            ) : dataFunctions.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                This deployment has no data functions.
              </p>
            ) : (
              <div className="flex flex-col">
                {dataFunctions.map((fn, index) => {
                  const has = heldFunctions.has(fn.name);
                  return (
                    <div key={fn.name}>
                      {index === 0 ? null : <Separator />}
                      <Item size="sm">
                        <ItemContent>
                          <ItemTitle>{fn.name}</ItemTitle>
                          <ItemDescription>{fn.description}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Switch
                            aria-label={fn.name}
                            checked={has}
                            data-testid={`function-${component.name}-${fn.name}`}
                            disabled={!canWrite || setFunction.isPending}
                            onCheckedChange={(next) =>
                              setFunction.mutate({
                                name: component.name,
                                functionName: fn.name,
                                granted: next,
                              })
                            }
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  );
                })}
              </div>
            )}
            {setFunction.isError ? (
              <p className="mt-3 text-destructive text-sm" role="alert">
                Couldn't change data access. Try the switch again.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              className="min-h-11"
              disabled={setFunction.isPending}
              onClick={() => setSheet(null)}
              size="sm"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </CapabilityPage>
  );
}
