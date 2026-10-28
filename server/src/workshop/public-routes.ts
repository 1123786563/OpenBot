import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { STATIC_CSP } from "./preview";

/**
 * The workshop's ANONYMOUS surface: what a share token reaches.
 *
 * THE ONE DOOR IN is B14's resolveShareActor — the only read path in the repository that
 * bypasses canUseBot, guarded harder than the rule it excepts (see sharing.ts's head). The
 * routes here hold the HTTP half of that contract:
 *
 * - NO INDEXING, NO REFERRERS: every answer carries X-Robots-Tag: noindex and
 *   Referrer-Policy: no-referrer — a share link is a person's front door, not a search
 *   engine's, and the pages behind it must not leak where a visitor came from.
 * - NO LIVE SURFACES: the WS upgrade is refused outright for anonymous callers. HMR is a
 *   development tool; a share is a finished thing. The static road (built files, tight CSP)
 *   is all an anonymous visitor ever sees.
 * - THE UNIFORM MISS: a wrong token, an expired link, and a revoked one all answer 404 —
 *   the same page, the same shape, nothing about which it was (B14's contract, kept here at
 *   the HTTP layer rather than leaked through a 410-vs-404 distinction).
 * - RATE LIMITED at the token's hash (B14's limiter): an enumeration probe gets slowed
 *   before it gets told anything.
 */
export type PublicWorkshopInput = {
  /** B14's service: the one door in, and the signed artifact URLs. */
  sharing: {
    resolveShareActor(
      token: string,
    ): Promise<{
      channelId: string;
      botId: string;
      scope: "preview" | "preview_download";
    } | null>;
    underRateLimit(token: string): Promise<boolean>;
    signArtifactUrl(input: {
      channelId: string;
      artifactId: string;
      scope: "preview" | "preview_download";
    }): string;
  };
  /** The shared channel's artifacts, read-only — the owner's gallery minus the owner. */
  listArtifacts(
    channelId: string,
  ): Promise<
    Array<{ id: string; name: string; type: string; sizeBytes: number }>
  >;
  /** The static preview's file source (the artifact snapshot road; never the dev road). */
  readArtifactFile: (
    channelId: string,
    path: string,
  ) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
  /** Optional audit tap for share views and reports (B7's vocabulary). */
  audit?: (event: {
    eventType: string;
    targetId: string;
    payload: Record<string, unknown>;
  }) => Promise<void>;
};

