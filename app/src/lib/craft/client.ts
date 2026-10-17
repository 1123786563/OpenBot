import { client, tryClient } from "@/lib/client";
import type {
  CraftApproval,
  CraftArtifactEntry,
  CraftAttachment,
  CraftFileEntry,
  CraftMessage,
  CraftPreviewTicket,
  CraftSandboxStatusResponse,
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

/**
 * The status chip's one read (onyx's SandboxStatusResponse). The server derives the value from
 * the session row plus gateway liveness, so this poll is cheap and never resets the session's
 * idle clock — focus-driven wakes go through `getSession`, whose detail read does the wake.
 */
export function fetchSandboxStatus(
  id: string,
  signal?: AbortSignal,
): Promise<CraftSandboxStatusResponse> {
  return client(sessionPath(id, "/sandbox-status"), {
    fallback: "The sandbox status could not be loaded.",
    signal,
  }).then((r) => r.json());
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
  attachments?: CraftAttachment[],
): Promise<{ turn_id: string }> {
  return client(sessionPath(id, "/send-message"), {
    method: "POST",
    body: attachments?.length ? { content, attachments } : { content },
    fallback: "The message could not be sent.",
  }).then((r) => r.json());
}

/**
 * Upload one file into the session's attachments directory. Multipart is the one body shape
 * `client` cannot carry (it serializes JSON), so this rides a same-origin `fetch` with the
 * same credentials — still through this module, per the feature's data-access convention.
 * The server sanitizes the filename, so the response's `filename`/`path` may differ from the
 * local file's name; the chip updates to what actually landed.
 */
export async function uploadFile(
  id: string,
  file: File,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(sessionPath(id, "/upload"), {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const body = (await response.json().catch(() => null)) as
    | UploadResult
    | { error?: string }
    | null;
  if (!response.ok) {
    const error =
      body && "error" in body && typeof body.error === "string"
        ? body.error
        : "The file could not be uploaded.";
    throw new Error(error);
  }
  if (!body || typeof (body as UploadResult).path !== "string") {
    throw new Error("The file could not be uploaded.");
  }
  return body as UploadResult;
}

/** The upload endpoint's answer (onyx's UploadResponse). */
export type UploadResult = {
  filename: string;
  path: string;
  size_bytes: number;
};

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

/**
 * Exchange the signed-in session for a single-use preview pass (#360/#362).
 * The ticket appears in exactly one place — the one navigation to `origin` —
 * and is consumed by the 302 that follows; it is never stored, logged, or
 * retried with.
 */
export function issuePreviewTicket(id: string): Promise<CraftPreviewTicket> {
  return client(sessionPath(id, "/preview-ticket"), {
    method: "POST",
    fallback: "The preview pass could not be issued.",
  }).then((r) => r.json());
}

/**
 * The preview pane's same-origin liveness probe (fix-ocr13/#362): one GET that
 * answers 204 while the session's label sits registered on the preview origin,
 * and 503 with the restart sentence once it does not. The STATUS is the
 * answer — the probe's caller reads `ok` itself, so this rides `tryClient`
 * (a refusal is a value here, never a throw) and never unwraps a body.
 * `signal` is the pane's handle on the probe's lifetime: the request dies
 * when the pane does (fix-ocr16).
 */
export function previewOriginLive(
  id: string,
  signal?: AbortSignal,
): Promise<Response> {
  // tryClient returns the Response verbatim — the caller reads `ok` itself —
  // and `send` consumes no `fallback` (that is `client`'s refusal-sentence
  // option). A dead option here read as if the probe had a fallback sentence;
  // removed so the next reader does not have to trace why it never fires
  // (fix-ocr18 #5).
  return tryClient(sessionPath(id, "/preview-origin-live"), {
    signal,
  });
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
