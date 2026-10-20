import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { asProblem, Failure } from "./Problem";

/**
 * The receipt `leave_organization` answers with: what one cleanup removed.
 * Identifiers and counts only — no session bytes, no credential values.
 */
export type CleanupReceipt = {
  authority: string;
  credentials: string[];
  subscriptions: string[];
  mediaEntries: number;
  cacheEntries: number;
  completed: boolean;
};

/**
 * Leave this installation's organization (MT100 / Issue #143): the button wipes
 * exactly that organization's media, caches, subscriptions and credentials, then
 * retires the frozen context so the next sign-in may be any organization. A run
 * that did not finish says so and offers itself again — a retry is always safe.
 */
export function OrgSwitchCleanup({
  root,
  onLeft,
}: {
  root: string;
  onLeft?: (receipt: CleanupReceipt) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<CleanupReceipt | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof asProblem> | null>(
    null,
  );

  async function leave() {
    setBusy(true);
    setFailure(null);
    try {
      const cleaned = await invoke<CleanupReceipt>("leave_organization", {
        root,
      });
      setReceipt(cleaned);
      if (cleaned.completed) await onLeft?.(cleaned);
    } catch (error) {
      setFailure(asProblem(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet">
      <h1>Leave this organization</h1>
      <p>
        OpenBot removes this organization's files, caches, subscriptions and
        credentials from this computer. Your other organizations and your own
        provider keys stay exactly as they are.
      </p>
      <button type="button" disabled={busy} onClick={() => void leave()}>
        {receipt && !receipt.completed ? "Try again" : "Leave organization"}
      </button>
      {receipt && (
        <div role="status">
          {receipt.completed ? (
            <p>Removed this organization's data:</p>
          ) : (
            <p>
              Some of this organization's files could not be removed. Nothing
              was half-cleaned — try again.
            </p>
          )}
          <ul>
            <li>{receipt.credentials.length} credential(s)</li>
            <li>{receipt.subscriptions.length} subscription(s)</li>
            <li>{receipt.mediaEntries} media file(s)</li>
            <li>{receipt.cacheEntries} cache file(s)</li>
          </ul>
        </div>
      )}
      {failure && <Failure problem={failure} />}
    </div>
  );
}
