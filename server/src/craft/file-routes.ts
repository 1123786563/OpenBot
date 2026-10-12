/**
 * The craft file surface — the port of onyx `session/api.py`'s upload / delete-file /
 * download-directory trio (§1.1), Hono-shaped against the agent-sandbox gateway's file verbs.
 *
 * - POST   /sessions/:id/upload                → attachments/{sanitized name}, 400/429/404
 * - DELETE /sessions/:id/files/*path           → 204; 403 traversal, 404 absent-or-directory
 * - GET    /sessions/:id/download-directory/*  → ZIP of one workspace directory (onyx parity)
 *
 * Error semantics follow onyx exactly where the channel allows: empty/oversize file → 400;
 * per-session count or total limits → 429; unknown session → 404; path traversal → 403; a
 * directory under DELETE is the same 404 as absence (onyx's `[ -f ] && rm`). The one channel
 * divergence: the sandbox write is the gateway's POST /file (binary body), whose own ceiling
 * (agent-sandbox SANDBOX_MAX_UPLOAD_BYTES) can refuse what craft's limit admitted — that maps
 * to 413, so the deployment knob is visible instead of silently truncated.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getLogger } from "../../../shared/logger";
import type { AppVariables } from "../auth/guards";
import { safeJoin } from "./artifact-routes";
import type { CraftConfig } from "./config";
import { packDirectoryZip } from "./directory-archive";
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import {
  collisionFreeName,
  forgetUpload,
  getUploadStats,
  recordUpload,
  sanitizeFilename,
  validateFileSize,
} from "./uploads";
import { sessionDirectory } from "./workspace";
import { buildContentDisposition, sanitizeZipBasename } from "./zip-archive";

const logger = getLogger("server");

export type FileRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  /** Resolves the Bot whose sandbox hosts the session (all file I/O routes through it). */
  botIdFor: (sessionId: string) => Promise<string | null>;
};

/** onyx `_validate_strict_path` (docker_sandbox_manager.py:291-302), same verdicts. */
type StrictPathVerdict = "traversal" | "characters" | null;

