// server/src/craft/preview.ts
// MOD22（Issue #642，根 #620）：CRAFT 组内 Preview 单一内部边界。
//
// 本文件是 Preview 面的两件收拢（计划 §1.A，物理布局不动——票据/通行证/
// Origin/TLS/HMR 解析器全部留在原位，本 seam 做委托与装配收拢）：
//
//   createCraftPreview        装配 seam：runtime.ts 原五段装配（票据表 /
//                             preview proxy / preview origin / 两份 HMR deps）
//                             合并为一次构造。门语义逐字节保留：整体挂在
//                             config.enabled 上（enabled 即 origin 恒在）；
//                             主站 webappHmr 额外挂 config.webappProxyEnabled
//                             （fix-ocr18 #3：preview HMR 半片只挂 enabled，
//                             绝不继承主站合取）。
//   createCraftPreviewFrontDoor 分派 seam：http-server.ts 原两段判定体
//                             （preview 主机分派 :106-183、主站 HMR 升级枝
//                             :227-260）原行迁入。Bun `server.upgrade` 的
//                             plumbing 与 socket 泵不进本文件——调用方交出
//                             commit 回调，本 seam 只给判定与载荷。
//
// 薄委托纪律（MOD18 B 臂先例）：判定逻辑零新增、零修改，全部是搬移的原行；
// 迁移证明=diff 中原样文本。行为零变化是硬边界：wire/URL/方法/响应形状不动。

import type { CraftConfig } from "./config";
import {
  createPreviewOrigin,
  type PreviewOrigin,
  type PreviewOriginAdmission,
  samePreviewOrigin,
} from "./preview-origin";
import { createPreviewTickets, type PreviewTickets } from "./preview-ticket";
import type { SandboxGateway } from "./sandbox-gateway";
import type { CraftStore } from "./store";
import {
  createPreviewProxy,
  type PreviewWebappHmrDeps,
  resolvePreviewWebappHmrUpgrade,
  resolveWebappHmrUpgrade,
  type WebappHmrDeps,
  type WebappHmrSocketData,
  webappHmrIsAppPath,
  webappHmrSessionIdFromPath,
} from "./webapp-proxy";

/**
 * The upgrade commit: Bun's `server.upgrade` itself stays with the caller (it
 * owns the server object), the seam hands over the socket payload it judged.
 * True = the socket committed and the fetch handler answers `undefined`.
 */
export type PreviewUpgradeCommit = (data: WebappHmrSocketData) => boolean;

/**
 * One dispatch's answer. `claimed: false` = not ours, the caller's next branch
 * runs; `claimed: true` carries the Response to answer with — or `undefined`
 * when an upgrade committed (Bun's answer-nothing-after-upgrade shape).
 */
export type PreviewFrontDoorVerdict =
  | { claimed: true; response: Response | undefined }
  | { claimed: false };

/** Who the request acts as — the main-site HMR leg's own auth input. */
export type PreviewActorResolver = (
  request: Request,
) => Promise<{ id: string }>;

export interface CraftPreviewFrontDoorDeps {
  /** Undefined when craft is off: nothing is claimed. */
  readonly origin: PreviewOrigin | undefined;
  /**
   * fix-ocr18 #3: the preview origin's upgrade half rides its OWN deps, gated
   * on `enabled` ONLY inside createCraftPreview — never the main-site
   * conjunction with `webappProxyEnabled`.
   */
  readonly previewHmr: PreviewWebappHmrDeps | undefined;
  /** The main site's webapp HMR leg; absent when the webapp proxy is off. */
  readonly webappHmr: WebappHmrDeps | undefined;
}

export interface CraftPreviewFrontDoor {
  /**
   * The preview-namespace dispatch (#361/#362/#363): claimed preview hosts
   * NEVER fall through to the main site. Sits ahead of every main-site
   * branch, exactly where http-server.ts always ran it.
   */
  dispatch(
    request: Request,
    url: URL,
    commit: PreviewUpgradeCommit,
  ): Promise<PreviewFrontDoorVerdict>;
  /**
   * The main site's webapp HMR upgrade dispatch (onyx webapp_proxy.py:387-398):
   * NOT a preview-host concern — it keeps its old slot behind the computer
   * stream's authorizeStream branch in the caller.
   */
  dispatchWebappHmr(
    request: Request,
    url: URL,
    resolveActor: PreviewActorResolver,
    commit: PreviewUpgradeCommit,
  ): Promise<PreviewFrontDoorVerdict>;
}

