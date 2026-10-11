import { client } from "@/lib/client";
import type {
  CraftApproval,
  CraftArtifactEntry,
  CraftFileEntry,
  CraftMessage,
  CraftSession,
  CraftWebappInfo,
} from "./types";

/**
 * The craft feature's REST surface, typed for the browser.
 *
 * Every response shape mirrors the server's `/api/craft/**` routes field-for-field (`client` owns
 * the transport and the failure sentence; this module owns the paths and the return types). The
 * stream itself is raw SSE, read by `lib/craft/streaming.ts`, so the only pieces here are the
 * JSON reads and the URL builders the browser and the two fetch paths share.
 */

const craftPath = (suffix = "") => `/api/craft${suffix}`;
const sessionPath = (id: string, suffix = "") =>
  `/api/craft/sessions/${encodeURIComponent(id)}${suffix}`;

// ── sessions ────────────────────────────────────────────────────────────────────

/** The sidebar's session list: the user's interactive sessions, newest first. */
export function listSessions(signal?: AbortSignal): Promise<CraftSession[]> {
  return client(craftPath("/sessions"), {
    fallback: "The craft sessions could not be loaded.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { sessions: CraftSession[] }) => body.sessions);
}

/** Create (or reuse) an empty session; returns the session the UI navigates to. */
export function createSession(): Promise<CraftSession> {
  return client(craftPath("/sessions"), {
    method: "POST",
    body: {},
    fallback: "A craft session could not be created.",
  }).then((r) => r.json());
}

/** One session's detail, after the server's sleep→wake on an idle row. */
export function getSession(
  id: string,
  signal?: AbortSignal,
): Promise<CraftSession> {
  return client(sessionPath(id), {
    fallback: "The craft session could not be loaded.",
    signal,
  }).then((r) => r.json());
}

export function renameSession(id: string, name: string): Promise<CraftSession> {
  return client(sessionPath(id, "/name"), {
    method: "PUT",
    body: { name },
    fallback: "The session could not be renamed.",
  }).then((r) => r.json());
}

export function deleteSession(id: string): Promise<void> {
  return client(sessionPath(id), {
    method: "DELETE",
    fallback: "The session could not be deleted.",
  }).then(() => undefined);
}

export function generateSessionName(id: string): Promise<string> {
  return client(sessionPath(id, "/generate-name"), {
    method: "POST",
    fallback: "The session name could not be generated.",
  })
    .then((r) => r.json())
    .then((body: { name: string }) => body.name);
}

// ── messages / turns ────────────────────────────────────────────────────────────

export function listMessages(
  id: string,
  signal?: AbortSignal,
): Promise<CraftMessage[]> {
  return client(sessionPath(id, "/messages"), {
    fallback: "The messages could not be loaded.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { messages: CraftMessage[] }) => body.messages);
}

/** Send a turn. The response carries the turn id the SSE stream is addressed by. */
export function sendMessage(
  id: string,
  content: string,
): Promise<{ turn_id: string }> {
  return client(sessionPath(id, "/send-message"), {
    method: "POST",
    body: { content },
    fallback: "The message could not be sent.",
  }).then((r) => r.json());
}

/** Ask a running turn to stop; settles the session's live stream. */
export function interruptSession(id: string): Promise<void> {
  return client(sessionPath(id, "/interrupt"), {
    method: "POST",
    fallback: "The turn could not be stopped.",
  }).then(() => undefined);
}

/** The SSE URL for a turn's events; the browser (not `client`) reads it. */
export function turnEventsUrl(sessionId: string, turnId: string): string {
  return sessionPath(sessionId, `/turns/${encodeURIComponent(turnId)}/events`);
}

// ── artifacts / files ───────────────────────────────────────────────────────────

export function listArtifacts(
  id: string,
  signal?: AbortSignal,
): Promise<CraftArtifactEntry[]> {
  return client(sessionPath(id, "/artifacts"), {
    fallback: "The artifacts could not be listed.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { artifacts: CraftArtifactEntry[] }) => body.artifacts);
}

export function listFiles(
  id: string,
  path = "",
  signal?: AbortSignal,
): Promise<CraftFileEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return client(sessionPath(id, `/files${query}`), {
    fallback: "The files could not be listed.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { entries: CraftFileEntry[] }) => body.entries);
}

/** A same-origin download URL for one artifact's bytes. */
export function artifactUrl(id: string, path: string): string {
  return sessionPath(id, `/artifacts/${encodeURIComponent(path)}`);
}

/** A same-origin URL that exports a markdown file as .docx. */
export function exportDocxUrl(id: string, path: string): string {
  return sessionPath(id, `/export-docx/${encodeURIComponent(path)}`);
}

// ── webapp ──────────────────────────────────────────────────────────────────────

export function webappInfo(
  id: string,
  signal?: AbortSignal,
): Promise<CraftWebappInfo> {
  return client(sessionPath(id, "/webapp-info"), {
    fallback: "The web app could not be inspected.",
    signal,
  }).then((r) => r.json());
}

// ── approvals ───────────────────────────────────────────────────────────────────

export function listLiveApprovals(
  id: string,
  signal?: AbortSignal,
): Promise<CraftApproval[]> {
  return client(sessionPath(id, "/approvals/live"), {
    fallback: "The pending approvals could not be loaded.",
    signal,
  })
    .then((r) => r.json())
    .then((body: { approvals: CraftApproval[] }) => body.approvals);
}

export function decideCraftApproval(
  approvalId: string,
  decision: "allow_once" | "allow_always" | "deny",
): Promise<void> {
  return client(
    craftPath(`/approvals/${encodeURIComponent(approvalId)}/decision`),
    {
      method: "POST",
      body: { decision },
      fallback: "The approval could not be recorded.",
    },
  ).then(() => undefined);
}
