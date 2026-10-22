/** Durable, request-scoped browser handoff shared by the computer, API, and app. */
export type HandoffStatus =
  | "waiting"
  | "taken"
  | "completed"
  | "cancelled"
  | "expired"
  | "interrupted"
  /** Ended from outside the lease: logout, disconnect policy, or a policy refusal. */
  | "refused";
export type HandoffSource =
  | "model"
  | "cloudflare"
  | "visible-challenge"
  | "manual";
export type HandoffRequest = {
  id: string;
  toolCallId?: string;
  reason: string;
  source: HandoffSource;
  status: HandoffStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  finishedAt?: string;
  interruption?: string;
  /**
  /**
   * Who took the lease, when the caller that claimed it has an identity. The id is the audit
   * actor's, injected by the server from the session; the computer never learns one on its own.
   */
  takenBy?: string;
  /**
   * The page the request was raised on, so a browser that comes back blank can be sent there again
   * before a person is asked to solve it. http(s) only; absent when the page was blank.
   */
  url?: string;
  /**
   * Set only on a request a restart interrupted while it still holds its page: the one case a later
   * request may reopen that page. A stop or reset clears it, and so does the help TTL running out.
   */
  keepsPage?: boolean;
};
export type ComputerControlState = {
  holder: "bot" | "human";
  since: string;
  requested: boolean;
  reason?: string;
  request?: HandoffRequest;
  transitioning: boolean;
  resumeSnapshotRequired: boolean;
  /** A person had the page when the computer stopped, so they must check it before the Bot acts. */
  recoveryRequired: boolean;
  secretWanted?: string;
  secretRef?: string;
  secretSnapshotId?: number;
  /**
   * When the computer was last driven by anything (a Bot's action, a person's gesture), as the
   * computer itself saw it. Unlike `since` and the run's `startedAt` — both beginnings, not
   * activity — this is the one idleness signal visible from OUTSIDE the process, so an
   * idle sweep on another server replica reads real activity instead of a stale start time.
   * Absent when the computer has just (re)started and seen nothing yet.
   */
  lastActivity?: string;
};
export type RequestHelpInput = { reason: string; toolCallId?: string };
export type ControlRequestInput = { requestId: string };
export type BrowserChallenge = {
  kind: "cloudflare" | "visible-challenge";
  reason: string;
  requestId: string;
};