/**
 * The front door: both upgrade dispatches, judgment moved VERBATIM from
 * http-server.ts (#361/#362 host dispatch, fix-ocr28 #1 CSWSH gate, #363
 * preview HMR resolver, the main-site leg's manual auth). The upgrade call
 * and the socket pump stay with the caller as plumbing.
 */
export function createCraftPreviewFrontDoor(
  deps: CraftPreviewFrontDoorDeps,
): CraftPreviewFrontDoor {
  return {
    async dispatch(request, url, commit) {
      const craftPreviewOrigin = deps.origin;
      // The craft preview origin (#361/#362): claimed hosts NEVER fall through to
      // the main-site branches — unknown preview hosts 404 right here, closed
      // admission answers 503 with its displayable reason, and a resolved session
      // lands on the preview entry: a `?ticket=` hop redeems and plants the D9
      // cookie, every further request is gated on that cookie and proxied to the
      // session's dev server (no platform session is ever in scope on these
      // hosts — AC1). Bun derives request.url's host from the Host header on this
      // listener for plain HTTP and websocket upgrades alike (verified against a
      // live listener).
      if (!craftPreviewOrigin?.handlesRequest(request)) {
        return { claimed: false };
      }
      const resolved = craftPreviewOrigin.resolvePreviewRequest(request);
      if ("sessionId" in resolved) {
        // #363: the HMR websocket upgrade on a preview host. An upgrade is not a
        // request/response, so the HTTP entry below cannot carry it — the session
        // comes from the Host (never the path: host routing moved identity out of
        // the URL), and the authorization is the preview pass the redemption hop
        // planted, the SAME judgment the HTTP entry's cookie gate makes. Every
        // refusal lands BEFORE the upgrade commits the socket, in the
        // proxy's own 401/404/503 shapes; the upstream path is the pathname
        // VERBATIM (the dev form's leading label INCLUDED — the basePath-mounted
        // dev server serves under it), exactly what the HTTP entry requests —
        // see appPathFor and webappHmrUpstreamUrl for why forwarding the
        // app's own path verbatim is load-bearing.
        // fix-ocr28 #2: the app path is derived ONCE here — the branch gate and
        // the resolver's path argument used to call appPathFor twice for one
        // request (two URL parses for one pathname, and a silent seam if either
        // call ever grew a judgment of its own).
        const appPath = craftPreviewOrigin.appPathFor(request);
        if (
          deps.previewHmr !== undefined &&
          request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
          webappHmrIsAppPath(appPath)
        ) {
          // fix-ocr28 #1 (CSWSH): the Origin gate. A WS handshake is not
          // CORS-gated and the preview pass is SameSite=None, so a malicious
          // page's `new WebSocket("wss://<preview-host>/…")` would otherwise
          // ride the pass cookie into the live HMR channel. Origin present →
          // it must be the session's own preview origin; absent (a
          // non-browser client) → the pre-existing behavior. originFor is
          // safe here: "sessionId" in resolved means admission already
          // answered open (resolvePreviewRequest refuses 503 when closed),
          // and originFor throws on a closed origin.
          const origin = request.headers.get("origin");
          if (
            !samePreviewOrigin(
              origin,
              craftPreviewOrigin.originFor(resolved.sessionId),
            )
          ) {
            return {
              claimed: true,
              response: new Response(
                "Cross-origin WebSocket upgrades are refused.",
                { status: 403 },
              ),
            };
          }
          const decision = await resolvePreviewWebappHmrUpgrade(
            deps.previewHmr satisfies PreviewWebappHmrDeps,
            {
              sessionId: resolved.sessionId,
              request,
              path: appPath,
              query: url.search,
            },
          );
          if (!decision.ok) {
            return {
              claimed: true,
              response: new Response(decision.error, {
                status: decision.status,
              }),
            };
          }
          if (commit({ upstream: decision.upstreamUrl, hmr: true as const })) {
            return { claimed: true, response: undefined };
          }
          return {
            claimed: true,
            response: new Response("Expected a WebSocket upgrade.", {
              status: 400,
            }),
          };
        }
        return {
          claimed: true,
          response: await craftPreviewOrigin.handlePreviewRequest(
            resolved.sessionId,
            request,
          ),
        };
      }
      return {
        claimed: true,
        response: Response.json(
          { error: resolved.refuse.reason },
          { status: resolved.refuse.status },
        ),
      };
    },

    async dispatchWebappHmr(request, url, resolveActor, commit) {
      const craftWebappHmrDeps = deps.webappHmr;
      const hmrSessionId =
        craftWebappHmrDeps !== undefined
          ? webappHmrSessionIdFromPath(url.pathname)
          : null;
      if (
        hmrSessionId === null ||
        craftWebappHmrDeps === undefined ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return { claimed: false };
      }
      // The webapp proxy's own auth, applied by hand because middleware does not run on an
      // upgrade (the stream branch sets the precedent). Every refusal lands BEFORE the
      // upgrade commits — onyx's `_check_webapp_access` → WebSocketException(1008), answered
      // here as plain HTTP statuses while the request is still a request.
      const actor = await resolveActor(request).catch(() => null);
      const decision = await resolveWebappHmrUpgrade(craftWebappHmrDeps, {
        sessionId: hmrSessionId,
        actor,
        // Verbatim, not a rebuilt "/_next/webpack-hmr": the scaffold's basePath IS
        // this mount, so the dev server serves HMR under it. See webappHmrUpstreamUrl.
        path: url.pathname,
        query: url.search,
      });
      if (!decision.ok) {
        return {
          claimed: true,
          response: new Response(decision.error, {
            status: decision.status,
          }),
        };
      }
      if (commit({ upstream: decision.upstreamUrl, hmr: true as const })) {
        return { claimed: true, response: undefined };
      }
      return {
        claimed: true,
        response: new Response("Expected a WebSocket upgrade.", {
          status: 400,
        }),
      };
    },
  };
}

