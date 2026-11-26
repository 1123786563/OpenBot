import { Text } from "@astryxdesign/core/Text";
import {
  IconChevronRight,
  IconDeviceDesktop,
  IconEye,
  IconId,
  IconNotes,
  IconPlugConnected,
  IconShieldCheck,
  IconTag,
  IconTextCaption,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useRef, useState } from "react";
import type { ZodType } from "zod";
import { CallbackTokenPanel } from "@/components/agents/callback-token-panel";
import { astryxScope } from "@/components/astryx-pilot/theme";
import { TestCreditModelPicker } from "@/components/channels/test-credit-model-picker";
import { BusinessComputerLink } from "@/components/edition/team-features-dialog";
import { PageRows, PageSection } from "@/components/layout/page-shell";
import { ReadError } from "@/components/layout/read-status";
import { SettingsDraftDialog } from "@/components/settings/settings-draft-dialog";
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
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type AgentFormValues,
  agentFormSchema,
  profileUpdateInput,
} from "@/lib/agents/form";
import {
  ISOLATED_MAKING_PUBLIC,
  ISOLATED_PUBLIC_SHARES_LOGINS,
  ISOLATION_GONE,
  ISOLATION_NOT_ALLOWED,
  ISOLATION_UNAVAILABLE,
  ISOLATION_WITHDRAWN,
  isolatedExplained,
} from "@/lib/agents/isolation";
import { updateAgentMutationOptions } from "@/lib/agents/mutations";
import {
  type AgentProfile,
  agentCapabilitiesQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { shownSubtitle } from "@/lib/agents/subtitle";
import { isComposing } from "@/lib/composing";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { queryClient } from "@/query-client";

type TextField = "name" | "title" | "roleDescription" | "instructions";

const TEXT_FIELDS: {
  field: TextField;
  label: string;
  help: string;
  icon: typeof IconId;
  multiline?: boolean;
}[] = [
  {
    field: "name",
    label: "Name",
    help: "Shown wherever people find or talk to this Bot.",
    icon: IconId,
  },
  {
    field: "title",
    label: "Short description",
    help: "Shown under the Bot’s name so people can tell what it’s for.",
    icon: IconTag,
  },
  {
    field: "roleDescription",
    // Not "Role": beside "Title" it read as a second job title, when it is the standing
    // instruction the Bot carries into every channel. The create dialog says the same.
    // The starter Bot is the exception: this is what it does, for the person, and what it is
    // told is the row below.
    label: "What it does",
    help: "Describe the work people can ask this Bot to do.",
    icon: IconTextCaption,
    multiline: true,
  },
  {
    // Only the starter Bot has this row. See `AgentProfile.instructions`.
    field: "instructions",
    label: "Instructions",
    help: "Tell this Bot how to respond and what rules to follow.",
    icon: IconNotes,
    multiline: true,
  },
];

const TEXT_SCHEMAS: Record<TextField, ZodType<string>> = {
  name: agentFormSchema.shape.name,
  title: agentFormSchema.shape.title,
  roleDescription: agentFormSchema.shape.roleDescription,
  instructions: agentFormSchema.shape.instructions.unwrap(),
};

/** Who a Bot is and where it runs. Editable by whoever may manage it; read-only for everyone else. */
export function SetupSections({ agent }: { agent: AgentProfile }) {
  // One person and one shared computer: nobody to see a Bot, and no computer of its own to give it.
  const { data: deployment } = useQuery(deploymentCapabilitiesQueryOptions());
  const personal = deployment?.edition === "personal";
  const update = useMutation(updateAgentMutationOptions(queryClient));
  const [editing, setEditing] = useState<TextField | null>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const save = (patch: Partial<AgentFormValues>) =>
    update.mutateAsync({
      agentId: agent.id,
      input: profileUpdateInput(agent, patch),
    });
  async function publish() {
    const latest = await queryClient.fetchQuery({
      ...agentQueryOptions(agent.id),
      staleTime: 0,
    });
    if (!latest.canManage) {
      throw new ActionUnavailable(
        "You no longer have permission to make this Bot public.",
      );
    }
    if (latest.visibility === "public") return;
    if (
      latest.name !== agent.name ||
      latest.isolationActive !== agent.isolationActive
    ) {
      throw new ActionUnavailable(
        "This Bot’s name or computer changed. Close this dialog and review its settings before making it public.",
      );
    }
    await update.mutateAsync({
      agentId: latest.id,
      input: profileUpdateInput(latest, { visibility: "public" }),
    });
  }
  const open = TEXT_FIELDS.find((entry) => entry.field === editing);
  /*
   * The subtitle as a person reads it everywhere else (lib/agents/subtitle.ts). Saved back unchanged,
   * it stays as stored: the Bot is told the stored subtitle, and a save of the shown wording would
   * change that.
   */
  const shown = (field: TextField) =>
    field === "title" ? shownSubtitle(agent.title) : agent[field];
  const saveText = (field: TextField, value: string) =>
    save({
      [field]:
        field === "title" && value === shownSubtitle(agent.title)
          ? agent.title
          : value,
    });
  const fields = TEXT_FIELDS.filter(
    ({ field }) =>
      field !== "instructions" || typeof agent.instructions === "string",
  );

  return (
    <>
      <PageSection title="Identity">
        <PageRows>
          {fields.map(({ field, label, icon: Icon }, index) => (
            <Fragment key={field}>
              {index > 0 ? <Separator /> : null}
              <Item
                render={
                  agent.canManage ? (
                    <button
                      onClick={(event) => {
                        editTrigger.current = event.currentTarget;
                        setEditing(field);
                      }}
                      type="button"
                    />
                  ) : undefined
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{label}</ItemTitle>
                  <Text
                    as="p"
                    color="secondary"
                    maxLines={agent.canManage ? 2 : undefined}
                    size="base"
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {shown(field)}
                  </Text>
                </ItemContent>
                {agent.canManage ? (
                  <ItemActions>
                    <IconChevronRight className="size-4 text-muted-foreground" />
                  </ItemActions>
                ) : null}
              </Item>
            </Fragment>
          ))}
          {personal ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemContent>
                  <BusinessComputerLink />
                </ItemContent>
              </Item>
            </>
          ) : (
            <>
              <Separator />
              <VisibilityRow
                agent={agent}
                onPublish={publish}
                onSave={(visibility) => save({ visibility })}
              />
              <Separator />
              <IsolatedRow
                agent={agent}
                onSave={(isolated) => save({ isolated })}
              />
            </>
          )}
          {agent.systemOwned ? (
            <>
              <Separator />
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconShieldCheck />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>System owned</ItemTitle>
                  <Text as="p" color="secondary" size="base">
                    Comes with OpenBot. It doesn't belong to a person.
                  </Text>
                </ItemContent>
              </Item>
            </>
          ) : null}
        </PageRows>
      </PageSection>
      {deployment?.testCreditConversations ? (
        <PageSection title="Model">
          <TestCreditModelPicker botId={agent.id} readOnly={!agent.canManage} />
        </PageSection>
      ) : null}
      <ConnectionSection agent={agent} />
      {open ? (
        <EditTextDialog
          help={open.help}
          label={open.label}
          multiline={open.multiline ?? false}
          onClose={() => setEditing(null)}
          onSave={(value) => saveText(open.field, value)}
          opener={editTrigger}
          schema={TEXT_SCHEMAS[open.field]}
          value={shown(open.field) ?? ""}
        />
      ) : null}
    </>
  );
}

/** Two named choices that write on pick: no draft worth holding, so no dialog. */
function VisibilityRow({
  agent,
  onPublish,
  onSave,
}: {
  agent: AgentProfile;
  onPublish: () => Promise<void>;
  onSave: (visibility: AgentProfile["visibility"]) => Promise<unknown>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const summaryId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const { confirmation, requestConfirmation } = useActionConfirmation();
  const publicSummary = "Everyone on OpenBot can find and use it.";
  return (
    <Item
      size="sm"
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
      }}
    >
      <ItemMedia variant="icon">
        <IconEye />
      </ItemMedia>
      <ItemTitle>Visibility</ItemTitle>
      <ItemActions>
        {agent.canManage ? (
          <Select
            disabled={saving}
            // The label map, so the closed trigger says "Private" rather than the raw value.
            items={{ private: "Private", public: "Public" }}
            onValueChange={async (next) => {
              if (
                next === agent.visibility ||
                (next !== "public" && next !== "private")
              )
                return;
              setError(null);
              if (next === "public") {
                requestConfirmation({
                  title: `Make ${agent.name} public?`,
                  description: agent.isolationActive
                    ? `${publicSummary} ${ISOLATED_MAKING_PUBLIC}`
                    : publicSummary,
                  confirmLabel: "Make public",
                  pendingLabel: "Making public…",
                  failureMessage: "Couldn’t make this Bot public. Try again.",
                  successMessage: `${agent.name} is public.`,
                  run: onPublish,
                  trigger: trigger.current ?? undefined,
                  variant: "default",
                });
                return;
              }
              setSaving(true);
              try {
                await onSave(next);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Couldn't save. Try again.",
                );
              } finally {
                setSaving(false);
              }
            }}
            value={agent.visibility}
          >
            <SelectTrigger
              aria-describedby={summaryId}
              aria-label="Visibility"
              className="w-28"
              ref={trigger}
              style={{ minHeight: "var(--spacing-11)" }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent {...astryxScope}>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="public">Public</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-muted-foreground text-sm">
            {agent.visibility === "private" ? "Private" : "Public"}
          </span>
        )}
      </ItemActions>
      <ItemContent style={{ gridColumn: "2 / -1" }}>
        <Text as="p" color="secondary" id={summaryId} size="base">
          {agent.visibility === "private"
            ? agent.isolationActive
              ? `Only you can see it and start conversations with it. ${ISOLATED_MAKING_PUBLIC}`
              : "Only you can see it and start conversations with it."
            : agent.isolationActive
              ? `${publicSummary} ${ISOLATED_PUBLIC_SHARES_LOGINS}`
              : publicSummary}
        </Text>
        {error ? (
          <Text as="p" role="alert" size="base">
            {error}
          </Text>
        ) : null}
        {confirmation}
      </ItemContent>
    </Item>
  );
}

