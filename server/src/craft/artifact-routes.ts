/**
 * The artifact + file-browser surface — ported from onyx `session/api.py`'s artifact download
 * and the artifact walk inside `manager.py`, Hono-shaped. Three endpoints:
 *
 * - GET /sessions/:id/artifacts — the gallery scan over `outputs/` (listArtifacts)
 * - GET /sessions/:id/files?path= — one directory's children (listFiles, the Files tab)
 * - GET /sessions/:id/artifacts/*path — stream one artifact's bytes (readFileBytes)
 *
 * Every path lands here as an untrusted URL segment, so a single `safeJoin` re-anchors it under
 * the session directory and refuses traversal before a byte touches the gateway.
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import { listArtifacts, listFiles } from "./artifacts";
import type { CraftConfig } from "./config";
import { exportDocx, exportPptx } from "./export";
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import { sessionDirectory } from "./workspace";

export type ArtifactRoutesDeps = {
  config: CraftConfig;
  store: CraftStore;
  gateway: SandboxGateway;
  /** Resolves the Bot whose sandbox hosts the session (all file I/O routes through it). */
  botIdFor: (sessionId: string) => Promise<string | null>;
};

/**
 * Join a URL-supplied relative path onto the session directory, resolving `.`/`..` and refusing
 * any walk that would escape it. Returns null on traversal; the route turns that into a 400.
 */
export function safeJoin(directory: string, rel: string): string | null {
  const segments = rel
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.length === 0) return null; // escaping the anchor
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return [directory, ...resolved].join("/");
}

/** A minimal extension → content-type map for artifact downloads (binary falls back to octet-stream). */
const MIME_BY_EXTENSION: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ts: "text/typescript; charset=utf-8",
  tsx: "text/typescript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

function contentTypeFor(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

export function createArtifactRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  deps: ArtifactRoutesDeps,
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser);

  /** Common prologue: ownership-check the session, resolve its sandbox + file API. */
  const resolve = async (sessionId: string, userId: string) => {
    const session = await deps.store.getSession(sessionId, userId);
    if (!session) return { session: null, botId: null, fileApi: null };
    const botId = await deps.botIdFor(sessionId);
    const fileApi = botId ? deps.gateway.fileApiFor(botId) : null;
    return { session, botId, fileApi };
  };

  // ── GET /sessions/:id/artifacts — the gallery scan ────────────────────────
  app.get("/sessions/:sessionId/artifacts", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!fileApi) return context.json({ artifacts: [] });

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    try {
      const artifacts = await listArtifacts("", directory, fileApi);
      return context.json({ artifacts });
    } catch {
      // The gallery degrades to empty rather than surfacing a sandbox hiccup as a 5xx.
      return context.json({ artifacts: [] });
    }
  });

  // ── GET /sessions/:id/files?path= — one directory's children ──────────────
  app.get("/sessions/:sessionId/files", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!fileApi) return context.json({ entries: [] });

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const rel = context.req.query("path") ?? "";
    // Traversal/bounds check: a path that escapes the session directory is a 400.
    if (rel !== "" && safeJoin(directory, rel) === null) {
      return context.json(
        { error: "Path is outside the session workspace." },
        400,
      );
    }
    try {
      const entries = await listFiles("", directory, rel, fileApi);
      return context.json({ entries });
    } catch {
      return context.json({ entries: [] });
    }
  });

  // ── GET /sessions/:id/artifacts/*path — stream one artifact ───────────────
  // `:path{.+}` not `*`: Hono 4.13's bare wildcard matches but `param("*")` reads null,
  // which would silently resolve every download to the session root (latent bug this fix
  // closes); the named regex param is the readable multi-segment shape.
  app.get("/sessions/:sessionId/artifacts/:path{.+}", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const rel = context.req.param("path") ?? "";
    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!fileApi) return context.json({ error: "Artifact not found" }, 404);

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const fullPath = safeJoin(directory, rel);
    if (fullPath === null) {
      return context.json(
        { error: "Path is outside the session workspace." },
        400,
      );
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await fileApi.readFileBytes(fullPath);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      return context.json({ error: "Artifact not found" }, 404);
    }
    const name = rel.split("/").at(-1) ?? "artifact";
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": contentTypeFor(name),
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="${name.replace(/["\\]/g, "_")}"`,
      },
    });
  });

  // ── GET /sessions/:id/export-docx/*path — markdown → .docx ─────────────────
  app.get("/sessions/:sessionId/export-docx/:path{.+}", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const rel = context.req.param("path") ?? "";
    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!fileApi) return context.json({ error: "File not found" }, 404);

    // onyx `manager.export_docx` rejects non-markdown before converting.
    const name = rel.split("/").at(-1) ?? "";
    if (!name.toLowerCase().endsWith(".md")) {
      return context.json(
        { error: "Only markdown (.md) files can be exported as DOCX" },
        400,
      );
    }

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const fullPath = safeJoin(directory, rel);
    if (fullPath === null) {
      return context.json(
        { error: "Path is outside the session workspace." },
        400,
      );
    }

    let markdown: string | null;
    try {
      markdown = await fileApi.readFile(fullPath);
    } catch {
      markdown = null;
    }
    if (markdown === null)
      return context.json({ error: "File not found" }, 404);

    const docxBytes = await exportDocx(markdown);
    const docxName = `${name.replace(/\.md$/i, "")}.docx`;
    return new Response(docxBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "content-length": String(docxBytes.byteLength),
        "content-disposition": `attachment; filename="${docxName.replace(/["\\]/g, "_")}"`,
      },
    });
  });

  // ── GET /sessions/:id/pptx-preview/*path — markdown → .pptx ────────────────
  // Divergence note: onyx's `pptx-preview` renders a finished .pptx to slide images via
  // sandbox soffice/pdftoppm; OpenBot instead exports the markdown straight to a deck
  // (see the port plan §7). The URL is kept so the frontend surface stays stable.
  app.get("/sessions/:sessionId/pptx-preview/:path{.+}", async (context) => {
    const actor = context.var.actor;
    const sessionId = context.req.param("sessionId");
    const rel = context.req.param("path") ?? "";
    const { session, fileApi } = await resolve(sessionId, actor.id);
    if (!session) return context.json({ error: "Session not found" }, 404);
    if (!fileApi) return context.json({ error: "File not found" }, 404);

    const directory = sessionDirectory(
      sessionId,
      deps.config.sessionDirectoryMode,
    );
    const fullPath = safeJoin(directory, rel);
    if (fullPath === null) {
      return context.json(
        { error: "Path is outside the session workspace." },
        400,
      );
    }

    let markdown: string | null;
    try {
      markdown = await fileApi.readFile(fullPath);
    } catch {
      markdown = null;
    }
    if (markdown === null)
      return context.json({ error: "File not found" }, 404);

    const pptxBytes = await exportPptx(markdown);
    const name = rel.split("/").at(-1) ?? "deck.md";
    const pptxName = `${name.replace(/\.[^.]+$/, "")}.pptx`;
    return new Response(pptxBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "content-length": String(pptxBytes.byteLength),
        "content-disposition": `attachment; filename="${pptxName.replace(/["\\]/g, "_")}"`,
      },
    });
  });

  return app;
}
