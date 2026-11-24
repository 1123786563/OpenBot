import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type {
  BrowserApiState,
  BrowserOpenResponse,
  RealBrowserOpenResponse,
} from "@openbot/shared/openbot-browser";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { DevicePage } from "@/components/astryx-pilot/device-page";
import { PageEmpty } from "@/components/layout/page-shell";
import { ReadError, ReadStatus } from "@/components/layout/read-status";
import { openBrowserMutationOptions } from "@/lib/browser/mutations";
import { browserStateQueryOptions } from "@/lib/browser/queries";
import { ClientError, canKeepCachedRead } from "@/lib/client";
import { recorderKeys } from "@/lib/recorder/queries";
import { queryClient } from "@/query-client";
import { TEACH_A_BOT } from "./browser-nav-item";
import { OpeningBrowser, ScreenBrowser } from "./browser-screen";
import { TeachSteps } from "./teach-steps";
import { recordingOnItsWay, YourRecordings } from "./your-recordings";

const TITLE = TEACH_A_BOT;
const DESCRIPTION =
  "Show your Bots how to do a task. Press Record, name the task, and do it once in the browser.";
const RECORDINGS_DESCRIPTION =
  "View past recordings, or open your browser to record another task.";
const OPEN_FAILURE = "Couldn’t open your browser. Try again to reconnect.";

/**
 * The way from what was taught to what it became: the skills a Bot learned from recordings are in Settings, Learning,
 * with automatic learning and sharing. A link there, so this page stays the place to teach and the settings stay there.
 */
function LearnedLink() {
  return (
    <Link
      className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
      to="/settings/learning"
    >
      See what your Bots learned
    </Link>
  );
}

/**
 * What Teach a Bot is for, above the browser it is done in: the page's title and the whole of how, in one sentence.
 * The page's own title, as every page has one; the browser below it is the tool, not the page.
 */
function TeachHeading({ headingRef }: { headingRef: Ref<HTMLHeadingElement> }) {
  return (
    <header className="flex flex-col gap-1">
      <h1
        className="font-semibold text-2xl tracking-tight"
        ref={headingRef}
        tabIndex={-1}
      >
        {TITLE}
      </h1>
      <p className="text-pretty text-muted-foreground text-sm">{DESCRIPTION}</p>
    </header>
  );
}

/**
 * The Browser page: the signed-in person's own browser, opened when they arrive, and Record and Stop for it.
 *
 * Its state is read every second while the page is open, as the computer's control state is, because what changes
 * (the tabs, a recording's actions) changes in the browser rather than here.
 */
export function BrowserPage() {
  return (
    <section aria-label={TITLE} className="contents">
      <BrowserContent />
    </section>
  );
}

function BrowserContent() {
  const state = useQuery(browserStateQueryOptions({ poll: true }));
  // A recording that stops, here or in the browser, is a new row or a final state in the list beneath.
  const phase = state.data?.recorder?.phase;
  const before = useRef(phase);
  useEffect(() => {
    const was = before.current;
    before.current = phase;
    if ((was === "recording" || was === "stopping") && phase === "idle")
      queryClient.invalidateQueries({ queryKey: recorderKeys.recordings() });
  }, [phase]);
  // A stopped recording still on its way, or kept in the browser to be sent again, lands later: a new row then.
  const waiting = recordingOnItsWay(state.data?.recorder?.lastStopped);
  const wasWaiting = useRef(waiting);
  useEffect(() => {
    const was = wasWaiting.current;
    wasWaiting.current = waiting;
    if (was && !waiting)
      queryClient.invalidateQueries({ queryKey: recorderKeys.recordings() });
  }, [waiting]);
  if (state.isPending && state.errorUpdateCount === 0) {
    return (
      <DevicePage title={TITLE} description={DESCRIPTION}>
        <ReadStatus kind="loading" message="Checking your browser…" />
      </DevicePage>
    );
  }
  // Branched on the data rather than the error: a poll that fails after the page has opened keeps the browser on
  // screen, where tearing it down would open it all over again.
  if (!state.data || !canKeepCachedRead(state.error)) {
    const signedOut =
      state.error instanceof ClientError && state.error.status === 401;
    return (
      <DevicePage title={TITLE} description={DESCRIPTION}>
        <ReadError
          description={
            signedOut
              ? "Sign in again to continue."
              : state.error instanceof ClientError && state.error.status === 403
                ? "Ask your administrator if you need access to this browser."
                : state.data === null
                  ? "Check that you still have access, then try again."
                  : undefined
          }
          message="Couldn't load your browser."
          retry={state.refetch}
          retryBelow
          retryLabel="Retry browser status"
          retrying={state.isFetching}
        />
        {signedOut ? null : <YourRecordings action={<LearnedLink />} />}
      </DevicePage>
    );
  }
  const statusNotice = state.isRefetchError ? (
    <ReadError
      description="The last known browser and recording status is shown below."
      message="Couldn't refresh browser status."
      retry={state.refetch}
      retryBelow
      retryLabel="Retry browser status"
      retrying={state.isFetching}
    />
  ) : null;
  if (!state.data.available) {
    // Why, where the server can say: its Bots share one computer, say, which is no place for a browser of the person's.
    return (
      <DevicePage title={TITLE}>
        {statusNotice}
        <PageEmpty>
          {state.data.note ??
            "OpenBot isn't set up to run a browser for you. Ask an admin."}
        </PageEmpty>
        <YourRecordings action={<LearnedLink />} />
      </DevicePage>
    );
  }
  return <OpenedBrowser state={state.data} statusNotice={statusNotice} />;
}

/**
 * Shows the browser the way the server says it shows. A window on the person's desktop (`native`) opens when they press
 * Open, so arriving here opens nothing. A browser in the page is the page itself, so it opens once on arrival.
 */
