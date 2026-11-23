import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  cloudBotRuns,
  PersonalCloudBotRun,
  type TestCreditQuoteRef,
} from "./PersonalCloudBotRun";

export const CLOUD_FRAGMENT = "personal-cloud";

type WorkInterruption = {
  key: string;
  reasonMessage: string;
  outcomeUnknown: boolean;
  output: string | null;
  recordedAt?: number | null;
  recovery: { action: "retry" | "cancel"; key?: string } | null;
};

type AutomationResource = "routines" | "bindings";
type WorkspaceAction =
  | { kind: "computer"; action: "start" | "stop" }
  | { kind: "resume" | "history"; resource: AutomationResource; id: string };
type AutomationRun = {
  id: string;
  timestamp: string;
  outcome: string;
  reason: string | null;
};

export type CloudView =
  | { kind: "unavailable" }
  | { kind: "signedOut" }
  | { kind: "waiting" }
  | { kind: "signInFailed"; message: string }
  | { kind: "preparing" }
  | { kind: "admissionsPaused" }
  | {
      kind: "closed";
      operationId: string;
      executionCutoff: { sessions: string; work: string; computer: string };
      onlineCleanup: string;
      remoteRevocation: string;
      backups: string;
    }
  | {
      kind: "paused";
      operationId: string;
      reason: string | null;
      supportEmail: string | null;
    }
  | {
      kind: "workspace";
      accessMs: number;
      id: string;
      personalAssistant: { id: string; name: string };
      quotas?: Record<
        "bot" | "computer" | "storage" | "automation",
        { used: number | null; limit: number }
      > | null;
      testCredits?: {
        state: "pending" | "issued";
        amountMicrocredits: string;
        balance: { availableMicrocredits: string };
        usedUp: boolean;
        quote?:
          | (TestCreditQuoteRef & {
              model: string;
              price: { inputPerMillion: number; outputPerMillion: number };
              maxChargeMicrocredits: string;
              usageDisclosure: string;
            })
          | null;
      } | null;
      recoveryCanRetry?: boolean;
      recovery?: (WorkInterruption & {
        instruction: string;
        managed?: boolean;
      })[];
      interruptedBackgroundWork?: (WorkInterruption & {
        label: string;
        summary: string | null;
        recoveryCanRetry: boolean;
      })[];
      computer?: {
        status:
          | "not_started"
          | "starting"
          | "running"
          | "stopping"
          | "restart_required";
        cutoff: "confirmed" | "failed" | null;
      } | null;
      automation?: {
        routines: {
          id: string;
          title: string | null;
          enabled: boolean;
          blockedReason: string | null;
        }[];
        bindings: {
          id: string;
          transport: string;
          blockedReason: string | null;
        }[];
      };
      invalidatedApprovals?: { id: string; tool: string }[];
      conversations: { id: string; title: string; preview: string | null }[];
    };

export type CloudAction =
  | "status"
  | "start"
  | "cancel"
  | "prepare"
  | "signOut"
  | "closure"
  | "export";

const cloudRequest = (action: CloudAction) =>
  invoke<CloudView>("personal_cloud_action", { action });
const recoverWork = (
  key: string,
  action: "cancel" | "retry",
  acknowledged: boolean,
  quote?: TestCreditQuoteRef,
) =>
  invoke<WorkInterruption["recovery"]>("personal_cloud_recover", {
    key,
    action,
    acknowledged,
    quote,
  });
const workspaceRequest = (action: WorkspaceAction) =>
  invoke<{ runs: AutomationRun[] } | null>("personal_cloud_workspace", {
    action,
  });
const openLocal = () => invoke<void>("personal_cloud_show_local");
type AutomationItem = {
  id: string;
  title: string;
  blockedReason: string | null;
  enabled: boolean;
  resource: AutomationResource;
};
const ACCESS_ERROR = "Could not check your cloud workspace. Try again.";
const PREPARE_ERROR = "Could not prepare your Personal Workspace. Try again.";