/**
 * What the craft routes assembly reads from the seam (#360/#361/#362/#365
 * faces): the process's ONE ticket table and the origin's own methods, bound
 * once here so the route deps and the dispatcher can never hold two instances.
 */
export interface CraftPreviewRoutesArm {
  readonly previewTickets: PreviewTickets;
  readonly previewOriginFor: (sessionId: string) => string;
  readonly previewOriginAdmission: () => PreviewOriginAdmission;
  readonly previewOriginHas: (sessionId: string) => boolean;
  readonly previewOriginClaimsOrigin: (origin: string) => boolean;
  readonly webappBasePathFor: (sessionId: string) => string | null;
}

/** The assembled Preview face: ticket table, origin, front door, routes arm. */
export interface CraftPreview {
  readonly tickets: PreviewTickets;
  readonly origin: PreviewOrigin;
  readonly frontDoor: CraftPreviewFrontDoor;
  readonly routesArm: CraftPreviewRoutesArm;
}

export interface CreateCraftPreviewDeps {
  readonly config: CraftConfig;
  /**
   * The ONE craft store instance the whole preview family reads (the boot
   * file builds it): today's four `createCraftStore(database)` calls were
   * four wrappers over the same db — one injected instance is byte-equivalent.
   */
  readonly store: CraftStore;
  /** The deployment's key-encryption key (labels + pass codec derive from it). */
  readonly secret: string;
  /** #404 (AC6/M-1): the main site's own address, for the origin's claim gate. */
  readonly appUrl: string | undefined;
  readonly botIdFor: (sessionId: string) => Promise<string | null>;
  /** Connection facts for a Bot's sandbox (gateway URL + token). */
  readonly sandboxConnectionFor: (
    botId: string,
  ) => { baseUrl: string; token: string | null } | null;
  /**
   * The main-site HMR leg's gateway, taken LAZILY through the MOD11 binding
   * (craftSandboxPublic.handlesFor): called only under the webappProxyEnabled
   * gate, so the gateway instance comes into existence at exactly the moment
   * the old assembly would have created it — and it is the SAME instance the
   * craft routes tree binds (#642 B).
   */
  readonly hmrGatewayFor: () => SandboxGateway;
}

/**
 * The one construction of the deployment's preview face (the boot file's five
 * old blocks, merged). Undefined when craft is off: with no craft surface there
 * is nothing to claim, and every consumer's gate collapses onto this one
 * `undefined` — routes, the front door and the startup notice included.
 */