function OpenedBrowser({
  state,
  statusNotice,
}: {
  state: BrowserApiState;
  statusNotice: ReactNode;
}) {
  const native = state.shows === "native";
  // The Recorder's "See it on Teach a Bot" link (`?recordings`) is to the list, so it opens no browser on arrival.
  const recordingsOnly = "recordings" in useSearch({ strict: false });
  const open = useMutation(openBrowserMutationOptions(queryClient));
  // Its own mutation, so bringing the browser forward never blanks the page while it is asked.
  const reopen = useMutation(openBrowserMutationOptions(queryClient));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterOpen = useRef(false);
  const attachHeading = useCallback((heading: HTMLHeadingElement | null) => {
    // The opening pane can already have focus after retrying the status read.
    if (!heading && headingRef.current === document.activeElement) {
      focusAfterOpen.current = true;
    }
    headingRef.current = heading;
  }, []);
  // Once per arrival. A ref, not the mutation's state, because a development build runs this effect twice.
  const asked = useRef(false);
  const { mutate } = open;
  useEffect(() => {
    if (native || recordingsOnly || asked.current) return;
    asked.current = true;
    mutate();
  }, [mutate, native, recordingsOnly]);
  const opened: BrowserOpenResponse | RealBrowserOpenResponse | undefined =
    reopen.data ?? open.data;
  useLayoutEffect(() => {
    if (!opened || !focusAfterOpen.current) return;
    focusAfterOpen.current = false;
    if (document.activeElement === document.body) headingRef.current?.focus();
  }, [opened]);

  // A window on the person's desktop opens with Start recording, from the page itself.
  if (native)
    return <NativeBrowser state={state} statusNotice={statusNotice} />;
  const heading = (
    <>
      <TeachHeading headingRef={attachHeading} />
      {statusNotice}
    </>
  );
  if (!opened) {
    // A browser that is there and not answering says so while it is asked to open, rather than leaving the page empty.
    const said = state.problem ?? (open.isError ? OPEN_FAILURE : undefined);
    if (!recordingsOnly)
      // Opening: the page as it will be, its browser saying it is opening (`OpeningBrowser`), or why it has not.
      return (
        <OpeningBrowser
          heading={heading}
          onRetry={open.error ? () => open.mutate() : undefined}
          problem={said}
        >
          <YourRecordings
            action={<LearnedLink />}
            variant="pane"
            waiting={recordingOnItsWay(state.recorder?.lastStopped)}
          />
        </OpeningBrowser>
      );
    // The Recorder's link to the list opens no browser on arrival: the list, and Open browser to open one.
    return (
      <DevicePage title={TITLE} description={RECORDINGS_DESCRIPTION}>
        {statusNotice}
        <VStack align="start" gap={3} paddingBlockStart={6}>
          {open.isPending ? (
            <ReadStatus kind="loading" message="Opening your browser…" />
          ) : said ? (
            <Text
              as="p"
              color="secondary"
              role={open.isError ? "alert" : "status"}
              size="sm"
            >
              {said}
            </Text>
          ) : null}
          <Button
            clickAction={async (event) => {
              focusAfterOpen.current =
                event.currentTarget === document.activeElement;
              await open.mutateAsync().catch(() => undefined);
            }}
            isLoading={open.isPending}
            label={open.isError ? "Retry opening browser" : "Open browser"}
            size="lg"
            style={{
              borderRadius: "var(--radius-lg)",
              minHeight: "var(--spacing-11)",
              paddingInline: "var(--spacing-3)",
            }}
            variant="primary"
          />
        </VStack>
        <YourRecordings
          action={<LearnedLink />}
          waiting={recordingOnItsWay(state.recorder?.lastStopped)}
        />
      </DevicePage>
    );
  }
  // The person's own everyday browser has no screen here: it is a window on their desktop.
  if ("window" in opened && opened.window === "screen") {
    // ScreenBrowser is deliberately not a PageShell (the browser takes the pane). The page's title goes above the
    // browser and the list under it, in the one column the browser sets the width of.
    return (
      <ScreenBrowser
        computerId={opened.computerId}
        heading={heading}
        state={state}
        reopen={() => reopen.mutate()}
        reopenFailed={reopen.isError}
        reopening={reopen.isPending}
      >
        <YourRecordings
          action={<LearnedLink />}
          variant="pane"
          waiting={recordingOnItsWay(state.recorder?.lastStopped)}
        />
      </ScreenBrowser>
    );
  }
  // Only an older server says nothing of where its browser shows, and it may answer with a window after all.
  return (
    <NativeBrowser
      headingRef={attachHeading}
      state={state}
      statusNotice={statusNotice}
    />
  );
}

/**
 * THE PERSON'S BROWSER AS A WINDOW ON THEIR DESKTOP (a host-side computer of people's browsers, as scripts/start.sh
 * runs one): their own Chrome, or Edge, in a profile of its own. The page walks the person through it in three steps (`TeachSteps`): what it does, naming the task, and opening
 * the browser already recording. They stop in the browser, from the Recorder's mark at the top of each page, which asks
 * whether to save the recording, or here with Stop, which saves it.
 */
function NativeBrowser({
  headingRef,
  state,
  statusNotice,
}: {
  headingRef?: Ref<HTMLHeadingElement>;
  state: BrowserApiState;
  statusNotice: ReactNode;
}) {
  return (
    <DevicePage headingRef={headingRef} title={TITLE}>
      {statusNotice}
      <TeachSteps state={state} />
      <YourRecordings
        action={<LearnedLink />}
        waiting={recordingOnItsWay(state.recorder?.lastStopped)}
      />
    </DevicePage>
  );
}