/**
 * Whether it has a computer of its own: a switch that writes when flipped, like Visibility's choice.
 *
 * The switch shows what the owner asked for. What is actually happening is the description, decided
 * by the server: a Bot whose owner lost "Isolated Bots" keeps its tick, runs on their shared computer,
 * and says so here, so that an administrator giving the switch back restores it without anybody
 * touching the Bot.
 *
 * Turning it off is never refused, so the switch stays live for an isolated Bot even where it could
 * not be turned back on. Turning it on is offered only where the deployment can make the computer
 * and the person holds the switch; anywhere else the row says which of the two is missing.
 */
function IsolatedRow({
  agent,
  onSave,
}: {
  agent: AgentProfile;
  onSave: (isolated: boolean) => Promise<unknown>;
}) {
  const deployment = useQuery(agentCapabilitiesQueryOptions());
  const permission = useQuery(myCapabilitiesQueryOptions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = deployment.data?.isolationAvailable ?? false;
  const allowed = permission.data?.capabilities.isolatedComputers !== false;
  const checking = deployment.isPending || (available && permission.isPending);
  const checkFailed = deployment.isError || (available && permission.isError);
  const showCheck = !agent.systemOwned && !agent.isolated;
  const isPublic = agent.visibility === "public";
  // A Bot that comes with OpenBot belongs to nobody, and the switch is a person's.
  const editable =
    agent.canManage &&
    !agent.systemOwned &&
    (agent.isolated || (available && allowed && !checking && !checkFailed));

  const summary = agent.systemOwned
    ? "Comes with OpenBot, so it runs on the computer of whoever is using it."
    : agent.isolated
      ? agent.isolationActive
        ? isolatedExplained(isPublic)
        : agent.isolationOffReason === "admin"
          ? ISOLATION_WITHDRAWN
          : agent.isolationOffReason === "deployment"
            ? ISOLATION_GONE
            : sharedSummary(isPublic)
      : checking || checkFailed
        ? sharedSummary(isPublic)
        : !available
          ? ISOLATION_UNAVAILABLE
          : !allowed && agent.canManage
            ? ISOLATION_NOT_ALLOWED
            : sharedSummary(isPublic);

  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <IconDeviceDesktop />
      </ItemMedia>
      <ItemContent>
        <ItemTitle id={`isolated-${agent.id}`}>Isolated</ItemTitle>
        <Text as="p" color="secondary" size="base">
          {error ?? summary}
        </Text>
        {showCheck && checking ? (
          <Text as="p" color="secondary" role="status" size="base">
            Checking whether isolation is available…
          </Text>
        ) : null}
        {showCheck && checkFailed ? (
          <ReadError
            message="Couldn’t check whether isolation is available"
            retry={() =>
              deployment.isError ? deployment.refetch() : permission.refetch()
            }
            retryBelow
            retrying={deployment.isFetching || permission.isFetching}
          />
        ) : null}
      </ItemContent>
      <ItemActions>
        {agent.canManage && !agent.systemOwned ? (
          <Switch
            aria-labelledby={`isolated-${agent.id}`}
            checked={agent.isolated}
            className="after:-inset-y-3.5"
            disabled={saving || !editable}
            onCheckedChange={async (next) => {
              setError(null);
              setSaving(true);
              try {
                await onSave(next);
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Couldn't save. Try again.",
                );
              } finally {
                setSaving(false);
              }
            }}
          />
        ) : (
          <span className="text-muted-foreground text-sm">
            {agent.isolated ? "On" : "Off"}
          </span>
        )}
      </ItemActions>
    </Item>
  );
}

