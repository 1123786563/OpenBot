import type { ListedRecorderConnection } from "@openbot/shared/recorder-api";
import { IconBrowser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Fragment,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DeviceAction } from "@/components/astryx-pilot/device-action";
import { astryxScope } from "@/components/astryx-pilot/theme";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import {
  SettingsListSearch,
  settingsSearchTerms,
} from "@/components/settings/settings-list-search";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useTranslation } from "@/i18n";
import { canKeepCachedRead } from "@/lib/client";
import { revokeRecorderConnectionMutationOptions } from "@/lib/recorder/mutations";
import { recorderConnectionsQueryOptions } from "@/lib/recorder/queries";
import { relativeTime } from "@/lib/relative-time";
import { queryClient } from "@/query-client";

/** When a browser connected, to the minute: two copies with the same name (two Chrome profiles) stay told apart. */
const connectedAt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type DisconnectTarget = {
  connection: ListedRecorderConnection;
  which: string;
  recordingStarted: boolean;
};

/** The browsers signed in to this OpenBot as you, each with a Disconnect that revokes its sign-in. The row of the copy
 * in this browser (`thisInstallId`, from This browser) says so. */
export function ConnectedBrowsers({
  thisInstallId,
}: {
  thisInstallId?: string;
} = {}) {
  // Subscribes this list to the interface language, so choosing another one redraws its times in place.
  useTranslation();
  const connections = useQuery(
    recorderConnectionsQueryOptions({ listed: true }),
  );
  const [asking, setAsking] = useState<DisconnectTarget | null>(null);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const firstResult = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirming = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const receipt = useRef<HTMLParagraphElement>(null);
  const revoke = useMutation(
    revokeRecorderConnectionMutationOptions(queryClient),
  );
  const readAllowed =
    canKeepCachedRead(connections.error) && connections.data !== null;
  const browsers = readAllowed ? (connections.data?.connections ?? []) : [];
  const terms = settingsSearchTerms(search);
  const matching = browsers
    .map((connection) => {
      const here =
        thisInstallId !== undefined && connection.installId === thisInstallId;
      return { connection, here, ...browserText(connection, here) };
    })
    .filter(({ name, detail }) => {
      const text = `${name} ${detail}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });

  useEffect(() => {
    if (!readAllowed) setAsking(null);
  }, [readAllowed]);

  const recordingStarted = asking?.recordingStarted;
  useLayoutEffect(() => {
    if (
      recordingStarted &&
      (document.activeElement === document.body ||
        document.activeElement === confirm.current)
    )
      cancel.current?.focus();
  }, [recordingStarted]);

  async function checkDisconnectTarget(target: DisconnectTarget) {
    const latest = await connections.refetch();
    if (latest.isError) return false;
    const current = latest.data?.connections.find(
      ({ id }) => id === target.connection.id,
    );
    if (!current) {
      setNotice(`${target.connection.label} is already disconnected.`);
      opener.current = null;
      setAsking(null);
      return false;
    }
    if (current.recording && !target.connection.recording) {
      setAsking({ ...target, connection: current, recordingStarted: true });
      return false;
    }
    return true;
  }

  async function disconnect() {
    if (!asking || confirming.current) return;
    confirming.current = true;
    try {
      if (!(await checkDisconnectTarget(asking))) return;
      await revoke.mutateAsync(asking.connection.id);
      setNotice(`Disconnected ${asking.connection.label}.`);
      opener.current = null;
      setAsking(null);
    } catch {
      // The mutation's error stays in the confirmation.
    } finally {
      confirming.current = false;
    }
  }

  return (
    <PageSection headingRef={heading} title="Connected browsers">
      <p
        aria-live="polite"
        className="wrap-anywhere text-sm"
        ref={receipt}
        tabIndex={-1}
      >
        {notice}
      </p>
      {connections.isPending ? (
        <ReadStatus kind="loading" message="Loading connected browsers…" />
      ) : connections.isError ? (
        <ReadError
          description={
            browsers.length
              ? "Showing browsers from the last successful check. Retry to disconnect a browser."
              : undefined
          }
          message="Couldn't check your connected browsers."
          focusAfterRetry={() => heading.current}
          retry={connections.refetch}
          retryBelow
          retryLabel="Retry connected browsers"
          retrying={connections.isFetching}
        />
      ) : null}
      {browsers.length > 0 ? (
        <SettingsListSearch
          noun="browsers"
          placeholder="Name, connection date, or recording status"
          value={search}
          onChange={setSearch}
          onEnter={() => firstResult.current?.focus()}
          matches={matching.length}
          total={browsers.length}
        />
      ) : null}
      {connections.isSuccess && connections.data && browsers.length === 0 ? (
        <PageEmpty>No browsers connected yet.</PageEmpty>
      ) : matching.length > 0 ? (
        <PageRows>
          {matching.map(({ connection, here, name, detail }, index) => (
            <Fragment key={connection.id}>
              {index > 0 ? <Separator /> : null}
              <ConnectedBrowserRow
                connection={connection}
                detail={detail}
                name={name}
                rowRef={index === 0 ? firstResult : undefined}
                canDisconnect={connections.isSuccess}
                pending={revoke.isPending && revoke.variables === connection.id}
                onDisconnect={(button, which) => {
                  revoke.reset();
                  opener.current = button;
                  setNotice("");
                  setAsking({ connection, which, recordingStarted: false });
                }}
                here={here}
              />
            </Fragment>
          ))}
        </PageRows>
      ) : null}
      <Dialog
        open={asking !== null && readAllowed}
        onOpenChange={(open, event) => {
          if (!open && (confirming.current || connections.isFetching))
            event.cancel();
          else if (!open) setAsking(null);
        }}
      >
        <DialogContent
          {...astryxScope}
          initialFocus={cancel}
          finalFocus={() => {
            if (opener.current?.isConnected && !opener.current.disabled)
              return opener.current;
            return notice ? receipt.current : heading.current;
          }}
        >
          <DialogHeader>
            <DialogTitle className="wrap-anywhere">
              Disconnect {asking?.connection.label}?
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="mt-4 wrap-anywhere text-sm">
            <DialogDescription>
              Disconnecting stops any recording in {asking?.which}. Connect the
              Recorder again to make new recordings.
            </DialogDescription>
            {asking ? (
              <p>
                Connected on{" "}
                {connectedAt.format(new Date(asking.connection.createdAt))}.
              </p>
            ) : null}
            {recordingStarted ? (
              <p role="status">
                The latest check found a recording running in this browser.
              </p>
            ) : asking?.connection.recording ? (
              <p>This browser is recording now.</p>
            ) : null}
            {connections.isError ? (
              <ReadError
                focusAfterRetry={() => confirm.current}
                message="Couldn't check whether this browser is still connected."
                retry={() => asking && checkDisconnectTarget(asking)}
                retryBelow
                retryLabel="Retry checking this browser"
                retrying={connections.isFetching}
              />
            ) : revoke.error ? (
              <p className="mt-2 text-destructive" role="alert">
                {revoke.error.message}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter className="mt-4" style={{ flexWrap: "wrap" }}>
            <DeviceAction
              className="min-h-12"
              variant="ghost"
              disabled={revoke.isPending || connections.isFetching}
              onClick={() => {
                if (!confirming.current) setAsking(null);
              }}
              ref={cancel}
            >
              Cancel
            </DeviceAction>
            {connections.isError ? null : (
              <DeviceAction
                className="min-h-12"
                variant="destructive"
                disabled={revoke.isPending || connections.isFetching}
                ref={confirm}
                onClick={() => void disconnect()}
              >
                {revoke.isPending
                  ? "Disconnecting…"
                  : connections.isFetching
                    ? "Checking…"
                    : asking?.connection.recording
                      ? "Stop recording and disconnect"
                      : "Disconnect"}
              </DeviceAction>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

function browserText(connection: ListedRecorderConnection, here: boolean) {
  const name = here ? `${connection.label} · This browser` : connection.label;
  const date = connectedAt.format(new Date(connection.createdAt));
  const origin =
    connection.via === "openbot-browser"
      ? `Your OpenBot browser, connected ${date}`
      : `Connected ${date}${connection.via === "desktop" ? " from OpenBot Desktop" : connection.via === "web" ? " from OpenBot" : ""}`;
  const activity = connection.recording
    ? "recording now"
    : connection.lastUsedAt
      ? `last used ${relativeTime(connection.lastUsedAt)}`
      : "never used";
  return { name, detail: `${origin}, ${activity}` };
}

/**
 * One connected browser, with its own Disconnect: asked first in a dialog, because it signs that browser's Recorder out
 * and stops a recording running there, and pending for this row alone, so disconnecting one browser leaves every other
 * row's button as it was. A refusal is said in the dialog, where the person asked.
 */
function ConnectedBrowserRow({
  connection,
  detail,
  name,
  rowRef,
  canDisconnect,
  here,
  pending,
  onDisconnect,
}: {
  connection: ListedRecorderConnection;
  detail: string;
  name: string;
  rowRef?: Ref<HTMLDivElement> | undefined;
  canDisconnect: boolean;
  /** The copy of the Recorder in the browser this page is open in. */
  here: boolean;
  pending: boolean;
  onDisconnect: (button: HTMLButtonElement, which: string) => void;
}) {
  // The browser the dialog is about, by the name the row shows: "this browser" only for the copy in the browser this page
  // is open in, which every row's dialog used to say.
  const which = here
    ? "this browser"
    : connection.via === "openbot-browser"
      ? "your OpenBot browser"
      : connection.label;
  return (
    <Item ref={rowRef} size="sm" tabIndex={rowRef ? -1 : undefined}>
      <ItemMedia variant="icon">
        <IconBrowser />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="line-clamp-none block wrap-anywhere">
          {name}
        </ItemTitle>
        <ItemDescription className="line-clamp-none text-sm leading-relaxed">
          {detail}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="basis-full sm:basis-auto">
        <DeviceAction
          aria-label={`Disconnect ${name}`}
          className="min-h-12"
          variant="ghost"
          disabled={pending || !canDisconnect}
          onClick={(event) => onDisconnect(event.currentTarget, which)}
        >
          {pending ? "Disconnecting…" : "Disconnect"}
        </DeviceAction>
      </ItemActions>
    </Item>
  );
}
