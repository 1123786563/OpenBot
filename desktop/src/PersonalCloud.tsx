import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

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
      id: string;
      personalAssistant: { id: string; name: string };
      conversations: { id: string; title: string; preview: string | null }[];
    };

export type CloudAction = "status" | "start" | "cancel" | "prepare" | "signOut";

const cloudRequest = (action: CloudAction) =>
  invoke<CloudView>("personal_cloud_action", { action });
const openLocal = () => invoke<void>("personal_cloud_show_local");
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

  useEffect(() => {
    if (busy || view?.kind !== "workspace") return;
    const refresh = () => {
      setFailure(null);
      setView(null);
    };
    let current = true;
    const expiry = setTimeout(refresh, 45_000);
    const poll = setTimeout(async () => {
      try {
        const next = await request("status");
        if (current) setView(next);
      } catch {
        if (current) refresh();
      }
    }, 5_000);
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
      clearTimeout(expiry);
      clearTimeout(poll);
    };
  }, [busy, request, view]);

  useEffect(() => {
    if (busy || (view !== null && view.kind !== "waiting") || failure) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const next = await request("status");
        if (!active) return;
        if (next.kind === "preparing") {
          try {
            const prepared = await request("prepare");
            if (active) setView(prepared);
          } catch {
            if (active) {
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
        if (active) {
          setView(null);
          setFailure("Could not check your cloud workspace. Try again.");
        }
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [busy, failure, request, view]);

  async function run(action: CloudAction, error: string) {
    setBusy(true);
    setFailure(null);
    try {
      setView(await request(action));
    } catch {
      setFailure(error);
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
        {!busy && view?.kind === "workspace" && (
          <>
            <h2>Personal Workspace</h2>
            <p>{view.personalAssistant.name}</p>
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