export function PersonalCloud({
  request = cloudRequest,
  showLocal = openLocal,
  recover = recoverWork,
  workspaceAction = workspaceRequest,
  botRuns = cloudBotRuns,
}: {
  request?: (action: CloudAction) => Promise<CloudView>;
  showLocal?: () => Promise<void>;
  recover?: typeof recoverWork;
  workspaceAction?: typeof workspaceRequest;
  botRuns?: typeof cloudBotRuns;
}) {
  const [view, setView] = useState<CloudView | null>(null);
  const [history, setHistory] = useState<{
    workspaceId: string;
    key: string;
    runs: AutomationRun[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(() =>
    navigator.onLine ? null : ACCESS_ERROR,
  );

  const generation = useRef(0);
  const latestRead = useRef(0);
  const lastRun = useRef<{ workspaceId: string; id: string } | null>(null);
  const foreground = useRef(!document.hidden);
  const online = useRef(navigator.onLine);
  const access = useRef<(() => number) | null>(null);
  const [checkVersion, recheck] = useState(0);

  const withdraw = useCallback((message: string | null) => {
    generation.current++;
    access.current = null;
    setHistory(null);
    setView((current) => (current?.kind === "workspace" ? null : current));
    setFailure(message);
  }, []);

  const read = useCallback(
    async (action: CloudAction) => {
      const started = performance.now();
      const wallStarted = Date.now();
      const current = generation.current;
      const check = ++latestRead.current;
      const superseded = () =>
        current !== generation.current || check !== latestRead.current;
      const next = await request(action).catch((error: unknown) => {
        if (!superseded()) throw error;
      });
      if (!next || superseded()) return;
      if (next.kind === "workspace") {
        if (!foreground.current || !online.current || !navigator.onLine) {
          withdraw(ACCESS_ERROR);
          return;
        }
        const remaining = () =>
          next.accessMs -
          Math.max(performance.now() - started, Date.now() - wallStarted);
        if (
          !Number.isInteger(next.accessMs) ||
          next.accessMs > 60_000 ||
          remaining() <= 0 ||
          (access.current && access.current() <= 0)
        ) {
          withdraw(ACCESS_ERROR);
          return;
        }
        access.current = remaining;
      } else {
        access.current = null;
        setHistory(null);
      }
      return next;
    },
    [request, withdraw],
  );

  useEffect(() => {
    const background = () => {
      foreground.current = false;
      flushSync(() => withdraw(online.current ? null : ACCESS_ERROR));
    };
    const resume = () => {
      if (document.hidden) return;
      foreground.current = true;
      if (!online.current) return;
      flushSync(() => {
        withdraw(null);
        recheck((version) => version + 1);
      });
    };
    const visibility = () => (document.hidden ? background() : resume());
    const disconnected = () => {
      online.current = false;
      flushSync(() => withdraw(ACCESS_ERROR));
    };
    const connected = () => {
      online.current = true;
      if (foreground.current) resume();
    };
    window.addEventListener("blur", background);
    window.addEventListener("focus", resume);
    window.addEventListener("offline", disconnected);
    window.addEventListener("online", connected);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current++;
      window.removeEventListener("blur", background);
      window.removeEventListener("focus", resume);
      window.removeEventListener("offline", disconnected);
      window.removeEventListener("online", connected);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [withdraw]);

  useEffect(() => {
    if (view?.kind !== "workspace" || !access.current) return;
    const current = generation.current;
    const delay = access.current();
    const expiry = setTimeout(() => withdraw(ACCESS_ERROR), Math.max(0, delay));
    const poll = setTimeout(
      async () => {
        try {
          const next = await read("status");
          if (next) setView(next);
        } catch {
          if (generation.current === current) withdraw(ACCESS_ERROR);
        }
      },
      Math.min(5_000, Math.max(1_000, delay / 2)),
    );
    return () => {
      clearTimeout(expiry);
      clearTimeout(poll);
    };
  }, [view, read, withdraw]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus must restart a pending check even when the view is already blank.
  useEffect(() => {
    if (
      !foreground.current ||
      !online.current ||
      busy ||
      (view !== null && view.kind !== "waiting") ||
      failure
    )
      return;
    let active = true;
    const current = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await read("status");
        if (!active || !next) return;
        if (next.kind === "preparing") {
          try {
            const prepared = await read("prepare");
            if (active && prepared) setView(prepared);
          } catch {
            if (active && current === generation.current) {
              setView(next);
              setFailure(PREPARE_ERROR);
            }
          }
        } else if (view?.kind === "waiting" && next.kind === "waiting") {
          timer = setTimeout(check, 350);
        } else {
          setView(next);
        }
      } catch {
        if (active && current === generation.current) {
          setView(null);
          setFailure(ACCESS_ERROR);
        }
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [busy, checkVersion, failure, read, view]);

  async function run(action: CloudAction, error: string) {
    generation.current++;
    if (action === "signOut") {
      lastRun.current = null;
      withdraw(null);
    }
    const current = generation.current;
    setBusy(true);
    setFailure(null);
    try {
      const next = await read(action);
      if (next) setView(next);
    } catch {
      if (current === generation.current) setFailure(error);
    } finally {
      setBusy(false);
    }
  }

  async function manageWorkspace(work: () => Promise<void>, message: string) {
    if (busy || !foreground.current || !access.current || access.current() <= 0)
      return;
    const current = ++generation.current;
    setBusy(true);
    setFailure(null);
    try {
      await work();
      if (current !== generation.current) return;
      const next = await read("status");
      if (next) setView(next);
    } catch (error) {
      if (current === generation.current) {
        if (
          error === "Your workspace has reached its Bot run limit." ||
          error === "Your workspace has reached its resource limit." ||
          error === "Not enough Test Credits to reserve this Bot run." ||
          error ===
            "Refresh your workspace and review the current Test Credit price before retrying."
        )
          setFailure(error);
        else withdraw(message);
      }
    } finally {
      setBusy(false);
    }
  }

  function update(action: WorkspaceAction) {
    void manageWorkspace(async () => {
      await workspaceAction(action);
    }, "Could not update this workspace item. Try again.");
  }

  function showHistory(resource: AutomationResource, id: string) {
    if (view?.kind !== "workspace") return;
    const workspaceId = view.id;
    void manageWorkspace(async () => {
      const current = generation.current;
      const result = await workspaceAction({ kind: "history", resource, id });
      if (
        result &&
        current === generation.current &&
        access.current &&
        access.current() > 0
      )
        setHistory({
          workspaceId,
          key: `${resource}/${id}`,
          runs: result.runs,
        });
    }, "Could not load this history. Try again.");
  }

  function resolve(
    key: string,
    action: "cancel" | "retry",
    acknowledged: boolean,
    quote?: TestCreditQuoteRef,
  ) {
    const workspaceId = workspace?.id;
    void manageWorkspace(async () => {
      const current = generation.current;
      const recovery = await recover(key, action, acknowledged, quote);
      if (
        quote &&
        workspaceId &&
        current === generation.current &&
        recovery?.action === "retry" &&
        recovery.key
      )
        lastRun.current = { workspaceId, id: recovery.key };
    }, "Could not update stopped work. Try again.");
  }

  const workspace = view?.kind === "workspace" ? view : null;
  const runId =
    view?.kind === "workspace" && lastRun.current?.workspaceId === view.id
      ? lastRun.current.id
      : null;
  const stoppedWork = [
    ...(workspace?.recovery ?? []).map(({ instruction, managed, ...item }) => {
      const quote = managed
        ? (workspace?.testCredits?.quote ?? undefined)
        : undefined;
      return {
        ...item,
        quote,
        label: instruction,
        summary: null,
        canRetry: managed ? Boolean(quote) : workspace?.recoveryCanRetry,
        retryText: quote
          ? item.outcomeUnknown
            ? "Retry with Test Credits"
            : "Requeue with Test Credits"
          : item.outcomeUnknown
            ? "Retry as a new run"
            : "Requeue",
        retryResult: "Queued as a new run",
      };
    }),
    ...(workspace?.interruptedBackgroundWork ?? []).map((item) => ({
      ...item,
      quote: undefined,
      canRetry: item.recoveryCanRetry,
      retryText: "Start fresh work",
      retryResult: "Started as fresh work",
    })),
  ];
  const automation = workspace?.automation;
  const automations = [
    ...(automation?.routines ?? []).map<AutomationItem>(
      ({ id, title, enabled, blockedReason }) => ({
        id,
        title: title ?? "Routine",
        enabled,
        blockedReason,
        resource: "routines",
      }),
    ),
    ...(automation?.bindings ?? []).map<AutomationItem>(
      ({ id, transport, blockedReason }) => ({
        id,
        title: transport,
        enabled: true,
        blockedReason,
        resource: "bindings",
      }),
    ),
  ];
  const computer = workspace?.computer;
  const computerAction = computer?.status === "running" ? "stop" : "start";

  return (
    <main>
      <section className="sheet" aria-label="OpenBot Cloud">
        <h1>OpenBot Cloud</h1>
        {view === null && !failure && (
          <p role="status">Checking your cloud workspace…</p>
        )}
        {failure && <p role="alert">{failure}</p>}
        {view?.kind === "unavailable" && (
          <p role="alert">
            This desktop build has no OpenBot Cloud address configured.
          </p>
        )}
        {view === null && failure && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setFailure(null)}
          >
            Try again
          </button>
        )}
        {(view?.kind === "signedOut" || view?.kind === "signInFailed") && (
          <>
            {view.kind === "signInFailed" && !failure && (
              <p role="alert">{view.message}</p>
            )}
            <p className="lede">
              Sign in to the same Personal Workspace you use on the web.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("start", "Could not open browser sign-in. Try again.")
              }
            >
              Sign in with browser
            </button>
          </>
        )}
        {view?.kind === "paused" && (
          <>
            <h2>Personal Workspace paused</h2>
            {view.reason && <p>{view.reason}</p>}
            <p>
              Operation ID <code>{view.operationId}</code>
            </p>
            {view.supportEmail && (
              <p>
                Contact support at <span>{view.supportEmail}</span>.
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("start", "Could not open browser sign-in. Try again.")
              }
            >
              Sign in again
            </button>
          </>
        )}
        {view?.kind === "closed" && (
          <>
            <h2>Workspace closure progress</h2>
            <p>
              Operation ID <code>{view.operationId}</code>
            </p>
            <dl>
              <dt>Application sessions</dt>
              <dd>{view.executionCutoff.sessions}</dd>
              <dt>Work cutoff</dt>
              <dd>{view.executionCutoff.work}</dd>
              <dt>Computer exit</dt>
              <dd>{view.executionCutoff.computer}</dd>
              <dt>Online data cleanup</dt>
              <dd>{view.onlineCleanup}</dd>
              <dt>Third-party revocation</dt>
              <dd>{view.remoteRevocation}</dd>
              <dt>Backup expiration</dt>
              <dd>{view.backups}</dd>
            </dl>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("start", "Could not open browser sign-in. Try again.")
              }
            >
              Sign in again
            </button>
          </>
        )}
        {(view?.kind === "paused" ||
          view?.kind === "workspace" ||
          view?.kind === "closed") && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(
                "closure",
                "Could not open workspace closure. Try again.",
              )
            }
          >
            {view.kind === "closed"
              ? "Check progress in browser"
              : "Close workspace in browser"}
          </button>
        )}
        {view?.kind === "waiting" && (
          <>
            <p role="status">Finish signing in in your browser.</p>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run("cancel", "Could not cancel sign-in. Try again.")
              }
            >
              Cancel sign-in
            </button>
          </>
        )}
        {view?.kind === "admissionsPaused" && (
          <>
            <p role="status">New workspace openings are temporarily paused.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("prepare", PREPARE_ERROR)}
            >
              Retry setup
            </button>
          </>
        )}
        {view?.kind === "preparing" && (
          <>
            <p role="status">Your Personal Workspace is being prepared.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("prepare", PREPARE_ERROR)}
            >
              Retry setup
            </button>
          </>
        )}
        {!busy &&
          view?.kind === "workspace" &&
          access.current &&
          access.current() > 0 && (
            <>
              <h2>Personal Workspace</h2>
              <p>{view.personalAssistant.name}</p>
              {view.quotas && (
                <section aria-labelledby="workspace-usage">
                  <h3 id="workspace-usage">Workspace usage</h3>
                  <ul>
                    <li>
                      Bot runs: {view.quotas.bot.used} / {view.quotas.bot.limit}
                    </li>
                    <li>
                      Computers: {view.quotas.computer.used ?? "Unavailable"} /{" "}
                      {view.quotas.computer.limit}
                    </li>
                    <li>
                      Workspace storage:{" "}
                      {view.quotas.storage.used ?? "Unavailable"} /{" "}
                      {view.quotas.storage.limit} bytes
                    </li>
                    <li>
                      Automation triggers: {view.quotas.automation.used} /{" "}
                      {view.quotas.automation.limit} per minute
                    </li>
                  </ul>
                </section>
              )}
              {stoppedWork.length > 0 && (
                <section aria-labelledby="stopped-work">
                  <h3 id="stopped-work">Stopped work</h3>
                  <ul>
                    {stoppedWork.map((item) => (
                      <li key={item.key}>
                        <p>{item.label}</p>
                        {item.summary && <p>{item.summary}</p>}
                        {item.recordedAt && (
                          <p>{new Date(item.recordedAt).toLocaleString()}</p>
                        )}
                        <p>{item.reasonMessage}</p>
                        {item.output && (
                          <>
                            <p>Output before interruption</p>
                            <pre>{item.output}</pre>
                          </>
                        )}
                        {item.outcomeUnknown && (
                          <p>
                            Check any external actions before retrying. Their
                            outcome is unknown.
                          </p>
                        )}
                        {item.recovery ? (
                          <p>
                            {item.recovery.action === "retry"
                              ? item.retryResult
                              : "Cancelled"}
                          </p>
                        ) : (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              const checked = new FormData(
                                event.currentTarget,
                              ).has("acknowledged");
                              const quote = item.quote && {
                                route: item.quote.route,
                                priceVersion: item.quote.priceVersion,
                              };
                              if (item.canRetry)
                                resolve(item.key, "retry", checked, quote);
                            }}
                          >
                            {item.quote && (
                              <p>
                                {item.quote.model} costs{" "}
                                {item.quote.price.inputPerMillion} microcredits
                                per million input tokens and{" "}
                                {item.quote.price.outputPerMillion} microcredits
                                per million output tokens. Maximum reservation
                                for the new run:{" "}
                                {item.quote.maxChargeMicrocredits} microcredits.{" "}
                                {item.quote.usageDisclosure}
                              </p>
                            )}
                            {item.canRetry && (
                              <>
                                {item.outcomeUnknown && (
                                  <label>
                                    <input
                                      name="acknowledged"
                                      type="checkbox"
                                      required
                                    />{" "}
                                    I checked the external actions.
                                  </label>
                                )}
                                <button type="submit">{item.retryText}</button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() => resolve(item.key, "cancel", false)}
                            >
                              Cancel item
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {(computer ||
                (view.computer === null &&
                  view.quotas?.computer.used === null)) && (
                <section aria-labelledby="workspace-computer">
                  <h3 id="workspace-computer">Computer</h3>
                  <p>
                    {computer
                      ? {
                          not_started: "Ready to set up",
                          starting: "Starting",
                          running: "Running",
                          stopping: "Stopping",
                          restart_required:
                            "Stopped. Your saved files and settings are kept.",
                        }[computer.status]
                      : "Computer status unavailable"}
                  </p>
                  {computer?.cutoff === "failed" && (
                    <p>
                      Computer exit could not be confirmed by the authorization
                      deadline.
                    </p>
                  )}
                  {computer &&
                    computer.status !== "starting" &&
                    computer.status !== "stopping" && (
                      <button
                        type="button"
                        onClick={() =>
                          update({ kind: "computer", action: computerAction })
                        }
                      >
                        {computerAction === "start"
                          ? "Start Computer"
                          : "Stop Computer"}
                      </button>
                    )}
                </section>
              )}
              {automations.length > 0 && (
                <section aria-labelledby="workspace-automation">
                  <h3 id="workspace-automation">
                    Routines and inbound bindings
                  </h3>
                  <ul>
                    {automations.map(
                      ({ id, title, resource, blockedReason, enabled }) => (
                        <li key={`${resource}/${id}`}>
                          <p>
                            {resource === "routines"
                              ? "Routine"
                              : "Inbound binding"}{" "}
                            · {title}
                          </p>
                          {blockedReason === "manual_resume_required" ? (
                            <p>Resume this item to accept new work.</p>
                          ) : blockedReason ? (
                            <p>Execution paused ({blockedReason}).</p>
                          ) : (
                            !enabled && <p>Switched off</p>
                          )}
                          {blockedReason === "manual_resume_required" && (
                            <button
                              type="button"
                              onClick={() =>
                                update({ kind: "resume", resource, id })
                              }
                            >
                              Resume
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => showHistory(resource, id)}
                          >
                            View history
                          </button>
                          {history?.workspaceId === view.id &&
                            history.key === `${resource}/${id}` &&
                            (history.runs.length > 0 ? (
                              <ul>
                                {history.runs.map((item) => (
                                  <li key={item.id}>
                                    <time dateTime={item.timestamp}>
                                      {new Date(
                                        item.timestamp,
                                      ).toLocaleString()}
                                    </time>
                                    {" · "}
                                    {item.outcome}
                                    {item.reason ? ` · ${item.reason}` : ""}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p>No history yet.</p>
                            ))}
                        </li>
                      ),
                    )}
                  </ul>
                </section>
              )}
              {Boolean(view.invalidatedApprovals?.length) && (
                <section aria-labelledby="invalidated-approvals">
                  <h3 id="invalidated-approvals">Invalidated approvals</h3>
                  <ul>
                    {view.invalidatedApprovals?.map((item) => (
                      <li key={item.id}>{item.tool} · Invalidated</li>
                    ))}
                  </ul>
                </section>
              )}
              <button
                type="button"
                onClick={() =>
                  void run(
                    "export",
                    "Could not open workspace export. Try again.",
                  )
                }
              >
                Export workspace data in browser
              </button>
              {view.testCredits && (
                <section aria-labelledby="test-credits">
                  <h3 id="test-credits">Test Credits</h3>
                  {view.testCredits.state === "issued" ? (
                    <p>
                      Granted {view.testCredits.amountMicrocredits}{" "}
                      microcredits. Available{" "}
                      {view.testCredits.balance.availableMicrocredits}.
                    </p>
                  ) : (
                    <p>Your one-time grant is pending.</p>
                  )}
                  {view.testCredits.usedUp && <p>Test Credits are used up.</p>}
                  {view.testCredits.quote && (
                    <>
                      <p>
                        {view.testCredits.quote.model} costs{" "}
                        {view.testCredits.quote.price.inputPerMillion}{" "}
                        microcredits per million input tokens and{" "}
                        {view.testCredits.quote.price.outputPerMillion}{" "}
                        microcredits per million output tokens.
                      </p>
                      <p>
                        Maximum reservation per run:{" "}
                        {view.testCredits.quote.maxChargeMicrocredits}{" "}
                        microcredits. {view.testCredits.quote.usageDisclosure}
                      </p>
                    </>
                  )}
                </section>
              )}
              {(view.testCredits?.quote || runId) && (
                <PersonalCloudBotRun
                  key={view.id}
                  workspaceId={view.id}
                  botId={view.personalAssistant.id}
                  initialRunId={runId}
                  quote={view.testCredits?.quote}
                  onAccept={(id) => {
                    lastRun.current = { workspaceId: view.id, id };
                  }}
                  canStart={
                    Boolean(view.testCredits?.quote) &&
                    view.testCredits?.state === "issued" &&
                    !view.testCredits.usedUp
                  }
                  runs={botRuns}
                />
              )}
              <section aria-labelledby="recent-conversations">
                <h3 id="recent-conversations">Recent conversations</h3>
                {view.conversations.length === 0 ? (
                  <p>No conversations yet.</p>
                ) : (
                  <ul>
                    {view.conversations.map(({ id, title, preview }) => (
                      <li key={id}>
                        <strong>{title}</strong>
                        {preview && <p>{preview}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        <div className="row">
          {(view?.kind === "preparing" ||
            view?.kind === "admissionsPaused" ||
            view?.kind === "workspace") && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run("signOut", "Could not sign out of cloud. Try again.")
              }
            >
              Sign out of cloud
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void showLocal().catch(() =>
                setFailure("Could not open local OpenBot. Try again."),
              );
            }}
          >
            Open local OpenBot
          </button>
        </div>
      </section>
    </main>
  );
}
