import { isPersonBrowserId } from "@openbot/shared/openbot-browser";
import { IconBolt, IconDeviceDesktop } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";
import { DeviceAction } from "@/components/astryx-pilot/device-action";
import { DevicePage } from "@/components/astryx-pilot/device-page";
import {
  ClearBrowserDialog,
  useClearBrowserData,
} from "@/components/browser/browser-bar";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { StaggerItem } from "@/components/layout/stagger";
import {
  ActionUnavailable,
  useActionConfirmation,
} from "@/components/ui/action-confirmation";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { clearBrowserMutationOptions } from "@/lib/browser/mutations";
import { ClientError } from "@/lib/client";
import {
  type HostAccessPendingOperation,
  type HostFolderGrant,
  hostAccessQueryOptions,
  requestHostFolderGrantMutationOptions,
  revokeHostFolderGrantMutationOptions,
  stopHostAccessMutationOptions,
} from "@/lib/computers/host-access";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import {
  type ComputerProfile,
  computerFleetQueryOptions,
} from "@/lib/computers/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { useManagePaths } from "@/lib/manage-paths";

/** One row's identity: the computer, and on a shared computer the Bot's seat on it. */
function rowId(computer: ComputerProfile): string {
  return `${computer.computer}|${computer.botId ?? ""}`;
}

/**
 * A person's own OpenBot browser, the one Teach a Bot records in. It is listed beside the Bots' browsers, under an id
 * that is no Bot's, so it read "A Bot no longer here" until it was named for what it is.
 */
function isOwnBrowser(computer: ComputerProfile): boolean {
  return computer.botId !== undefined && isPersonBrowserId(computer.botId);
}

/**
 * `children` are sections only the team edition's Admin adds below the page's own (the admin's
 * controls for these). The personal edition's Settings renders this page with none.
 *
 * In the personal edition this is one person's one computer. What only a team can act on goes: the
 * notice about giving each person a computer of their own, whose seat a row is, and where its
 * traffic leaves. Each Bot's browser stays, with Stop and Reset, because this is the one place the
 * person can sign a Bot out of everything.
 */
