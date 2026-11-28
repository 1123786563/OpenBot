import { VStack } from "@astryxdesign/core/VStack";
import {
  IconBrain,
  IconChartBar,
  IconChevronRight,
  IconCloud,
  IconCube,
  IconKey,
  IconSearch,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { HarnessMark } from "@/components/agents/harness-mark";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { useActionConfirmation } from "@/components/ui/action-confirmation";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { modelUsageQueryOptions } from "@/lib/enterprise/queries";
import { markFor } from "@/lib/marks";
import { effortLabel } from "@/lib/models/effort";
import {
  availableModelsQueryOptions,
  type ModelOption,
  type ModelSource,
} from "@/lib/models/queries";
import { DeploymentButton } from "../deployment-button";
import { ControlsSection } from "./controls-section";

/** Placeholder rows while usage loads: enough to fill the view, not to suggest a count. */
const LOADING_ROWS = ["a", "b", "c", "d"];

/** Who serves the models, by the name an admin knows it by. */
const SOURCE_NAMES: Record<ModelSource, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  gateway: "OpenAI-compatible endpoint",
  chatgpt: "ChatGPT plan",
  claude: "Claude plan",
};

/**
 * The mark that stands beside a source, from `shared/marks`. A Claude plan is Claude's own; a
 * ChatGPT plan is OpenAI's, whose mark ChatGPT itself uses. An endpoint is nobody's, so that row
 * gets a plain icon. Nothing is drawn to stand in for a missing mark.
 */
const SOURCE_VENDORS: Partial<Record<ModelSource, string>> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "xai",
  chatgpt: "openai",
  claude: "claude",
};

/**
 * Admin, Providers: what serves the models built-in Bots run on. One today, read from the
 * deployment's configuration; a row each once a deployment can hold more than one.
 */