export function createCraftPreview(
  deps: CreateCraftPreviewDeps,
): CraftPreview | undefined {
  if (!deps.config.enabled) return undefined;
  const config = deps.config;
  /*
   * The craft preview origin (#361, spec craft-preview-origin D5/D7): hosts in the
   * preview namespace — dev: 127.0.0.1 on this server's own port beside a localhost
   * login; production: <hash-label>.<preview base> from the configured template —
   * are claimed by the front door, ahead of every main-site branch. One
   * preview-ticket table for the whole process: the issuing route and the preview
   * origin's redemption entry share this instance (#360's review constraint).
   */
  const tickets = createPreviewTickets({ store: deps.store });
  /*
   * The preview origin's serving half (#362): a cookie-authenticated request on
   * a preview host proxies to the session's sandbox dev server — the same facts
   * the main-site webapp proxy resolves (the deployment's sandbox Bot, its
   * gateway connection), so the two surfaces can never route one session to
   * different upstreams. Attached to the origin below as its servePreview seam.
   */
  const proxy = createPreviewProxy({
    config,
    store: deps.store,
    botIdFor: deps.botIdFor,
    sandboxConnectionFor: deps.sandboxConnectionFor,
  });
  const origin = createPreviewOrigin({
    config,
    previewTickets: tickets,
    secret: deps.secret,
    servePreview: proxy,
    /*
     * #404 (AC6/M-1): the origin judges its own template against the host the
     * app is really served on. A wildcard base claims that host AND everything
     * under it, so `https://{session}.example.com` with the app on
     * `app.example.com` would take the main site down as 404 "Unknown preview
     * host." — the deployment's own admission answer has to come from the same
     * config the request router resolves the app's origin from, which is this
     * `appUrl` (OPENBOT_APP_URL → first TRUSTED_ORIGINS → OPENBOT_PUBLIC_URL).
     */
    appUrl: deps.appUrl,
  });
  /*
   * fix-ocr18 #3: the preview origin's upgrade half rides its OWN deps, gated on
   * `enabled` ONLY — never the main-site conjunction with `webappProxyEnabled`
   * below. That split is DEFENSIVE, not a load-bearing admission distinction:
   * when `enabled && !webappProxyEnabled`, admission() is closed too (the same
   * config field feeds it, preview-origin.ts), so BOTH halves answer the same
   * 503 — the HTTP entry through handlePreviewRequest's gate, an upgrade through
   * resolvePreviewRequest's refusal — and no "HTTP served while HMR silently
   * dead" half-state exists for this gate to prevent. fix-ocr28 #3 corrects the
   * earlier comment, which built this deps structure on that half-dead scenario:
   * it never happens, because admission() — not these deps — is the one verdict
   * that decides whether a preview host serves anything at all. Keeping the
   * preview branch off the main-site conjunction just means its wiring cannot
   * inherit a gate the preview origin's own admission story does not use.
   */
  const previewHmr: PreviewWebappHmrDeps = {
    config,
    store: deps.store,
    botIdFor: deps.botIdFor,
    sandboxConnectionFor: deps.sandboxConnectionFor,
    // #358 repair: THE pass judgment — the origin's own verifyPass method,
    // so the HMR upgrade applies exactly the acceptance the HTTP gate ran
    // (one codec, one cookie iteration) and the two surfaces cannot drift.
    verifyPass: origin.verifyPass,
  };
  /*
   * The craft webapp's HMR websocket proxy (onyx webapp_proxy.py:387-398). It
   * resolves through the SAME facts the HTTP webapp proxy uses (the
   * deployment's sandbox Bot, its gateway connection, the session's reserved
   * port), so the two surfaces can never route the same session to different
   * upstreams. MOD11 (#631): the gateway is acquired through the public
   * binding — same connection and scope facts, plus the environment
   * generation in the handle cache's addressing key.
   */
  const webappHmr: WebappHmrDeps | undefined = config.webappProxyEnabled
    ? {
        config,
        store: deps.store,
        botIdFor: deps.botIdFor,
        sandboxConnectionFor: deps.sandboxConnectionFor,
        gateway: deps.hmrGatewayFor(),
      }
    : undefined;
  return {
    tickets,
    origin,
    frontDoor: createCraftPreviewFrontDoor({ origin, previewHmr, webappHmr }),
    routesArm: {
      previewTickets: tickets,
      previewOriginFor: (sessionId: string) => origin.originFor(sessionId),
      previewOriginAdmission: () => origin.admission(),
      previewOriginHas: (sessionId: string) => origin.hasSession(sessionId),
      previewOriginClaimsOrigin: (originValue: string) =>
        origin.claimsOrigin(originValue),
      webappBasePathFor: (sessionId: string) =>
        origin.webappBasePathFor(sessionId),
    },
  };
}