function validateStrictPath(path: string): StrictPathVerdict {
  // Traversal patterns, URL escapes, or null bytes.
  if (path.includes("..") || path.includes("%") || path.includes("\0")) {
    return "traversal";
  }
  // Shell metacharacters.
  if (/[;&|`$(){}[\]<>'"\n\r\\]/.test(path)) return "characters";
  // Everything else must stay in the safe filename alphabet.
  if (!/^[a-zA-Z0-9_\-./]+$/.test(path.replace(/^\/+/, ""))) {
    return "characters";
  }
  return null;
}

export function createFileRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: FileRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  /** Common prologue: ownership-check the session, resolve its sandbox + file API. */
  const resolve = async (sessionId: string, userId: string) => {
    const session = await deps.store.getSession(sessionId, userId);
    if (!session) return { session: null, fileApi: null };
    const botId = await deps.botIdFor(sessionId);
    const fileApi = botId ? deps.gateway.fileApiFor(botId) : null;
    return { session, fileApi };
  };

  // ── POST /sessions/:id/upload — one file into attachments/ ─────────────────
  app.post("/sessions/:sessionId/upload", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");

    // Early refuse on the declared size (multipart overhead allowance included) so an
    // oversized body never buffers: parse first is onyx's shape, but FastAPI's parser had
    // its own ceiling; here the ceiling is ours to state. The verdict is onyx's own — an
    // oversize file is 400 with validate_file's sentence (413 stays reserved for the
    // sandbox transfer ceiling that refuses mid-write below).
    const declaredLength = Number(
      context.req.raw.headers.get("content-length") ?? "0",
    );
    if (declaredLength > deps.config.maxUploadFileSizeBytes + 65_536) {
      return context.json(
        {
          error: `File size exceeds maximum allowed size of ${deps.config.maxUploadFileSizeBytes} bytes`,
        },
        400,
      );
    }

    const form = await context.req.formData().catch(() => null);
    if (!form) {
      return context.json(
        { error: "A multipart form with a file field is required." },
        400,
      );
    }
    const entry = form.get("file");
    if (!(entry instanceof File)) {
      return context.json({ error: "No file was provided." }, 400);
    }
    if (!entry.name) {
      return context.json({ error: "File has no filename" }, 400);
    }

    const bytes = new Uint8Array(await entry.arrayBuffer());
    const sizeError = validateFileSize(
      bytes.byteLength,
      deps.config.maxUploadFileSizeBytes,
    );
    if (sizeError) return context.json({ error: sizeError }, 400);

    // Sanitize BEFORE any filesystem decision (onyx api.py:774).
    const safeName = sanitizeFilename(entry.name);

    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!fileApi) {
      return context.json(
        { error: "The session's sandbox is not available." },
        503,
      );
    }

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const attachmentsDir = deps.config.attachmentsDirectory;

    // Limits first (onyx manager.upload_file order): count, then total size.
    let stats: Awaited<ReturnType<typeof getUploadStats>>;
    try {
      stats = await getUploadStats(fileApi, directory, attachmentsDir);
    } catch {
      return context.json(
        { error: "The session's attachments could not be read." },
        502,
      );
    }
    if (stats.fileCount >= deps.config.maxUploadFilesPerSession) {
      return context.json(
        {
          error: `Maximum number of files (${deps.config.maxUploadFilesPerSession}) reached`,
        },
        429,
      );
    }
    if (
      stats.totalBytes + bytes.byteLength >
      deps.config.maxTotalUploadSizeBytes
    ) {
      return context.json(
        {
          error: `Total upload size limit (${deps.config.maxTotalUploadSizeMb}MB) exceeded`,
        },
        429,
      );
    }

    // The write channel overwrites, so resolve collisions onyx's way before writing.
    const filename = collisionFreeName(stats.names, safeName);
    const target = `${directory}/${attachmentsDir}/${filename}`;
    try {
      await fileApi.writeFileBytes(target, bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/answered 413/.test(message)) {
        return context.json(
          {
            error:
              "The file exceeds the sandbox's transfer ceiling (SANDBOX_MAX_UPLOAD_BYTES).",
          },
          413,
        );
      }
      logger.warn({ sessionId, err: message }, "[craft] upload write failed");
      return context.json(
        { error: "The file could not be stored in the sandbox." },
        502,
      );
    }

    // The ledger rides best-effort: a failed bookkeeping write must not fail an upload that
    // already landed (the next upload re-reads whatever ledger state exists).
    await recordUpload(
      fileApi,
      directory,
      attachmentsDir,
      filename,
      bytes.byteLength,
    ).catch((error) => {
      logger.warn(
        {
          sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "[craft] upload ledger update failed",
      );
    });
    await deps.store.updateSessionActivity(sessionId).catch(() => undefined); // heartbeat parity: an upload is user activity

    return context.json(
      {
        filename,
        path: `${attachmentsDir}/${filename}`,
        size_bytes: bytes.byteLength,
      },
      200,
    );
  });

  // ── DELETE /sessions/:id/files/*path — delete one file ─────────────────────
  // NOTE the `:path{.+}` shape: Hono 4's bare `*` wildcard MATCHES but yields no param
  // (`param("*")` is always null in 4.13), so the multi-segment path must be a named
  // regex param to be readable at all.
  app.delete("/sessions/:sessionId/files/:path{.+}", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const rel = context.req.param("path") ?? "";

    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);

    const verdict = validateStrictPath(rel);
    if (verdict === "traversal") {
      return context.json({ error: "Access denied" }, 403);
    }
    if (verdict === "characters") {
      return context.json(
        { error: "Invalid path: contains disallowed characters" },
        400,
      );
    }
    if (!fileApi) {
      return context.json({ error: "File not found" }, 404);
    }

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const fullPath = safeJoin(directory, rel);
    if (fullPath === null) {
      return context.json({ error: "Access denied" }, 403);
    }

    let deleted: boolean;
    try {
      deleted = await fileApi.deletePath(fullPath);
    } catch {
      return context.json({ error: "The file could not be deleted." }, 502);
    }
    if (!deleted) {
      // Absent and directory are the same honest refusal (onyx's `[ -f ] && rm`).
      return context.json({ error: "File not found" }, 404);
    }

    const filename = rel.split("/").at(-1) ?? "";
    await deps.store.updateSessionActivity(sessionId).catch(() => undefined);
    await forgetUpload(
      fileApi,
      directory,
      deps.config.attachmentsDirectory,
      filename,
    ).catch(() => undefined);
    return context.body(null, 204);
  });

  // ── GET /sessions/:id/download-directory/*path — one directory as a ZIP ────
  // onyx api.py:711-745 + manager.py:1638-1682: application/zip, filename from
  // _sanitize_zip_basename(Path(path).name, allow_dots=True); every None shape —
  // no session, no sandbox, no directory — is the same 404 "Directory not found",
  // so an ownership probe reads as absence exactly as on onyx.
  app.get(
    "/sessions/:sessionId/download-directory/:path{.+}",
    async (context) => {
      const actor = context.var.actor;
      const sessionId = context.req.param("sessionId");
      const rel = context.req.param("path") ?? "";

      const { session, fileApi } = await resolve(sessionId, actor.id);
      if (!session) {
        return context.json({ error: "Directory not found" }, 404);
      }

      const verdict = validateStrictPath(rel);
      if (verdict === "traversal") {
        return context.json({ error: "Access denied" }, 403);
      }
      if (verdict === "characters") {
        return context.json({ error: "Invalid path" }, 400);
      }
      if (!fileApi) {
        return context.json({ error: "Directory not found" }, 404);
      }

      const directory = sessionDirectory(
        sessionId,
        deps.config.sessionDirectoryMode,
      );
      const fullPath = safeJoin(directory, rel);
      if (fullPath === null) {
        return context.json({ error: "Access denied" }, 403);
      }

      let archive: Uint8Array;
      try {
        archive = await packDirectoryZip(fileApi, fullPath);
      } catch {
        // The listing threw: unreachable or absent — onyx's None → 404.
        return context.json({ error: "Directory not found" }, 404);
      }

      const basename = rel.split("/").filter(Boolean).at(-1) ?? "";
      const name = `${sanitizeZipBasename(basename, { allowDots: true })}.zip`;
      return new Response(archive as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-length": String(archive.byteLength),
          "content-disposition": buildContentDisposition(name),
        },
      });
    },
  );

  return app;
}