export function ProviderSection() {
  const available = useQuery(availableModelsQueryOptions());
  const { data, isFetching, refetch, isSuccess } = available;
  const name = data ? (SOURCE_NAMES[data.source] ?? data.source) : null;
  const vendor = data ? SOURCE_VENDORS[data.source] : undefined;
  return (
    <PageSection
      description="Built-in Bots and the framework picked at setup run on models from this provider."
      title="Connected"
    >
      {available.isPending && available.errorUpdateCount === 0 ? (
        <div aria-busy="true" aria-label="Loading the provider" role="status">
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <Skeleton className="size-full" />
              </ItemMedia>
              <ItemContent className="gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-56" />
              </ItemContent>
            </Item>
          </PageRows>
        </div>
      ) : !isSuccess ? (
        <ReadError
          message="Couldn't load the provider."
          retry={refetch}
          retrying={isFetching}
          retryBelow
        />
      ) : (
        <VStack gap={3}>
          <PageRows>
            <Item size="sm">
              {vendor && name && markFor(vendor) ? (
                <ItemMedia>
                  <HarnessMark id={vendor} name={name} />
                </ItemMedia>
              ) : (
                <ItemMedia variant="icon">
                  <IconCloud />
                </ItemMedia>
              )}
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription className="line-clamp-none wrap-anywhere text-sm">
                  {data.listed
                    ? `Default ${data.default} · ${data.models.length} models listed`
                    : `Default ${data.default}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
          {!data.listed ? (
            <ReadError
              description="The configured default is available. OpenBot checks the provider periodically."
              message="Couldn't list the provider's models."
              retry={refetch}
              retrying={isFetching}
              retryLabel="Check again"
              retryBelow
            />
          ) : null}
        </VStack>
      )}
    </PageSection>
  );
}

/**
 * Admin, Providers: what people pick from in a conversation. Everything the credential lists for
 * one person on their own machine; in a team, the models allowed below, and until there are any,
 * the default only. No switch: what is allowed says it.
 */
export function ModelChoiceSection() {
  const available = useQuery(availableModelsQueryOptions());
  return (
    <ControlsSection
      description={() => {
        const data = available.data;
        if (!data) return "Which models people can pick in each conversation.";
        if (!data.listed)
          return `The configured default is ${data.default}. The complete list of choices depends on the provider's catalogue.`;
        return data.exposure === "all"
          ? `People can pick any model your provider lists, and its thinking level, in each conversation. Bots run on ${data.default} until somebody picks another.`
          : `People pick among the models you allow below. The default is ${data.default}. Only allowed models can block a run on the default too.`;
      }}
      readErrorMessage={false}
      title="In conversations"
    >
      {({ data }) => {
        const listing = available.data;
        if (!listing)
          return available.isError ? null : (
            <div aria-busy="true" aria-label="Loading models" role="status">
              <PageRows>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Skeleton className="size-full" />
                  </ItemMedia>
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </ItemContent>
                </Item>
              </PageRows>
            </div>
          );
        const allowed = data.settings.modelAllowlist.models.filter((name) =>
          listing.models.some(
            (model) => `${listing.provider}/${model.id}` === name,
          ),
        ).length;
        return (
          <PageRows>
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBrain />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {!listing.listed
                    ? "Model choices unconfirmed"
                    : listing.exposure === "all"
                      ? "Every listed model"
                      : allowed === 0
                        ? "No models allowed yet"
                        : `${allowed} ${allowed === 1 ? "model" : "models"} allowed`}
                </ItemTitle>
                <ItemDescription className="line-clamp-none text-base">
                  {!listing.listed
                    ? "Check the provider above to see which models people can pick."
                    : listing.exposure === "all"
                      ? `${listing.models.length} models, kept current from your provider.`
                      : allowed === 0
                        ? "People don't see a model picker. Allow models below to offer them."
                        : "People see them in the composer's model picker, with the default."}
                </ItemDescription>
              </ItemContent>
            </Item>
          </PageRows>
        );
      }}
    </ControlsSection>
  );
}

/** What the allowed-models row says: the models themselves, the first few by name. */
export function allowedSummary(models: readonly string[]): string {
  if (models.length === 0) return "None listed";
  if (models.length <= 3) return models.join(", ");
  return `${models.slice(0, 3).join(", ")} and ${models.length - 3} more`;
}

/** Admin, Providers: the allowlist every Bot's model is checked against. */
export function ModelAllowlistSection() {
  /*
   * Turning the guard off lets every model through, the remote Bots' own included, so that
   * direction asks; turning it on only narrows and stays immediate.
   */
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const guardSwitch = useRef<HTMLElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const closeEditor = () => {
    setOpen(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  return (
    <ControlsSection
      description="The models people may pick in each conversation. With Only allowed models on, a Bot on any other model is refused before it runs, and a remote Bot's own model is checked too."
      readErrorMessage={false}
      title="Allowed models"
    >
      {({ data, setSetting, setSettingAsync, saving }) => {
        const { modelAllowlist } = data.settings;
        return (
          <>
            {saved ? <p role="status">Allowed models saved</p> : null}
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldLock />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Only allowed models</ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    {modelAllowlist.enabled
                      ? "Bots can only run on the models listed below."
                      : "Off. Runs on other models, a remote Bot's own included, aren't refused."}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Switch
                    aria-label="Only allowed models"
                    className="after:-inset-y-4"
                    checked={modelAllowlist.enabled}
                    disabled={saving}
                    ref={guardSwitch}
                    onCheckedChange={(enabled) => {
                      if (enabled) {
                        setSetting("modelAllowlist", {
                          ...modelAllowlist,
                          enabled,
                        });
                        return;
                      }
                      requestConfirmation({
                        title: "Turn Only allowed models off?",
                        description:
                          "Bots could then run on any model the provider lists, and on a remote Bot's own model.",
                        confirmLabel: "Turn off",
                        pendingLabel: "Turning off…",
                        failureMessage:
                          "Couldn't turn the guard off. Try again.",
                        variant: "destructive",
                        trigger: guardSwitch.current ?? undefined,
                        run: async () => {
                          await setSettingAsync("modelAllowlist", {
                            ...modelAllowlist,
                            enabled: false,
                          });
                        },
                      });
                    }}
                  />
                </ItemActions>
              </Item>
              <Separator />
              <Item
                render={
                  <button
                    onClick={() => {
                      setSaved(false);
                      setOpen(true);
                    }}
                    ref={editButton}
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconKey />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Allowed models</ItemTitle>
                  <ItemDescription className="line-clamp-none wrap-anywhere text-sm">
                    {allowedSummary(modelAllowlist.models)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </PageRows>
            {/* A fresh draft on each open, from the latest saved allowlist. */}
            {open ? (
              <AllowedModelsDialog
                builtInModel={data.builtInModel}
                initial={modelAllowlist.models}
                onClose={closeEditor}
                onSave={async (models) => {
                  await setSettingAsync("modelAllowlist", {
                    ...modelAllowlist,
                    models,
                  });
                  setSaved(true);
                }}
                open
              />
            ) : null}
            {confirmation}
          </>
        );
      }}
    </ControlsSection>
  );
}

/** `provider/model`, the spelling the allowlist and the usage view share. */
const FULL_NAME = /^[^\s/]+\/\S+$/;

/**
 * Pick the allowed models from what the provider or gateway lists, newest first, with the
 * deployment's own model marked. A model the listing does not have (a remote Bot's own, say) is
 * added by its full name and listed with the rest.
 */
export function AllowedModelsDialog({
  open,
  initial,
  builtInModel,
  onSave,
  onClose,
}: {
  open: boolean;
  /** As stored: `provider/model`. */
  initial: readonly string[];
  /** The deployment's model, as `provider/model`. */
  builtInModel: string | null;
  /** Resolves when the allowlist is saved; rejects when the write failed. */
  onSave: (models: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const modelIdHelp = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const saveErrorMessage = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (saveError) saveErrorMessage.current?.focus();
  }, [saveError]);
  const available = useQuery({
    ...availableModelsQueryOptions(),
    enabled: open,
  });
  /*
   * Recent runs per model, so a model somebody is about to un-allow says what that would disturb:
   * the roster carries no per-Bot model, but the runs it served are a fact, and said on the row
   * they land beside the choice rather than after it.
   */
  const usage = useQuery({ ...modelUsageQueryOptions(30), enabled: open });
  const runsByModel = new Map(
    (usage.data?.summary ?? []).map((row) => [row.model, row.runs]),
  );
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [search, setSearch] = useState("");
  const [other, setOther] = useState("");

  const listed: { name: string; label: string; model?: ModelOption }[] = (
    available.data?.models ?? []
  ).map((model) => ({
    name: `${available.data?.provider}/${model.id}`,
    label: model.label,
    model,
  }));
  const listedNames = new Set(listed.map((model) => model.name));
  // The default as the list says it today: the operator's model, or the middle of the line.
  const defaultName = available.data
    ? `${available.data.provider}/${available.data.default}`
    : builtInModel;
  // Saved models the listing no longer (or never) had, so they can still be seen and removed.
  const extra: { name: string; label: string; model?: ModelOption }[] = selected
    .filter((name) => !listedNames.has(name))
    .map((name) => ({ name, label: name }));
  const needle = search.trim().toLowerCase();
  const rows = [...extra, ...listed].filter(
    (model) =>
      !needle ||
      model.label.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle),
  );
  const toggle = (name: string, on: boolean) =>
    setSelected((current) =>
      on
        ? [...current.filter((entry) => entry !== name), name]
        : current.filter((entry) => entry !== name),
    );
  const otherName = other.trim();
  const otherValid = FULL_NAME.test(otherName);

  return (
    <Dialog
      onOpenChange={(next, event) => {
        if (!next && saving) {
          event.cancel();
          return;
        }
        if (!next) onClose();
      }}
      open={open}
    >
      <DialogContent
        {...astryxScope}
        className="astryx-admin-dialog"
        showCloseButton={!saving}
      >
        <DialogHeader>
          <DialogTitle>Allowed models</DialogTitle>
        </DialogHeader>
        <DialogBody className="mt-4 flex flex-col gap-3 overflow-y-auto">
          <Input
            aria-label="Search models"
            className="min-h-11"
            disabled={saving}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models"
            ref={searchInput}
            value={search}
          />
          {available.isPending && available.errorUpdateCount === 0 ? (
            <ReadStatus kind="loading" message="Loading provider models…" />
          ) : !available.isSuccess ? (
            <ReadError
              description="You can still review saved choices and add a model by its full name."
              focusAfterRetry={() => searchInput.current}
              message="Couldn't load provider models."
              retry={available.refetch}
              retrying={available.isFetching}
              retryBelow
            />
          ) : !available.data.listed ? (
            <ReadError
              description="You can still review saved choices and add a model by its full name. OpenBot checks the provider periodically."
              focusAfterRetry={() => searchInput.current}
              message="Couldn't list the provider's models."
              retry={available.refetch}
              retrying={available.isFetching}
              retryLabel="Check again"
              retryBelow
            />
          ) : null}
          {rows.length === 0 ? (
            available.data?.listed ? (
              <PageEmpty icon={IconSearch} title="No matches" />
            ) : null
          ) : (
            <VStack>
              {rows.map((model) => {
                const isSelected = selected.includes(model.name);
                const runs = runsByModel.get(model.name);
                const details = [
                  model.label !== model.name ? model.name : null,
                  model.name === defaultName ? "default" : null,
                  model.model?.efforts?.length
                    ? `Thinking: ${model.model.efforts.map(effortLabel).join(", ")}`
                    : null,
                  runs !== undefined && !isSelected
                    ? `${runs} ${runs === 1 ? "run" : "runs"} in the last 30 days`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <Item key={model.name} size="sm" variant="muted">
                    {/* The same mark the composer's picker draws, or its plain model icon. */}
                    <ItemMedia>
                      {model.model?.vendor && markFor(model.model.vendor) ? (
                        <HarnessMark
                          className="size-4"
                          id={model.model.vendor}
                          name={model.label}
                        />
                      ) : (
                        <IconCube
                          aria-hidden
                          className="size-4 text-muted-foreground"
                        />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="wrap-anywhere">
                        {model.label}
                      </ItemTitle>
                      {details ? (
                        <ItemDescription className="line-clamp-none wrap-anywhere text-sm">
                          {details}
                        </ItemDescription>
                      ) : null}
                    </ItemContent>
                    <ItemActions>
                      <Checkbox
                        aria-label={`Allow ${model.label}`}
                        className="relative after:absolute after:-inset-4"
                        checked={isSelected}
                        disabled={saving}
                        onCheckedChange={(checked) =>
                          toggle(model.name, checked === true)
                        }
                      />
                    </ItemActions>
                  </Item>
                );
              })}
            </VStack>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!otherValid || saving) return;
              toggle(otherName, true);
              setOther("");
              // A row just added must be on screen: an active search would filter it straight out.
              setSearch("");
            }}
          >
            <Input
              aria-describedby={modelIdHelp}
              aria-label="Another model"
              className="min-h-11"
              disabled={saving}
              onChange={(event) => setOther(event.target.value)}
              placeholder="provider/model"
              value={other}
            />
            <Button
              className="min-h-11"
              disabled={!otherValid || saving}
              size="sm"
              type="submit"
              variant="outline"
            >
              Add
            </Button>
          </form>
          <p className="text-muted-foreground text-sm" id={modelIdHelp}>
            Enter the full provider and model ID, for example openai/gpt-4o.
          </p>
          {defaultName && !selected.includes(defaultName) ? (
            <p className="wrap-anywhere text-muted-foreground text-sm">
              {defaultName} is the default and stays offered. With Only allowed
              models on, a built-in Bot on it is refused unless you allow it.
            </p>
          ) : null}
          {saveError ? (
            <p
              className="text-destructive text-sm"
              ref={saveErrorMessage}
              role="alert"
              tabIndex={-1}
            >
              Couldn't save the allowed models. Try again.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <DeploymentButton
            className="max-h-none min-h-11"
            disabled={saving}
            onClick={onClose}
            size="lg"
            type="button"
            variant="outline"
          >
            Cancel
          </DeploymentButton>
          <DeploymentButton
            className="max-h-none min-h-11"
            disabled={saving}
            onClick={() => {
              /*
               * The dialog stays open until the write answers: closing on the press showed the
               * summary unchanged and the failure only as a quiet alert behind the dialog, which
               * read as a save that silently did nothing.
               */
              setSaving(true);
              setSaveError(false);
              onSave(selected)
                .then(onClose)
                .catch(() => setSaveError(true))
                .finally(() => setSaving(false));
            }}
            size="lg"
            type="button"
          >
            {saving ? "Saving…" : saveError ? "Retry save" : "Save"}
          </DeploymentButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin, Providers: which models Bots ran on in the last 30 days. Only a team has an allowlist, so
 * only a team is told that refused runs are counted.
 */
export function ModelUsageSection({ team }: { team: boolean }) {
  const usage = useQuery(modelUsageQueryOptions(30));
  return (
    <PageSection
      description={
        team
          ? "Runs on each model in the last 30 days, including runs the allowlist refused."
          : "Runs on each model in the last 30 days."
      }
      title="Usage"
    >
      {usage.isPending && usage.errorUpdateCount === 0 ? (
        <div aria-busy="true" aria-label="Loading model usage" role="status">
          <PageRows>
            {LOADING_ROWS.map((key, index) => (
              <Fragment key={key}>
                {index > 0 ? <Separator /> : null}
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <Skeleton className="size-full" />
                  </ItemMedia>
                  <ItemContent className="gap-1.5">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </ItemContent>
                </Item>
              </Fragment>
            ))}
          </PageRows>
        </div>
      ) : !usage.isSuccess ? (
        <ReadError
          message="Couldn't load model usage."
          retry={usage.refetch}
          retrying={usage.isFetching}
          retryBelow
        />
      ) : usage.data.summary.length === 0 ? (
        <PageEmpty icon={IconChartBar} title="No recent runs">
          Runs will appear here once a Bot answers.
        </PageEmpty>
      ) : (
        <PageRows>
          {usage.data.summary.map((row, index) => (
            <Fragment key={`${row.model}-${row.source}`}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconChartBar />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="wrap-anywhere">{row.model}</ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    {row.runs} runs by {row.people}{" "}
                    {row.people === 1 ? "person" : "people"}
                    {row.refused > 0
                      ? ` · ${row.refused} off the allowlist`
                      : ""}{" "}
                    · {row.source}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-muted-foreground text-sm">
                    {new Date(row.lastUsedAt).toLocaleDateString()}
                  </span>
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
    </PageSection>
  );
}