export function createWorkshopPublicRoutes(input: PublicWorkshopInput): Hono {
  const app = new Hono();

  /** The two headers every public answer carries, applied once. */
  const publicHeaders = (headers: Headers): Headers => {
    headers.set("x-robots-tag", "noindex");
    headers.set("referrer-policy", "no-referrer");
    return headers;
  };

  // Every miss — unknown, revoked, malformed — is the answer outside links hit most, so it
  // carries the same noindex/no-referrer headers as everything else here.
  const notFound = (): Response =>
    new Response("404 Not Found", {
      status: 404,
      headers: publicHeaders(new Headers()),
    });

  app.get("/:channelId/public/preview/*", async (context) => {
    // An anonymous upgrade is refused before anything else: the share is static, full stop.
    if (context.req.header("upgrade")?.toLowerCase() === "websocket") {
      return context.json(
        { error: "Live previews are not part of a share." },
        { status: 403, headers: publicHeaders(new Headers()) },
      );
    }
    const token = context.req.query("t") ?? "";
    if (!(await input.sharing.underRateLimit(token))) {
      return context.json(
        { error: "Too many requests." },
        { status: 429, headers: publicHeaders(new Headers()) },
      );
    }
    const actor = await input.sharing.resolveShareActor(token);
    if (!actor || actor.channelId !== context.req.param("channelId")) {
      // The uniform miss: wrong, expired, revoked, and not-this-channel all look alike.
      return notFound();
    }
    // The preview path is whatever follows the route's own /public/preview/ segment —
    // spelled mount-relative (c.req.path keeps the mount prefix), so the route serves the
    // same bytes under /api/workshop (the owner's test mount) and /api/public/workshop
    // (app.ts's anonymous mount) without either mount's prefix leaking into a file name.
    const marker = "/public/preview/";
    const markerAt = context.req.path.lastIndexOf(marker);
    const path =
      markerAt === -1 ? "" : context.req.path.slice(markerAt + marker.length);
    const file = await input.readArtifactFile(
      actor.channelId,
      path || "index.html",
    );
    if (!file) return notFound();
    const headers = publicHeaders(new Headers());
    headers.set("content-type", file.contentType);
    headers.set("content-security-policy", STATIC_CSP);
    return new Response(file.bytes as BodyInit, { status: 200, headers });
  });

  app.get("/:channelId/public/artifacts", async (context) => {
    const token = context.req.query("t") ?? "";
    if (!(await input.sharing.underRateLimit(token))) {
      return context.json(
        { error: "Too many requests." },
        { status: 429, headers: publicHeaders(new Headers()) },
      );
    }
    const actor = await input.sharing.resolveShareActor(token);
    if (!actor || actor.channelId !== context.req.param("channelId")) {
      return notFound();
    }
    const artifacts = await input.listArtifacts(actor.channelId);
    const headers = publicHeaders(new Headers());
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({
        scope: actor.scope,
        artifacts: artifacts.map((artifact) => ({
          ...artifact,
          // The download URL is signed for THIS share's scope — a preview-only share gets a
          // URL the download route will refuse, rather than a URL that upgrades itself.
          downloadUrl:
            actor.scope === "preview_download"
              ? input.sharing.signArtifactUrl({
                  channelId: actor.channelId,
                  artifactId: artifact.id,
                  scope: actor.scope,
                })
              : null,
        })),
      }),
      { status: 200, headers },
    );
  });

  app.get("/:channelId/public/artifacts/:artifactId", async (context) => {
    const token = context.req.query("t") ?? "";
    const signature = context.req.query("s") ?? "";
    const scope = context.req.query("scope") ?? "";
    if (!(await input.sharing.underRateLimit(token))) {
      return context.json(
        { error: "Too many requests." },
        { status: 429, headers: publicHeaders(new Headers()) },
      );
    }
    const actor = await input.sharing.resolveShareActor(token);
    if (
      !actor ||
      actor.channelId !== context.req.param("channelId") ||
      actor.scope !== "preview_download"
    ) {
      // A preview-only share asking for a download: the uniform miss, not a 403 that names
      // what it is missing.
      return notFound();
    }
    // The signature binds channel + artifact + scope; a reshaped URL fails here.
    const expected = new URL(
      `http://x${input.sharing.signArtifactUrl({
        channelId: actor.channelId,
        artifactId: context.req.param("artifactId"),
        scope: "preview_download",
      })}`,
    ).searchParams.get("s");
    // Constant-time compare: this endpoint is anonymous, and a byte-at-a-time string
    // compare is a (cheap) oracle on the signature.
    const sameSignature =
      expected !== null &&
      expected.length > 0 &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!sameSignature || scope !== "preview_download") {
      return notFound();
    }
    const artifacts = await input.listArtifacts(actor.channelId);
    const artifact = artifacts.find(
      (row) => row.id === context.req.param("artifactId"),
    );
    if (!artifact) return notFound();
    const headers = publicHeaders(new Headers());
    headers.set("content-type", "application/json");
    // Anonymous surface, static policy: the anonymous face never carries the dev road's
    // looser connect-src, even on a response no script should ever read.
    headers.set("content-security-policy", STATIC_CSP);
    return new Response(
      JSON.stringify({
        artifact,
        signedUrl: input.sharing.signArtifactUrl({
          channelId: actor.channelId,
          artifactId: artifact.id,
          scope: "preview_download",
        }),
      }),
      { status: 200, headers },
    );
  });

  return app;
}