export function ComputersPage({ children }: { children?: ReactNode } = {}) {
  const paths = useManagePaths();
  const personal =
    useQuery(deploymentCapabilitiesQueryOptions()).data?.edition === "personal";
  const { requestConfirmation, confirmation } = useActionConfirmation();
  const fleetHeading = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const nameFor = useBotNames();
  /*
   * The person's own OpenBot browser is cleared the way Teach a Bot clears it: a recording in it ends first, and its
   * Recorder connection ends with the profile. A Bot's Reset does neither.
   */
  const clearOwnBrowser = useMutation(clearBrowserMutationOptions(queryClient));
  const clearing = useClearBrowserData(clearOwnBrowser);

  const fleet = useQuery(computerFleetQueryOptions());
  const hostAccess = useQuery(hostAccessQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));
  const requestGrant = useMutation(
    requestHostFolderGrantMutationOptions(queryClient),
  );
  const revokeGrant = useMutation(
    revokeHostFolderGrantMutationOptions(queryClient),
  );
  const stopHostAccess = useMutation(
    stopHostAccessMutationOptions(queryClient),
  );

  const denied =
    fleet.error instanceof ClientError &&
    (fleet.error.status === 401 || fleet.error.status === 403);
  const computers = denied ? null : (fleet.data?.computers ?? null);
  const isolation = denied ? null : (fleet.data?.isolation ?? null);
  const hostWriteError =
    requestGrant.error ?? revokeGrant.error ?? stopHostAccess.error;
  const hostReadFailed = hostAccess.isError || agents.isError;
  const hostLoading = hostAccess.isPending || agents.isPending;

  /**
   * Whose computer a row is, in the words the rest of Admin uses.
   *
   * A person's computer is named for the person. An isolated Bot's is named for the Bot. On a shared
   * computer a row is one person's seat on one Bot, so it names both.
   */
  const titleOf = (computer: ComputerProfile): string => {
    if (isOwnBrowser(computer)) {
      if (personal) return "Your OpenBot browser";
      const owner = computer.person?.name ?? computer.person?.email;
      return owner
        ? `${owner}'s OpenBot browser`
        : "A person's OpenBot browser";
    }
    // One person, so a row is one of their Bots.
    if (personal) return computer.botId ? nameFor(computer.botId) : "Computer";
    const person =
      computer.person?.name ?? computer.person?.email ?? computer.personId;
    if (computer.kind === "person") {
      return computer.botId
        ? `${person} · ${nameFor(computer.botId)}`
        : `${person}'s computer`;
    }
    return computer.botId ? nameFor(computer.botId) : computer.computer;
  };

  function confirmChange(
    computer: ComputerProfile,
    action: "reset" | "update",
    trigger: HTMLElement,
  ) {
    const name = titleOf(computer);
    const reset = action === "reset";
    const resetImpact =
      computer.kind === "person" && !computer.botId
        ? "Every Bot’s browser profile on this computer is deleted. Each Bot is signed out and starts clean."
        : isOwnBrowser(computer)
          ? "The browser profile is deleted. The person is signed out of every site in it."
          : "The Bot’s browser profile is deleted. The Bot is signed out and starts clean.";
    requestConfirmation({
      title: reset ? `Reset ${name}?` : `Update ${name}?`,
      description: reset
        ? `${resetImpact} You can’t undo this.`
        : `It moves to the computer image ${paths.deploymentName} now runs. Files and sign-ins are kept. A running computer restarts and stops what it is doing.`,
      confirmLabel: reset ? "Reset computer" : "Update computer",
      pendingLabel: reset ? "Resetting…" : "Updating…",
      failureMessage: `Couldn't complete the change for ${name}. Try again.`,
      successMessage: reset
        ? `Reset complete for ${name}.`
        : `Update complete for ${name}.`,
      variant: reset ? "destructive" : "default",
      trigger,
      fallbackFocus: () => fleetHeading.current,
      refresh: () => fleet.refetch(),
      run: async () => {
        const { data } = await fleet.refetch({ throwOnError: true });
        const latest = data?.computers.find(
          (candidate) => rowId(candidate) === rowId(computer),
        );
        if (
          !latest ||
          latest.running !== computer.running ||
          latest.startedAt !== computer.startedAt ||
          (!reset && !latest.updateAvailable)
        ) {
          throw new ActionUnavailable(
            "This device changed while you were reviewing it. Close this dialog and check its current status.",
          );
        }
        try {
          await setState.mutateAsync({
            action,
            computer: latest.computer,
            botId: latest.botId,
          });
        } catch (error) {
          if (!(error instanceof ClientError) || error.status >= 500) {
            throw new ActionUnavailable(
              `The service couldn't confirm the change. Check the device status and ${paths.auditLabel} before trying again.`,
            );
          }
          throw error;
        }
      },
    });
  }

  /** Which profiles and files a computer holds. */
  const scopeOf = (computer: ComputerProfile): string => {
    if (isOwnBrowser(computer)) return "Their own browser for Teach a Bot";
    if (computer.kind === "person") {
      return computer.botId
        ? "This person's profile and folder for this Bot"
        : "Runs every Bot this person uses";
    }
    return isolation === "shared"
      ? "This Bot's profile from before each person had their own"
      : "Isolated: a computer of its own, shared by everyone who uses it";
  };

  /** Whether its browser runs, and when it starts again. */
  const stateOf = (computer: ComputerProfile): string => {
    const since = computer.running
      ? `Browser running since ${new Date(computer.startedAt ?? "").toLocaleTimeString()}`
      : "No browser running";
    if (!isOwnBrowser(computer))
      return computer.running
        ? since
        : `${since}. It starts when the Bot next needs it.`;
    // In the team edition the row already says it is that person's browser for Teach a Bot.
    if (!personal) return since;
    return computer.running
      ? `${since}. You record in it with Teach a Bot.`
      : `${since}. It opens when you record with Teach a Bot.`;
  };

  return (
    <DevicePage
      description={
        personal
          ? "Your Bots share one computer. Each Bot keeps its own browser profile there, which keeps it signed in. A command one Bot runs can still read another Bot's files."
          : "Each person's computer, and each isolated Bot's. Every Bot keeps its own browser profile on it, which keeps that Bot signed in. Resetting a computer signs every Bot on it out of everything."
      }
      title={personal ? "Computer" : "Computers"}
    >
      <PageSection
        headingRef={fleetHeading}
        title={
          personal ? "Your Bots' browsers" : "Computers in this deployment"
        }
      >
        {confirmation}
        {setState.variables?.action === "stop" && setState.error ? (
          <p
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {setState.error.message}
          </p>
        ) : null}
        {fleet.isError ? (
          <ReadError
            description={
              computers?.length
                ? "Showing device information from the last successful check."
                : undefined
            }
            message={
              computers?.length
                ? "Couldn't refresh device status."
                : "Couldn't load the device list."
            }
            retry={fleet.refetch}
            retryBelow
            retrying={fleet.isFetching}
          />
        ) : fleet.isPending ? (
          <ReadStatus kind="loading" message="Loading devices…" />
        ) : null}
        {computers === null ||
        (fleet.isError && computers.length === 0) ? null : computers.length ===
          0 ? (
          <PageEmpty
            icon={IconDeviceDesktop}
            title={personal ? "No browsers yet" : "No computers yet"}
          >
            {personal
              ? "One starts the first time a Bot opens a page."
              : "One shows up the first time a Bot opens a page."}
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={rowId(computer)}>
                <Item size="sm">
                  <ItemContent className="min-w-0 basis-full sm:basis-auto">
                    <ItemTitle
                      className="line-clamp-none block wrap-anywhere"
                      title={computer.computer}
                    >
                      {titleOf(computer)}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-sm">
                      {stateOf(computer)}
                    </ItemDescription>
                    {personal ? null : (
                      <>
                        <ItemDescription className="line-clamp-none text-sm">
                          {scopeOf(computer)}
                        </ItemDescription>
                        <ItemDescription className="line-clamp-none wrap-anywhere text-sm">
                          {computer.egress === undefined
                            ? "Network route not reported"
                            : computer.egress === null
                              ? "Connects directly"
                              : `Leaves through ${computer.egress}`}
                        </ItemDescription>
                      </>
                    )}
                    {computer.updateAvailable ? (
                      <ItemDescription className="text-sm">
                        Update available
                      </ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions className="max-w-full flex-wrap">
                    {computer.updateAvailable ? (
                      <DeviceAction
                        aria-label={`Update computer: ${titleOf(computer)}`}
                        className="confirmation-action"
                        disabled={setState.isPending}
                        onClick={(event) =>
                          confirmChange(computer, "update", event.currentTarget)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Update computer
                      </DeviceAction>
                    ) : null}
                    <DeviceAction
                      aria-label={`Stop browser: ${titleOf(computer)}`}
                      className="confirmation-action"
                      disabled={setState.isPending || !computer.running}
                      onClick={() =>
                        setState.mutate({
                          action: "stop",
                          computer: computer.computer,
                          botId: computer.botId,
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      {setState.isPending &&
                      setState.variables.action === "stop" &&
                      setState.variables.computer === computer.computer &&
                      setState.variables.botId === computer.botId
                        ? "Stopping…"
                        : "Stop browser"}
                    </DeviceAction>
                    {personal && isOwnBrowser(computer) ? (
                      <DeviceAction
                        aria-label={`Clear browser data: ${titleOf(computer)}`}
                        className="confirmation-action"
                        disabled={
                          setState.isPending || clearOwnBrowser.isPending
                        }
                        onClick={clearing.ask}
                        size="sm"
                        variant="outline"
                      >
                        Clear browser data
                      </DeviceAction>
                    ) : (
                      <DeviceAction
                        aria-label={`Reset: ${titleOf(computer)}`}
                        className="confirmation-action"
                        disabled={setState.isPending}
                        onClick={(event) =>
                          confirmChange(computer, "reset", event.currentTarget)
                        }
                        size="sm"
                        variant="outline"
                      >
                        Reset
                      </DeviceAction>
                    )}
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {personal ? null : isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-medium">
            Every person's Bots run on one computer.
          </span>{" "}
          Each person keeps their own browser profile and folder for each Bot,
          so logins aren't shared. A command one Bot runs can still read
          another's files. Set <code>COMPUTER_SUPERVISOR_URL</code> to give each
          person a computer of their own.
        </p>
      ) : isolation === "per-person" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          Each person has their own computer, and every Bot they use runs on it,
          public Bots made by other people included. Each Bot keeps its own
          browser profile and folder there, but a command one Bot runs can reach
          anything else on that person's computer. An isolated Bot has a
          computer of its own.
        </p>
      ) : null}

      <HostFoldersSection
        connected={hostAccess.data?.connected ?? false}
        desktop={hostAccess.data?.desktop !== false}
        grants={hostAccess.data?.grants ?? []}
        botIds={(agents.data ?? []).map((agent) => agent.id)}
        loading={hostLoading}
        nameFor={nameFor}
        onGrant={(botId) => requestGrant.mutate({ botId })}
        onRevoke={(grantId) => revokeGrant.mutate({ grantId })}
        onStop={() => stopHostAccess.mutate()}
        pending={hostAccess.data?.pending ?? []}
        personal={personal}
        problem={hostWriteError?.message ?? null}
        readStatus={
          hostReadFailed ? (
            <ReadError
              message="Couldn't check folder access."
              description={
                hostAccess.data
                  ? "Some folder or Bot details may be out of date."
                  : undefined
              }
              retry={() =>
                Promise.all([hostAccess.refetch(), agents.refetch()])
              }
              retryBelow
              retrying={hostAccess.isFetching || agents.isFetching}
            />
          ) : hostLoading ? (
            <ReadStatus kind="loading" message="Checking folder access…" />
          ) : null
        }
        readingUnavailable={hostReadFailed}
        requestingBotId={
          requestGrant.isPending
            ? (requestGrant.variables?.botId ?? null)
            : null
        }
        revokingGrantId={
          revokeGrant.isPending
            ? (revokeGrant.variables?.grantId ?? null)
            : null
        }
        stopping={stopHostAccess.isPending}
      />

      <ClearBrowserDialog
        clear={clearOwnBrowser}
        onOpenChange={clearing.setAsking}
        open={clearing.asking}
      />

      {personal ? (
        <p className="mt-4 text-muted-foreground text-sm">
          <strong>Stop browser</strong> closes a browser and keeps its sign-ins.
          It starts again the next time it's needed. <strong>Reset</strong>{" "}
          deletes a Bot's browser profile and signs it out of everything.{" "}
          {computers?.some(isOwnBrowser) ? (
            <>
              <strong>Clear browser data</strong> does the same for your OpenBot
              browser.{" "}
            </>
          ) : null}
          Each shows in{" "}
          <Link className="underline" {...paths.audit()}>
            {paths.auditLabel}
          </Link>
          .
        </p>
      ) : (
        <p className="mt-4 text-muted-foreground text-sm">
          <strong>Stop</strong> closes the computer's browsers and keeps their
          logins. It starts again the next time a Bot needs it.{" "}
          <strong>Reset</strong> deletes the profiles and signs every Bot on it
          out of everything. <strong>Update computer</strong> shows when a
          computer runs an older image. It moves the computer to the new one and
          keeps its files and sign-ins. All three show in{" "}
          <Link className="underline" {...paths.audit()}>
            {paths.auditLabel}
          </Link>
          .
        </p>
      )}
      {children}
    </DevicePage>
  );
}

type HostFoldersSectionProps = {
  botIds: string[];
  connected: boolean;
  /** This OpenBot runs in OpenBot Desktop. Without it no folder can ever be chosen here. */
  desktop: boolean;
  grants: HostFolderGrant[];
  loading: boolean;
  nameFor: (botId: string) => string;
  onGrant: (botId: string) => void;
  onRevoke: (grantId: string) => void;
  onStop: () => void;
  pending: HostAccessPendingOperation[];
  /**
   * The personal edition, where the person reading is the one OpenBot Desktop asks. In the team
   * edition the desktop's owner may be somebody else, so a waiting request names them instead.
   */
  personal: boolean;
  problem: string | null;
  readStatus: ReactNode;
  readingUnavailable: boolean;
  requestingBotId: string | null;
  revokingGrantId: string | null;
  stopping: boolean;
};

function HostFoldersSection({
  botIds: knownBotIds,
  connected,
  desktop,
  grants,
  loading,
  nameFor,
  onGrant,
  onRevoke,
  onStop,
  pending,
  personal,
  problem,
  readStatus,
  readingUnavailable,
  requestingBotId,
  revokingGrantId,
  stopping,
}: HostFoldersSectionProps) {
  const paths = useManagePaths();
  const botIds = Array.from(
    new Set([
      ...knownBotIds,
      ...grants.map((grant) => grant.botId),
      // Stop folder access is addressed to every Bot ("*"), not one: it is no Bot's row.
      ...pending.map((one) => one.botId).filter((botId) => botId !== ALL_BOTS),
    ]),
  ).sort((left, right) => nameFor(left).localeCompare(nameFor(right)));

  return (
    <PageSection
      description="Choose folders a Bot can read on this computer. The desktop app asks before each edit or command. Access ends when you stop OpenBot."
      title="Folders on this computer"
    >
      {readStatus}
      {problem ? (
        <p
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {desktop && !connected && !loading && !readingUnavailable ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          The desktop app is offline. Open it to approve folders or run
          commands.
        </p>
      ) : null}

      {loading ? null : !desktop ? (
        <PageEmpty icon={IconDeviceDesktop} title="Needs OpenBot Desktop">
          This OpenBot isn't running in the desktop app. Use OpenBot Desktop to
          let Bots read folders on this computer.
        </PageEmpty>
      ) : botIds.length === 0 ? (
        readingUnavailable ? null : (
          <PageEmpty icon={IconBolt} title="No Bots yet">
            Create one, then choose its folders.
          </PageEmpty>
        )
      ) : (
        <PageRows>
          {botIds.map((botId, index) => (
            <StaggerItem index={index} key={botId}>
              <Item size="sm">
                <ItemContent className="min-w-0 basis-full">
                  <ItemTitle className="line-clamp-none block wrap-anywhere">
                    {nameFor(botId)}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none text-sm">
                    {summaryFor(botId, grants, pending)}
                  </ItemDescription>
                  <FolderGrantList
                    botId={botId}
                    grants={grants}
                    onRevoke={onRevoke}
                    pending={pending}
                    personal={personal}
                    revokingGrantId={revokingGrantId}
                  />
                </ItemContent>
                <ItemActions>
                  <DeviceAction
                    disabled={!connected || requestingBotId === botId}
                    onClick={() => onGrant(botId)}
                    size="sm"
                    variant="outline"
                  >
                    {requestingBotId === botId ? "Waiting…" : "Choose folder"}
                  </DeviceAction>
                </ItemActions>
              </Item>
              {index !== botIds.length - 1 && <Separator />}
            </StaggerItem>
          ))}
        </PageRows>
      )}

      {desktop ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-sm">
          <p>
            Folders are read-only. When a Bot needs to write, the desktop app
            asks you first.
          </p>
          <div className="flex items-center gap-3">
            <DeviceAction
              disabled={!connected || stopping}
              onClick={onStop}
              size="sm"
              variant="outline"
            >
              {stopping ? "Stopping…" : "Stop folder access"}
            </DeviceAction>
            <Link className="underline" {...paths.audit()}>
              Open {paths.auditLabel}
            </Link>
          </div>
        </div>
      ) : null}
    </PageSection>
  );
}

function FolderGrantList({
  botId,
  grants,
  onRevoke,
  pending,
  personal,
  revokingGrantId,
}: {
  botId: string;
  grants: HostFolderGrant[];
  onRevoke: (grantId: string) => void;
  pending: HostAccessPendingOperation[];
  personal: boolean;
  revokingGrantId: string | null;
}) {
  const botGrants = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  );
  const botPending = pending.filter((request) => request.botId === botId);

  if (botGrants.length === 0 && botPending.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-2">
      {botGrants.map((grant) => (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2"
          key={grant.id}
        >
          <ItemContent className="min-w-0">
            <p className="wrap-anywhere font-medium text-sm">
              {grant.displayName}
            </p>
            <p className="wrap-anywhere text-muted-foreground text-sm">
              {personal
                ? "Read-only"
                : `Approved by ${ownerLabel(grant)} · Read-only`}
            </p>
          </ItemContent>
          <DeviceAction
            disabled={revokingGrantId === grant.id}
            onClick={() => onRevoke(grant.id)}
            size="sm"
            variant="ghost"
          >
            {revokingGrantId === grant.id ? "Revoking…" : "Revoke"}
          </DeviceAction>
        </div>
      ))}
      {botPending.map((request) => (
        <div
          className="wrap-anywhere rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          key={request.operationId}
        >
          {pendingSentence(request, personal)}
        </div>
      ))}
    </div>
  );
}

function summaryFor(
  botId: string,
  grants: HostFolderGrant[],
  pending: HostAccessPendingOperation[],
) {
  const active = grants.filter(
    (grant) => grant.botId === botId && !grant.revoked,
  ).length;
  const waiting = pending.filter((request) => request.botId === botId).length;
  const parts = [];
  if (active > 0)
    parts.push(`${active} read-only ${active === 1 ? "folder" : "folders"}`);
  if (waiting > 0)
    parts.push(`${waiting} pending ${waiting === 1 ? "request" : "requests"}`);
  return parts.length > 0 ? parts.join(" · ") : "No folders approved.";
}

/** The Bot id Stop folder access is addressed to: every Bot at once. */
const ALL_BOTS = "*";

function ownerLabel(grant: { ownerName?: string; ownerEmail?: string }) {
  return grant.ownerName ?? grant.ownerEmail ?? "the desktop owner";
}

/**
 * What a folder request still open is waiting on, as a sentence.
 *
 * Reading and listing need nobody's answer, so they say only what is happening. A folder, a file
 * change or a command waits for the person at the computer: in the personal edition that is the
 * person reading, so it says OpenBot Desktop is asking them, in a window. It used to say "waiting for
 * approval from the desktop owner" to the desktop's owner, and "Listing files from the desktop owner".
 */
function pendingSentence(
  request: HostAccessPendingOperation,
  personal: boolean,
): string {
  switch (request.kind) {
    case "list_files":
      return "Listing files.";
    case "read_file":
      return "Reading a file.";
    case "cancel":
    case "stop":
      return "Stopping folder work.";
  }
  if (personal) {
    switch (request.kind) {
      case "write_file":
        return "A file change is waiting for you. OpenBot Desktop is asking you in a window.";
      case "run_command":
        return "A command is waiting for you or still running. OpenBot Desktop asks you in a window.";
      default:
        return "Folder access is waiting for you. OpenBot Desktop is asking you in a window.";
    }
  }
  const owner = ownerLabel(request);
  switch (request.kind) {
    case "write_file":
      return `File change waiting for approval from ${owner}, or to finish.`;
    case "run_command":
      return `Command waiting for approval from ${owner}, or to finish.`;
    default:
      return `Folder access waiting for approval from ${owner}.`;
  }
}