/** Where a Bot without a computer of its own runs: on the computer of whoever is using it. */
function sharedSummary(isPublic: boolean): string {
  return isPublic
    ? "Runs on the computer of whoever is using it."
    : "Runs on your computer, alongside your other Bots.";
}

/**
 * One text field in a dialog, validated against the same limits the server enforces. Enter saves a
 * single-line field — but not the Enter that confirms a composed character, which would save the
 * value before the person finished typing it.
 */
function EditTextDialog({
  help,
  label,
  value,
  multiline,
  schema,
  onSave,
  onClose,
  opener,
}: {
  help: string;
  label: string;
  value: string;
  multiline: boolean;
  schema: ZodType<string>;
  onSave: (value: string) => Promise<unknown>;
  onClose: () => void;
  opener: React.RefObject<HTMLButtonElement | null>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const submit = async () => {
    if (submitting.current) return;
    const parsed = schema.safeParse(draft);
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Check this field and try again.",
      );
      return;
    }
    submitting.current = true;
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Couldn't save. Try again.",
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };
  return (
    <SettingsDraftDialog
      action={
        <Button
          className="min-h-11"
          disabled={saving}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      }
      description={help}
      dirty={draft !== value}
      guardNavigation={submitting}
      onClose={onClose}
      open
      opener={opener}
      overlay={astryxScope}
      saving={saving}
      title={label}
    >
      {multiline ? (
        <Textarea
          aria-label={label}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          readOnly={saving}
          rows={5}
          value={draft}
        />
      ) : (
        <Input
          aria-label={label}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isComposing(event)) {
              event.preventDefault();
              void submit();
            }
          }}
          readOnly={saving}
          value={draft}
        />
      )}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsDraftDialog>
  );
}

/**
 * Where it runs. A built-in Bot runs on the deployment's own Bot, whose process already holds the
 * deployment's tool credential, so there is nothing to show but that sentence.
 */
function ConnectionSection({ agent }: { agent: AgentProfile }) {
  const builtIn = !agent.endpoint || agent.builtIn;
  return (
    <PageSection title="Connection">
      <PageRows>
        <Item size="sm">
          <ItemMedia variant="icon">
            <IconPlugConnected />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{builtIn ? "Built in" : "Agent URL"}</ItemTitle>
            <Text
              as="p"
              color="secondary"
              size="base"
              style={{ overflowWrap: "anywhere" }}
              type={builtIn ? "body" : "code"}
            >
              {builtIn
                ? "Runs inside OpenBot. There's nothing to connect."
                : agent.endpoint}
            </Text>
          </ItemContent>
        </Item>
      </PageRows>
      {!builtIn && agent.canManage ? (
        <CallbackTokenPanel
          agentId={agent.id}
          hasToken={agent.hasCallbackToken}
          fromOpenBot={agent.keyFromOpenBot === true}
        />
      ) : null}
    </PageSection>
  );
}
