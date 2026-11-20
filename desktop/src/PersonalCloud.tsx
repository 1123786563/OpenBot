import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

export const CLOUD_FRAGMENT = "personal-cloud";

export type CloudView =
  | { kind: "unavailable" }
  | { kind: "signedOut" }
  | { kind: "waiting" }
  | { kind: "signInFailed"; message: string }
  | { kind: "preparing" }
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
      recoveryCanRetry?: boolean;
      recovery?: {
        key: string;
        instruction: string;
        reasonMessage: string;
        outcomeUnknown: boolean;
        output: string | null;
        recovery: { action: "retry" | "cancel" } | null;
      }[];
      conversations: { id: string; title: string; preview: string | null }[];
    };

export type CloudAction = "status" | "start" | "cancel" | "prepare" | "signOut";

const cloudRequest = (action: CloudAction) =>
  invoke<CloudView>("personal_cloud_action", { action });
const openLocal = () => invoke<void>("personal_cloud_show_local");
const ACCESS_ERROR = "Could not check your cloud workspace. Try again.";
const PREPARE_ERROR = "Could not prepare your Personal Workspace. Try again.";

export function PersonalCloud({
  request = cloudRequest,
  showLocal = openLocal,
}: {
  request?: (action: CloudAction) => Promise<CloudView>;
  showLocal?: () => Promise<void>;
}) {
  const [view, setView] = useState<CloudView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const generation = useRef(0);
  const foreground = useRef(!document.hidden);
  const access = useRef<(() => number) | null>(null);
  const [checkVersion, recheck] = useState(0);

  const withdraw = useCallback((message: string | null) => {
    generation.current++;
    access.current = null;
    setView((current) => (current?.kind === "workspace" ? null : current));
    setFailure(message);
  }, []);

  const read = useCallback(
    async (action: CloudAction) => {
      const started = performance.now();
      const wallStarted = Date.now();
      const current = generation.current;
      const next = await request(action);
      if (current !== generation.current) return;
      if (next.kind === "workspace") {
        if (!foreground.current) return;
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
      }
      return next;
    },
    [request, withdraw],
  );

  useEffect(() => {
    const background = () => {
      foreground.current = false;
      flushSync(() => withdraw(null));
    };
    const resume = () => {
      if (document.hidden) return;
      foreground.current = true;
      flushSync(() => {
        withdraw(null);
        recheck((version) => version + 1);
      });
    };
    const visibility = () => (document.hidden ? background() : resume());
    const offline = () => flushSync(() => withdraw(ACCESS_ERROR));
    const online = () => {
      if (foreground.current) resume();
    };
    window.addEventListener("blur", background);
    window.addEventListener("focus", resume);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current++;
      window.removeEventListener("blur", background);
      window.removeEventListener("focus", resume);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
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
    if (action === "signOut") withdraw(null);
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

  async function recover(
    key: string,
    action: "cancel" | "retry",
    acknowledged: boolean,
  ) {
    if (busy || !foreground.current || !access.current || access.current() <= 0)
      return;
    const current = ++generation.current;
    setBusy(true);
    setFailure(null);
    try {
      await invoke("personal_cloud_recover", { key, action, acknowledged });
      if (current !== generation.current) return;
      const next = await read("status");
      if (next) setView(next);
    } catch (error) {
      if (current === generation.current) {
        if (error === "Your workspace has reached its Bot run limit.")
          setFailure(error);
        else withdraw("Could not update stopped work. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="sheet">
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
              {Boolean(view.recovery?.length) && (
                <section aria-labelledby="stopped-work">
                  <h3 id="stopped-work">Stopped work</h3>
                  <ul>
                    {view.recovery?.map((item) => (
                      <li key={item.key}>
                        <p>{item.instruction}</p>
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
                              ? "Queued as a new run"
                              : "Cancelled"}
                          </p>
                        ) : (
                          <form
                            onSubmit={(event) => {
                              event.preventDefault();
                              const checked = new FormData(
                                event.currentTarget,
                              ).has("acknowledged");
                              void recover(item.key, "retry", checked);
                            }}
                          >
                            {view.recoveryCanRetry && (
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
                                <button type="submit">
                                  {item.outcomeUnknown
                                    ? "Retry as a new run"
                                    : "Requeue"}
                                </button>
                              </>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                void recover(item.key, "cancel", false)
                              }
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
          {(view?.kind === "preparing" || view?.kind === "workspace") && (
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
      </div>
    </main>
  );
}
