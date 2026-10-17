import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconExternalLink,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { previewOriginLive } from "@/lib/craft/client";
import {
  craftPreviewTicketMutationOptions,
  craftWebappQueryOptions,
} from "@/lib/craft/queries";
import type { CraftWebappInfo } from "@/lib/craft/types";
import { cn } from "@/lib/utils";

/**
 * The running web app, if the agent scaffolded one. The server answers `webapp_info` with the URL
 * the proxy serves AND with `ready` — the probe of the session's reserved port — so the pane can
 * tell "an app exists" from "an app is serving".
 *
 * THE GATE IS `ready`, NOT `has_webapp`. `has_webapp` is true the moment `outputs/web/package.json`
 * exists, which is long before (and can outlive) the dev server behind it: a `webapp start` the turn
 * watchdog cancelled, a sandbox that restarted, an app that crashed on boot — all leave a scaffold
 * with nothing listening on the reserved port. Gating the iframe on `has_webapp` alone pointed the
 * frame at the proxy's 503, and what rendered in the pane was that response's raw body:
 * `{"error":"The web app is not running. Ask the agent to call the webapp tool with action
 * 'start'."}`. A down server is its own state here, in the product's own voice.
 *
 * The pane keeps polling while an app exists but is not serving, so the preview comes alive on its
 * own the moment the agent does start it — no reload, no hunting for a refresh. A serving app stops
 * polling: the iframe's own HMR socket is the live surface from there.
 *
 * THE EXPAND KEEPS THE SAME IFRAME. A 420px pane is too small to actually drive an app, so the
 * serving state can go full-viewport — but it does that by changing the WRAPPER's positioning, not
 * by mounting a second frame or moving this one through a portal. Both alternatives unmount the
 * iframe, which reloads the app and throws away whatever the person was mid-way through testing:
 * the exact thing they expanded for. One frame also means one HMR socket against the dev server
 * instead of two racing it. `fixed inset-0` is safe here because no ancestor of this pane carries
 * a transform/filter/backdrop-filter — checked, and the reason the repo's own lightbox had to
 * flatten its dialog card (chat-transcript's DialogContent comment) does not apply.
 *
 * Both empty states are the browser-chrome motif (this pane's own future, drawn small): hairline
 * window, muted dots, a dashed inner frame. Waiting-for-the-first-app and app-is-down share the
 * chrome and differ in the sentence, so the pane teaches its job without illustration theater.
 */

/** The not-yet-serving poll. Only while the pane is mounted, i.e. only while it's being looked at. */
const NOT_READY_POLL_MS = 5000;

/**
 * Consecutive frame-error deaths one address may auto-recover from (fix-ocr11)
 * before the pane stops re-entering on its own and the pass state's retry
 * button becomes the only way back. Two retries absorb a hiccup; the third
 * consecutive death means the origin itself is unreachable, and each further
 * attempt would only burn another single-use ticket.
 */
const FRAME_ERROR_STREAK_LIMIT = 3;

/**
 * The one-hop preview entry (#362, D4): the absolute preview address plus the
 * single-use ticket, exactly once. The preview origin answers this hop with a
 * 302 to the same address WITHOUT the query — from there the frame rides the
 * preview domain's own cookie, and the ticket is dead (single use) and gone
 * from every URL that follows.
 */
export function previewEntryUrl(origin: string, ticket: string): string {
  // fix-ocr24 #2: the URL API, not string concatenation. Concat only knew the
  // already-has-query shape: an origin carrying a `#` fragment dropped the
  // ticket INTO the fragment — the server's query parser never sees it, the
  // single-use ticket burns on a hop that cannot succeed, and the pane sits
  // in the pass state whose every retry burns another. searchParams.set
  // lands the parameter in the query whatever the fragment does; an origin so
  // malformed that `new URL` throws rejects this hop, and the entering
  // decision's own .catch holds the entryless pass state (direction
  // unchanged — an unenterable origin never enters).
  const url = new URL(origin);
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

/**
 * The scheme-shaped prefix a URL parser's grammar would accept as absolute
 * (`data:`, `javascript:`, a mistyped host:port whose carrier happens to be
 * letter-led, …) — plus the digit- and punctuation-led variants WHATWG's
 * scheme grammar REJECTS (`127.0.0.1:3001`): those cannot be valid absolute
 * URLs either, so if they were meant as addresses at all, they are malformed
 * absolute forms, not relative paths.
 */
const ABSOLUTE_LIKE = /^[a-z0-9][a-z0-9+.\-]*:/i;

/**
 * An http(s) ABSOLUTE address — the shape every post-D11 `webapp_url`/
 * preview-source entry takes (fix-ocr21 #4: the two call sites below — the
 * frame-load probe gate and the legacy derivation — rode the same literal;
 * one named constant keeps them from drifting apart).
 */
const HTTP_ABSOLUTE = /^https?:\/\//i;

/**
 * The same-origin last line of defense (fix-ocr4 #1, tightened by fix-ocr6,
 * fail direction fixed by fix-ocr8 #5): the frame's `allow-same-origin` is
 * safe only while the preview origin is on a DIFFERENT HOST from the one this
 * page is served on (F2's server-side premise — which the server can never
 * check, because it does not see the accessing Host). The comparison is
 * HOSTNAME, not full origin: F1 measured that cookies isolate by HOST alone
 * (RFC 6265 §5.1.3 — the port never participates), so a frame at
 * `127.0.0.1:3001` on a page served from `127.0.0.1:5173` is a
 * technically-different origin that still shares the platform's entire cookie
 * jar — the F1 sandbox escape, reopened through a port. THE PREMISE UNDER THE
 * "only an equal HOSTNAME is the escape" claim (fix-ocr26 #7): the platform's
 * session cookies stay HOST-ONLY — no Domain attribute anywhere in this code
 * base (verified: no Set-Cookie here emits Domain=), so the jar is scoped to
 * the exact host this page is served on. A deployment (or reverse proxy)
 * that ever planted a Domain-scoped platform cookie would share it across
 * SUBDOMAINS too, and the hostname line would no longer be the whole story —
 * the premise is recorded as a known deployment constraint in
 * docs/craft-preview-origin.md, not enforced here (the server cannot see the
 * platform's own cookie configuration). `true` here means: do not enter,
 * whatever the server said.
 *
 * The unparsable cases split by SHAPE (fix-ocr8 #5): an address that looks
 * absolute (ABSOLUTE_LIKE) but cannot be parsed — the scheme-less
 * `127.0.0.1:3001` a server-side formatting regression would emit — fails
 * CLOSED (blocked), the same direction samePreviewHostname below pins for
 * unparsable exchange answers ("unparsable input mismatches: fail closed");
 * the two checks bracket the frame and must not disagree. The one deliberate
 * pass-through is the scheme-less RELATIVE path — the legacy entry
 * (`/api/craft/sessions/<id>/webapp`), which makes no origin claim at all;
 * that is the pre-preview-origin shape, not a defense decision.
 */
export function previewOriginBlocked(
  address: string,
  locationOrigin: string,
): boolean {
  try {
    return new URL(address).hostname === new URL(locationOrigin).hostname;
  } catch {
    // Unparsable: absolute-shaped → fail closed; relative (legacy) → pass.
    return ABSOLUTE_LIKE.test(address);
  }
}

/**
 * Whether an address is a SAME-ORIGIN RELATIVE path — the only shape the legacy
 * direct entry (fix-ocr9 #1) may hang on the frame's `src` or the new-tab
 * link's `href`. This is the VERSION-SKEW DEFENSE LINE: the server, in both
 * generations, never emits a dangerous scheme here (legacy answers are the
 * fixed `/api/craft/sessions/<id>/webapp` template, current answers are http(s)
 * absolute preview addresses) — but this pane's design premise is that an old
 * server's answer is not trusted (fix-ocr4 #2's skew window), and the explicit
 * `webappGeneration: "legacy"` branch bypasses the `!http(s)` regex entirely.
 * `previewOriginBlocked` cannot cover this door (a `javascript:` URL parses
 * with an empty hostname; `//host` is unparsable without a base and not
 * absolute-shaped), so the direct connect checks shape directly: a real
 * `/`-rooted PATH (fix-ocr24 #3: length > 1 — the bare root "/" is the
 * platform's own same-origin document, not a legacy entry), whose second
 * character is not `/` or `\` — WHATWG's URL parser treats the backslash as
 * a slash for special schemes, so `/\\host` is the same protocol-relative
 * escape to a foreign origin, merely spelled differently. Anything else
 * fails closed: entryless, in the pass state with its retry.
 */
function isSameOriginRelativePath(address: string): boolean {
  // fix-ocr24 #3: the bare root is NOT the exception. `address[1]` is
  // undefined for "/", so both not-slash conditions held vacuously and the
  // gate waved the platform's own root straight onto the frame — a
  // same-origin frame (allow-scripts + allow-same-origin) that can reach
  // parent.document, with previewOriginBlocked deliberately silent on
  // relative paths and this gate the only defense. Length > 1 first: the
  // legacy entry is a PATH (`/api/craft/sessions/<id>/webapp`), never the
  // bare root; anything shorter fails closed.
  //
  // fix-ocr26 #1: and no ASCII tab/CR/LF, the THIRD spelling of the escape.
  // WHATWG strips those bytes from a URL unconditionally BEFORE parsing, so
  // the browser reads `/\t/evil.com` as `//evil.com` — a scheme-relative hop
  // to a foreign origin that the length/starts-with/not-slash checks never
  // see. (This gate is the only defense here: previewOriginBlocked parses
  // WITHOUT a base, so the raw form throws, is not absolute-shaped, and
  // passes as the deliberate relative-path exception.)
  return (
    address.length > 1 &&
    address.startsWith("/") &&
    address[1] !== "/" &&
    address[1] !== "\\" &&
    !/[\t\n\r]/.test(address)
  );
}

/**
 * Whether two absolute addresses name the same HOST (fix-ocr6 A's cross-check):
 * the frame actually navigates the ticket RESPONSE's origin, and only the
 * server's own discipline ties that address to `webapp_url` — so the pane
 * re-checks the pair before pointing anything anywhere (the #367
 * no-silent-404 middle state). Unparsable input mismatches: fail closed.
 */
function samePreviewHostname(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

/**
 * THE PLACEHOLDER CARD SHELL (fix-ocr26 #6): four of this pane's states —
 * same-origin refusal, closed origin, pass-in-flight, down/empty — render the
 * same card, and the shell used to be hand-copied at every site (the copied
 * sites had already drifted once: the down card alone grew the chrome
 * header). One component carries the shell: the browser-chrome outer frame,
 * the dashed inner frame with the one-sentence title, the explanation under
 * the card. `hint` as a string gets the standard sentence paragraph; pass a
 * node for the compound shapes (the down state's tabs line). `chrome` draws
 * the window-dots header and its padded title frame — the down/empty card's
 * own shell. `children` carries trailing content (the exchange-refusal
 * sentence, the retry button). ZERO behavior or style change: the existing
 * suite's tests pin every rendered shape.
 */
function PreviewPaneState({
  title,
  hint,
  chrome = false,
  children,
}: {
  title: string;
  hint?: ReactNode;
  chrome?: boolean;
  children?: ReactNode;
}) {
  const frame = (
    <div className="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8">
      <p className="text-xs text-muted-foreground">{title}</p>
    </div>
  );
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {chrome ? (
          <div className="flex items-center gap-1.5 border-b border-border px-3.5 py-2.5">
            <span className="size-2 rounded-full bg-muted-foreground/25" />
            <span className="size-2 rounded-full bg-muted-foreground/25" />
            <span className="size-2 rounded-full bg-muted-foreground/25" />
            <span className="ml-2 h-3 flex-1 rounded-full bg-muted" />
          </div>
        ) : null}
        {chrome ? <div className="p-4">{frame}</div> : frame}
      </div>
      {typeof hint === "string" ? (
        <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
          {hint}
        </p>
      ) : (
        hint
      )}
      {children}
    </div>
  );
}

/**
 * The pane's poll decision, as a fact of its own: an app that exists but is NOT serving is a
 * transient the agent can end at any moment, so it is watched; every other state — no app yet,
 * serving, no sandbox — settles and waits to be invalidated (a turn's end does that, see
 * chat-panel's handleSend). Exported because the decision is the interesting half: whether
 * react-query honors an interval is the library's business, and its own environment sniffing
 * (`typeof window` at import time) makes that unobservable under happy-dom.
 */
export function previewPollInterval(
  info: CraftWebappInfo | undefined,
): number | false {
  return info?.has_webapp && !info.ready ? NOT_READY_POLL_MS : false;
}

/**
 * A live preview entry (fix-ocr6 D): the frame's address, the plain address for
 * the new-tab escape, the staleness key it was entered on (fix-ocr4 #3), and —
 * new — the SESSION it was bought for. The iframe's key is the session, so a
 * panel re-pointed at another session always replaces the frame node; before D,
 * the replacement's first commit carried the old entry's spent-ticket src (the
 * browser starts that navigation synchronously, and M-2's replacement drop
 * healed it only after the wrong URL had been handed to a node). An entry whose
 * session is not the one being rendered is NO entry, everywhere.
 */
/**
 * The exchange refusal's JUDGMENT (fix-ocr27 #10): the pane's own
 * cross-check verdicts as kinds, plus the server's own sentence — which is
 * language-neutral by construction and renders verbatim. The effect stores a
 * kind, the render translates: `t` is deliberately not the effect's dep
 * (adding it would re-run the decision and re-buy single-use tickets on
 * every language flip), so an in-flight exchange resolving after a language
 * switch used to bake the OLD language's sentence into state — rendered
 * verbatim forever. A kind is inert until rendered, and useTranslation
 * re-renders on languageChanged, so the copy always reads the CURRENT
 * language. The keys ride the same i18n-checked key family the render's t
 * accepts.
 */
type ExchangeRefusal =
  | { kind: "sameOrigin" }
  | { kind: "nonHttp" }
  | { kind: "foreignOrigin" }
  | { kind: "server"; text: string };

const EXCHANGE_REFUSAL_COPY = {
  sameOrigin: "preview.exchangeSameOrigin",
  nonHttp: "preview.exchangeNonHttp",
  foreignOrigin: "preview.exchangeForeignOrigin",
} as const;

type PreviewEntry = {
  src: string;
  plain: string;
  /** The address this entry was entered on — the staleness key (fix-ocr4 #3). */
  enteredFor: string;
  /** The session this entry was bought for — one frame per session (fix-ocr6 D). */
  forSession: string;
};

export function PreviewTab({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("craft");
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const info = useQuery({
    ...craftWebappQueryOptions(sessionId),
    refetchInterval: (query) => previewPollInterval(query.state.data),
  });

  /*
   * The ticket exchange (#362): the preview lives on its OWN origin now, where
   * the platform's session cookie never arrives (that is the isolation, F2/D1),
   * so the pane buys a single-use pass on the main site and enters the preview
   * with it exactly once. The effect re-runs when a fresh webapp-info answer
   * lands (dataUpdatedAt) — that is the retry path for a failed exchange — but
   * never re-exchanges while an entry is live: a replaced `src` would reload
   * the frame and throw away whatever the person was mid-way through testing.
   */
  const { mutateAsync: exchangePass } = useMutation(
    craftPreviewTicketMutationOptions(sessionId),
  );
  /*
   * THE CALL GOES THROUGH A REF, NOT A DEP (fix-ocr10 #1). v5's `mutateAsync`
   * is not an identity-stable value: the mutation observer re-derives its
   * result on every state transition (idle→pending→settled each notify a
   * re-render, and v5 builds have re-bound the method per update — nothing
   * in the contract pins the function's identity across minors), so listing
   * it in the entering effect's deps would re-run the whole decision on
   * every transition of the very exchange it starts: in-flight guard churn
   * (the fix-ocr6 C guard cancelled and re-armed per transition) and, on a
   * failed exchange, a re-buy per error transition — an unthrottled loop
   * burning single-use tickets. The only legitimate retry is a fresh
   * dataUpdatedAt from the pass state's refetch, never the mutation's own
   * settling. The ref carries the latest function; the effect below calls
   * through it and depends on nothing mutation-shaped. This updater is
   * declared BEFORE the entering effect so the ref is fresh on the same
   * commit the decision next runs.
   */
  const exchangePassRef = useRef(exchangePass);
  useEffect(() => {
    exchangePassRef.current = exchangePass;
  });
  const [entry, setEntry] = useState<PreviewEntry | null>(null);
  /*
   * THE FRAME'S OWN IDENTITY (fix-ocr5 M-2): the single-use ticket is spent
   * by the frame's ONE navigation, but the src ATTRIBUTE keeps carrying it —
   * so the entering guard above can never be the whole story. If the iframe
   * ELEMENT itself is replaced while the entry lives (an error boundary
   * recovering the subtree, a structural key change), the new node
   * re-navigates the spent ticket and the preview origin answers its 401
   * JSON as the app, with no path below a full pane unmount that heals it.
   *
   * DETACH CARRIES NO SIGNAL OF ITS OWN: React detaches the old node BEFORE
   * attaching its replacement within one commit, and the pane can also
   * unmount the frame with NO successor at all (the loading branch drops
   * the whole entry subtree) while the entry object is still the committed
   * one — so the detach callback deliberately remembers, and the judgment
   * happens at the next ATTACH: a different node mounting for the SAME
   * entry object is a replacement (the spent ticket is about to re-navigate
   * — drop the entry, the effect above buys a fresh pass); a different node
   * for a DIFFERENT entry is a legitimate re-entry (the old node went away
   * with the old entry) and only re-records.
   */
  const frameNodeRef = useRef<HTMLIFrameElement | null>(null);
  // The nodes already wired with the error/load listener pair (fix-ocr15 #2).
  // React's StrictMode simulates an unmount/remount when the frame's subtree
  // mounts — the frame only appears after the entry lands — and the
  // simulation re-invokes this ref with the SAME node (attach → detach(null)
  // → attach). The wiring below registers one anonymous pair per invocation
  // and nothing removes them, so an unguarded re-attach leaves TWO pairs on
  // the node: one load fired the liveness probe twice, one frame error
  // counted twice (the streak limit of 3 tripping after 1.5 real deaths).
  // A node recorded here is skipped: its listeners are still attached —
  // nothing ever removes them — so the re-attach needs no wiring at all.
  // WeakSet: a replaced node's entry dies with the node, not here.
  const wiredFrameNodesRef = useRef<WeakSet<HTMLIFrameElement>>(new WeakSet());
  // The entry object the remembered node was mounted under — written only at
  // attach time; compared against the committed entry below.
  const entryOfNodeRef = useRef<PreviewEntry | null>(null);
  // The entry the next commit will carry (fix-ocr6 E): written ONLY by
  // applyEntry, never during render — the render-phase mirror assignment this
  // replaces broke purity under StrictMode's double render, and it is the
  // mirror handleFrameRef's attach-time judgment reads.
  const entryRef = useRef<PreviewEntry | null>(null);
  // The in-flight liveness probe's abort handle (fix-ocr16): one probe at a
  // time; a newer probe aborts its predecessor, and the pane's/node's
  // teardown aborts the one in flight.
  const probeAbortRef = useRef<AbortController | null>(null);
  // Set at unmount (fix-ocr16): a load event reaching a disposed pane's
  // detached frame mints no probe — the old handler fetched for a pane that
  // no longer existed.
  const disposedRef = useRef(false);
  // THE PROBE DIES WITH THE PANE (fix-ocr16): unmount aborts the in-flight
  // probe and disarms further ones. StrictMode's mount simulation re-runs
  // the setup, so the flag resets with it.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      probeAbortRef.current?.abort();
    };
  }, []);
  const applyEntry = useCallback((next: PreviewEntry | null) => {
    entryRef.current = next;
    setEntry(next);
  }, []);
  // THE VERDICT'S LIVE-PAIR JUDGMENT (fix-ocr27 #9): the disposed/node/entry
  // guard trio spelled out verbatim in all three probe verdict continuations
  // (the level-one response, the no-cors alive verdict, the no-cors death
  // verdict) — three copies of one judgment that fix-ocr18 #6/#7's rework
  // literally drifted out of sync. One helper answers for all of them: the
  // pair (node, entered) is still the pane's live frame-and-entry — the pane
  // not disposed, THIS node still the frame, and the entry still exactly the
  // one the probe was minted under — returning that entry, or null when any
  // leg fails. Disposal stays the FIRST check, the order the inlined trio
  // spelled (fix-ocr18 #7). The pre-mint guards (before the GET) keep their
  // own inline shape: they run on different ticks and different arguments
  // (handleFrameError has no entered identity to compare). Stable identity
  // (stable refs only): the consumers' callback identities don't churn per
  // render, so the frame wiring never re-attaches — a detach would abort the
  // in-flight probe it guards.
  const isLiveFramePair = useCallback(
    (node: HTMLIFrameElement, entered: PreviewEntry): PreviewEntry | null => {
      if (disposedRef.current) return null;
      if (frameNodeRef.current !== node) return null;
      const live = entryRef.current;
      if (live === null || live !== entered) return null;
      return live;
    },
    [],
  );
  /*
   * THE BRAKE ON THE ERROR-RECOVERY LOOP (fix-ocr11). A frame error drops the
   * entry and the entering effect below immediately re-exchanges and rebuilds
   * the frame — the right response when the failure was a stale ticket table
   * or a navigation lost mid-hop (fix-ocr10 #2), and a TIGHT UNBOUNDED LOOP
   * when the origin itself is unreachable: a server restart that refuses
   * connections, dead TLS — enter → error → re-exchange → enter → error →…
   * AND NOTHING EXTERNAL CAN STOP IT: the `serving` fact is STALE BY
   * CONSTRUCTION (it reads `ready` from the last webapp-info answer) and a
   * serving app STOPS POLLING (`previewPollInterval` answers false once
   * `ready` is true), so no refetch ever lands to flip the gate and re-judge;
   * the loop burns one single-use ticket per cycle, forever. So the pane
   * counts CONSECUTIVE frame errors per entered address; at the limit it
   * stops re-entering on its own and falls into the pass state below, whose
   * existing retry button is the manual way back. The count clears when the
   * frame actually LOADS (its own completion event — the one success signal
   * that survives cross-origin opacity, unlike any content probe) and the
   * address key keeps one address's failures from gating a different one
   * (a mid-session flip re-enters immediately, as fix-ocr4 #3 designed).
   */
  const [frameErrorStreak, setFrameErrorStreak] = useState<{
    address: string;
    count: number;
  }>({ address: "", count: 0 });
  /*
   * The recovery half of the frame's error listener (attached where the node
   * registers, below): only the LIVE frame's own failure may reset the
   * entry. A late event from a node that has already been replaced (its
   * entry dropped, a new pass bought for its successor) is the old
   * navigation's ghost — resetting on it would clobber the fresh entry and
   * buy a third single-use ticket. The entry-null check keeps a double fire
   * (error on the way out) from re-triggering while the pane is already in
   * the pass state.
   */
  /*
   * THE SHARED DEATH VERDICT (fix-ocr19 M2): a frame error and the probe's
   * non-ok answer are the SAME fact — the entry's address just failed — so
   * both ride ONE updater. The two copies used to be hand-synced, and the
   * count's semantics have already caused one round of rework (fix-ocr18 #6
   * put the clearing in the wrong branch): the contract core does not live
   * in twins. Count the death keyed by the address the entry entered on (a
   * streak for a different address starts fresh at one), then drop the entry
   * through applyEntry so the ref mirror moves with the state (fix-ocr6 E).
   */
  const countFrameDeath = useCallback(
    (enteredFor: string) => {
      setFrameErrorStreak((prev) =>
        prev.address === enteredFor
          ? { address: enteredFor, count: prev.count + 1 }
          : { address: enteredFor, count: 1 },
      );
      // applyEntry, not setEntry: the ref mirror must move with the state
      // (fix-ocr6 E) or the next attach would judge against a stale entry.
      applyEntry(null);
    },
    [applyEntry],
  );
  const handleFrameError = useCallback(
    (node: HTMLIFrameElement) => {
      // A disposed pane takes no verdict (fix-ocr19 #4): the frame-error
      // guard, symmetric with the probe path's pre-mint and
      // verdict checks — a late error on a detached node counts nothing.
      if (disposedRef.current) return;
      if (frameNodeRef.current !== node) return;
      const current = entryRef.current;
      if (current === null) return;
      countFrameDeath(current.enteredFor);
    },
    [countFrameDeath],
  );
  /*
   * THE LIVENESS PROBE (fix-ocr12 #2, same-origin per fix-ocr13 / round13 H).
   * The pass cookie's validation is STATELESS (the cookie names the session; no
   * table can invalidate it) while the ticket table and the label→session
   * registry are IN-PROCESS — restart-discarded by design (D4: 30-second
   * single-use tickets; M-2: the registry is a memory Map). So after a server
   * restart the frame's follow-up requests are ORDINARY HTTP responses — a 401
   * JSON on the host form, the main site's own fallback page on the dev form —
   * none of which fires the frame's error event: the pane would ride a dead
   * frame until the session was reopened. The verdict comes from a probe, and
   * the probe MUST be SAME-ORIGIN: a cross-origin fetch of the preview address
   * (the fix-ocr12 shape) cannot read its own status without CORS headers —
   * the opaque TypeError is indistinguishable from network death — and in the
   * dev form a restart-empty registry (M-2) makes the old address fall to the
   * MAIN site's no-CORS 200/404, which read as "alive". The server-side
   * registry is exactly the state that knows better: one same-origin GET of
   * `/api/craft/sessions/<id>/preview-origin-live` (credentials ride by
   * default) answers 204 registered-and-open, or 503 with the restart sentence.
   * Non-ok drops the entry through the SAME counted brake a frame error uses
   * (the streak caps the probe-death loop just as it caps the error loop);
   * ok hands over to the SECOND-LEVEL verdict (fix-ocr25 #1, below). A probe
   * that dies on the NETWORK takes NO action: the same-origin endpoint is the
   * main site's own — its network death means the main site is unreachable,
   * and there is no vantage point left from which to judge the preview
   * source. (The frame's error event is NOT the transport signal it was once
   * read as: mainstream browsers never fire `error` on an iframe for a
   * failed navigation — the failed navigation dispatches `load` instead,
   * which is why React supports no onError on the element. Both death shapes
   * — unreachable source and restart fallback — are therefore the probe's
   * to catch, not the error event's.) Re-entry, not ticket recovery: the
   * spent ticket is never re-shown. fix-ocr16: the URL is client.ts's
   * `previewOriginLive` (one spelling of the route, never a hand-spliced
   * twin), and the GET carries an AbortController aborted at the pane's/node's
   * teardown — a pane that is gone probes nothing.
   */
  const handleFrameLoad = useCallback(
    (node: HTMLIFrameElement) => {
      if (frameNodeRef.current !== node) return;
      const entered = entryRef.current;
      if (entered === null) return;
      // The pane must be mounted for ANY verdict to land (fix-ocr19 #3):
      // the disposed early-exit moves ahead of the legacy branch — a
      // detached node's late load writes nothing, not a probe and not the
      // streak zeroing either (the same post-unmount setState the probe
      // path's guards prevent; fix-ocr18 #6/#7's ordering gap, now closed
      // symmetric with every other path here).
      if (disposedRef.current) return;
      // fix-ocr15: the probe is for PREVIEW-SOURCE entries only — an entry
      // whose src is an absolute http(s) address, the only kind whose origin
      // has a label→session registry row to lose. A LEGACY entry (D10) rides
      // the same-origin relative path and no preview source at all: its
      // session is never registered, so the probe can only ever answer the
      // restart 503 — frame load → 503 → entry dropped → re-entered → 503
      // again, three counted deaths and the breaker seals a perfectly
      // working legacy preview shut. Return without probing: the legacy
      // frame's load is its own success signal, and the error listener above
      // stays wired for the resource-level failures that do fire it. THE LOAD
      // STILL CLEARS THE
      // STREAK (fix-ocr18 #6): the streak's own contract is "clears when the
      // frame actually LOADS", and this early return was the one load path
      // that skipped it — two transient errors, one healthy load, then a
      // third hiccup would hit the cap and seal a working legacy app. Same
      // zeroing shape the probe's ok-verdict uses below. (A preview-source
      // entry is untouched: its clearing signal stays the probe's verdict —
      // a clean load alone proves nothing, a 401-with-body page loads
      // cleanly too.)
      if (!HTTP_ABSOLUTE.test(entered.src)) {
        // fix-ocr24 #4: a functional update — a preview app's own internal
        // navigation fires load on every hop, and a fresh object at zero
        // re-rendered the pane and re-walked the entering effect for nothing.
        // Zero must keep the previous reference so React bails out.
        setFrameErrorStreak((prev) =>
          prev.count === 0 && prev.address === ""
            ? prev
            : { address: "", count: 0 },
        );
        return;
      }
      // One probe at a time, and each aborts its predecessor: a stale
      // probe's verdict is worthless once a newer frame/entry exists. The
      // abort surfaces in the catch below as no-action, exactly like network
      // death — teardown is not a death verdict.
      probeAbortRef.current?.abort();
      const probe = new AbortController();
      probeAbortRef.current = probe;
      void previewOriginLive(entered.forSession, probe.signal)
        .then((response) => {
          // fix-ocr18 #7: the verdict rechecks disposal first — symmetric
          // with the pre-mint check above. Once the response has settled,
          // this continuation is already queued and the teardown's abort
          // cannot retract it; a resolution racing the unmount must not
          // deliver its setState to a pane that no longer exists.
          // fix-ocr27 #9: the trio rides the shared isLiveFramePair judgment
          // (disposal first inside it), identical in all three continuations.
          const live = isLiveFramePair(node, entered);
          if (live === null) return;
          if (response.ok) {
            // THE SECOND-LEVEL VERDICT (fix-ocr25 #1). 204 only proves the
            // MAIN site's view is healthy: the registry claims this label and
            // admission is open — but the preview source itself can be down
            // INDEPENDENTLY (dead TLS on the preview domain alone, a dead
            // listen port while the main site lives), and a frame whose
            // navigation failed still dispatches `load`. The old ok-verdict
            // cleared the streak and kept the entry, and the dead frame rode
            // until a full page reload — the fix-ocr12 failure mode, reborn
            // in this shape. So on ok, fire ONE more request: a no-cors
            // credentials fetch of `entered.plain` itself. An opaque resolve
            // is reachability; a reject (TypeError) is the preview source's
            // own network death, dropped through the same counted brake a
            // frame error rides. WHY THE TWO LEVELS COMPOSE: the 204 already
            // proved the registry holds this label, and a claimed label means
            // the dev-form `/<label>` address is claimed too — it cannot fall
            // through to the main site's fallback page (the round13 [6]
            // misread shape, pre-excluded by this very probe: a non-ok answer
            // was counted in the branch above). At this point a reject can
            // only be the preview source/upstream dying.
            void fetch(entered.plain, {
              mode: "no-cors",
              credentials: "include",
              // Same lifetime as the level-one probe: teardown or a newer
              // probe aborts it, and the abort surfaces as no-action below.
              signal: probe.signal,
            })
              .then(() => {
                // The verdict's guards mirror the level-one head exactly
                // (fix-ocr18 #7): disposal, node identity, entry identity —
                // the second level's answer lands on the live pair only.
                // fix-ocr27 #9: the shared judgment, not a second copy.
                const alive = isLiveFramePair(node, entered);
                if (alive === null) return;
                // Reachable: the success signal that survives the frame's
                // opacity is THIS resolve — clear the streak. fix-ocr24 #4:
                // functional form, same reference at zero — the alive verdict
                // lands on every healthy navigation too.
                setFrameErrorStreak((prev) =>
                  prev.count === 0 && prev.address === ""
                    ? prev
                    : { address: "", count: 0 },
                );
              })
              .catch((error: unknown) => {
                // Preview-source network death: the SAME counted brake a
                // frame error uses (countFrameDeath carries the entry drop).
                // A teardown abort lands here too — no verdict for anyone,
                // and no death counted for it.
                //
                // fix-ocr26 #2: an ABORT is neither of those, and all three
                // guards above HOLD on the abort that matters: the app's own
                // full-page navigation (meta refresh, redirect, manual
                // reload) fires load again on the SAME live node under the
                // SAME entry, and this fetch dies to the handler's
                // probeAbortRef abort — not to the network. Counting it
                // burned a single-use ticket per navigation. Teardown and a
                // newer probe abort through the same road; neither is a
                // verdict.
                if (error instanceof Error && error.name === "AbortError") {
                  return;
                }
                // fix-ocr27 #9: the death verdict rides the same shared
                // live-pair judgment — the abort check stays ahead of it
                // (an abort is no verdict for anyone).
                const dead = isLiveFramePair(node, entered);
                if (dead === null) return;
                countFrameDeath(dead.enteredFor);
              });
            return;
          }
          // Any non-ok (the restart 503, a lost row's 404): the same verdict
          // the fix-ocr12 probe read off the status line, now readable at all
          // because the probe is same-origin. Count it exactly like a frame
          // error, then drop — ONE shared updater, so the two verdicts can
          // never drift (fix-ocr19 M2).
          countFrameDeath(live.enteredFor);
        })
        .catch(() => {
          // Network death: no action. The error path is responsible. (An
          // abort from the pane's own teardown lands here too — also no
          // action: nobody is left to receive a verdict.)
        });
    },
    [countFrameDeath, isLiveFramePair],
  );
  const handleFrameRef = useCallback(
    (node: HTMLIFrameElement | null) => {
      if (node === null) {
        // The probe dies with the node (fix-ocr16): detach — replacement or
        // unmount — aborts any in-flight GET. StrictMode's mount simulation
        // passes through here with no probe running; aborting nothing is a
        // no-op.
        probeAbortRef.current?.abort();
        return;
      }
      // fix-ocr15 #2: the idempotence guard — an already-wired node (the
      // StrictMode simulated remount re-attaches the SAME node) wires
      // nothing again. Every state this callback maintains below is keyed to
      // this node and was settled by its first attach; nothing but the
      // wiring could double up.
      if (wiredFrameNodesRef.current.has(node)) return;
      const remembered = frameNodeRef.current;
      if (
        remembered !== null &&
        node !== remembered &&
        entryOfNodeRef.current === entryRef.current
      ) {
        // A REPLACEMENT while the same entry lives: re-arm and drop the entry
        // — the effect buys the new node a fresh pass for its one navigation.
        frameNodeRef.current = null;
        entryOfNodeRef.current = null;
        applyEntry(null);
        return;
      }
      frameNodeRef.current = node;
      entryOfNodeRef.current = entryRef.current;
      // THE DEAD-ENTRY RECOVERY LISTENER (fix-ocr10 #2; braked by fix-ocr11). 兑换成功 ≠ 导航成功:
      // the preview origin's ticket table and its label→session registry are
      // IN-PROCESS server state (D4: tickets live 30 seconds, single-use,
      // nothing durable; M-2: the registry is a memory Map a server restart
      // clears — that wipe is the designed restart window, and the documented
      // recovery is re-walking the exchange from the main site), and a
      // network hiccup mid-navigation loses the frame's one hop just the
      // same. The entry is blind to all of it: it records only the address
      // it entered on, so the entering effect would early-return on
      // `enteredFor` forever and the pane would stay dead until the session
      // was reopened. The error event was long read as the transport signal
      // the client gets, but that premise is WRONG (fix-ocr25 #1):
      // mainstream browsers never fire `error` on an iframe because its
      // navigation failed — the failed navigation dispatches `load`, which is
      // why React supports no onError on the element. The listener stays
      // wired for the resource-level failures that do fire the event, while
      // BOTH navigation-death shapes — an unreachable preview source and the
      // restart's 401-with-body/fallback page (which loads cleanly) — are
      // the load-time two-level probe's verdict (fix-ocr12 + fix-ocr25 #1),
      // delivered in handleFrameLoad above. Re-entry, not ticket recovery:
      // the spent ticket is never re-shown. React's declarative
      // onError cannot carry this: iframe error events don't bubble, and
      // React attaches non-delegated listeners for media elements only, so
      // the listener rides the node here, where its lifetime is already
      // managed.
      node.addEventListener("error", () => handleFrameError(node));
      node.addEventListener("load", () => handleFrameLoad(node));
      wiredFrameNodesRef.current.add(node);
    },
    [applyEntry, handleFrameError, handleFrameLoad],
  );
  const hasWebapp = info.data?.has_webapp === true;
  const serving = hasWebapp && info.data?.ready === true;
  const webappUrl = serving ? (info.data?.webapp_url ?? null) : null;
  const closedReason = info.data?.previewOriginClosedReason ?? null;
  // #367 (D10): a legacy session's app predates the preview origin — its
  // `webapp_url` is the OLD same-origin path, which the platform's own cookies
  // authenticate. No pass exists for it, and none may be exchanged: the address
  // is already the app's mount, and pointing the frame anywhere else (or
  // buying a pass for an origin the app is not mounted on) would be the
  // silent-404 middle state #367 exists to prevent.
  //
  // The version-skew window (fix-ocr4 #2): an older server answers WITHOUT
  // the generation field at all, and its `webapp_url` is the RELATIVE path
  // (the pre-D11 shape — before the server absolutized it). Reading that
  // missing field as "current" would POST the exchange at an endpoint that
  // does not exist there → 404 → the permanent pass state: the exact middle
  // state again. A missing field with a relative address is therefore judged
  // legacy — same-origin direct iframe, exactly what that server served before.
  const legacy =
    info.data?.webappGeneration === "legacy" ||
    (info.data?.webappGeneration === undefined &&
      webappUrl !== null &&
      !HTTP_ABSOLUTE.test(webappUrl));
  // The client-side check the server cannot make (fix-ocr4 #1): never point a
  // frame at this page's own origin. Checked before the exchange so no pass
  // is ever bought for an origin the pane refuses to enter.
  const locationOrigin =
    typeof window === "undefined" ? "" : window.location.origin;
  const sameOriginBlocked =
    serving &&
    webappUrl !== null &&
    previewOriginBlocked(webappUrl, locationOrigin);
  // fix-ocr6 D: an entry from another session is NO entry — the render gate
  // and this pane's decision both re-walk and buy the new session its own
  // pass, instead of pointing the new session's frame (key={sessionId} —
  // always a fresh node) at the old session's spent ticket.
  const liveEntry =
    entry !== null && entry.forSession === sessionId ? entry : null;
  // fix-ocr6 C: the in-flight exchange, keyed by the session+address it is
  // being bought for. A same-input effect replay (StrictMode's double effect,
  // a refetchOnReconnect landing) re-enters this decision while the exchange
  // is still in flight; without the guard the replay's cleanup cancels the
  // first response and buys a SECOND single-use ticket, abandoning the first.
  // The replay re-arms the guard instead of re-buying, so the in-flight
  // response still lands through the live run's handler — a guard that merely
  // discarded the response would wedge the pane in the pass state until the
  // next refetch.
  const pendingExchangeRef = useRef<{
    session: string;
    url: string;
    cancelled: boolean;
  } | null>(null);
  // THE REFUSAL'S OWN SENTENCE (fix-ocr25 #2): a failed exchange used to be
  // swallowed whole — the person hammering the pass state's retry saw the
  // same generic hint while the server kept naming the real reason (the 409
  // legacy-race refusal, a 503 admission rejection). Cleared when a fresh
  // exchange starts, so a new attempt never inherits the old one's verdict.
  // fix-ocr27 #10: the state holds the JUDGMENT (kind + the server's own
  // sentence for the server arm), never a translated string — see
  // ExchangeRefusal above.
  const [exchangeRefusal, setExchangeRefusal] =
    useState<ExchangeRefusal | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: info.dataUpdatedAt is the REFETCH SIGNAL, not a read — the pass state's retry refetches webapp-info, the new timestamp re-walks this decision (fix-ocr6 C's replay guard rides the same re-walk); the body deliberately reads nothing of it.
  useEffect(() => {
    // fix-ocr26 #4: the closed gate is the effect's FIRST fact — the same
    // verdict the render branch reads. A malformed (or drifted) answer can
    // carry closedReason AND webapp_url; without this early exit the render
    // showed "unavailable" while the effect below bought single-use passes
    // and hung a frame behind the closed form.
    if (closedReason) {
      applyEntry(null);
      return;
    }
    if (!serving || !webappUrl) {
      applyEntry(null);
      return;
    }
    if (sameOriginBlocked) {
      // Not this origin, not any frame: the refusal state below explains.
      applyEntry(null);
      return;
    }
    if (liveEntry !== null) {
      // The entry lives exactly as long as the address it entered on stays
      // the latest answer (fix-ocr4 #3): a mid-session flip (repair/
      // regenerate re-mints the absolute preview address) drops it and the
      // decision walks again — one frame reload beats pointing the old frame
      // at a dead address that 404s silently until a full page reload. The
      // entry can also be dropped from below: a REPLACED frame element
      // (handleFrameRef, fix-ocr5 M-2) re-opens this decision so the new
      // node buys a fresh pass instead of re-navigating the spent ticket.
      if (liveEntry.enteredFor === webappUrl) return;
      applyEntry(null);
      return;
    }
    if (
      frameErrorStreak.address === webappUrl &&
      frameErrorStreak.count >= FRAME_ERROR_STREAK_LIMIT
    ) {
      // THE CAP (fix-ocr11): this address just died FRAME_ERROR_STREAK_LIMIT
      // times in a row and nothing observed here says the origin came back —
      // nor will anything: serving is stale and the ready state never polls.
      // Stop re-entering on our own; the pass state below explains and its
      // retry button is the manual restart. Applies to the legacy re-apply
      // too — a dead legacy frame would otherwise be remounted, re-navigated
      // and re-errored just as unboundedly, only without the per-cycle
      // ticket cost.
      return;
    }
    if (legacy) {
      // The old path needs no entry hop: same-origin, cookie-authenticated,
      // exactly what this pane served before the preview origin existed —
      // but only for a genuine same-origin relative path (fix-ocr9 #1, the
      // version-skew defense line above): a mangled legacy answer (a script
      // scheme, a foreign or protocol-relative address) must fail closed
      // here, staying entryless in the pass state below, the same direction
      // as every other gate on the way into this frame.
      if (!isSameOriginRelativePath(webappUrl)) {
        return;
      }
      applyEntry({
        src: webappUrl,
        plain: webappUrl,
        enteredFor: webappUrl,
        forSession: sessionId,
      });
      return;
    }
    // fix-ocr24 #1 (the HIGH): the CURRENT branch's scheme gate. The legacy
    // door above has its shape check (fix-ocr9 #1); this was the one unguarded
    // path in. A `javascript:`/`data:` address parses with an EMPTY hostname:
    // previewOriginBlocked waves it through (empty ≠ the page's host) and the
    // exchange-side cross-check below passes any empty-hostname pair (empty =
    // empty) — exactly the shapes its own comment says it cannot see. Every
    // post-D11 entry is an http(s) absolute address; anything else on a
    // current answer is a mangled or hostile answer, and the only safe frame
    // is NO frame: entryless in the pass state, no pass ever bought.
    if (!HTTP_ABSOLUTE.test(webappUrl)) {
      return;
    }
    const pending = pendingExchangeRef.current;
    if (
      pending !== null &&
      pending.session === sessionId &&
      pending.url === webappUrl
    ) {
      // fix-ocr6 C: an exchange for this address is already in flight — do
      // not buy a second single-use ticket. This run is the live one now
      // (the previous run's cleanup just cancelled the guard), so re-arm and
      // let the in-flight response land through THIS run's lifetime.
      pending.cancelled = false;
      return () => {
        if (pendingExchangeRef.current === pending) pending.cancelled = true;
      };
    }
    const guard = { session: sessionId, url: webappUrl, cancelled: false };
    pendingExchangeRef.current = guard;
    // A fresh attempt starts with a clean slate (Object.is bail-out makes
    // the common case free).
    setExchangeRefusal(null);
    void exchangePassRef.current()
      .then(({ ticket, origin }) => {
        if (guard.cancelled) return;
        // fix-ocr6 A, second half: the frame navigates THIS response's
        // origin, not the webapp_url the pre-exchange screen judged — so
        // re-run the hostname line on it, and cross-check it against the
        // address the pane advertised (#367: never point the frame where the
        // app is not mounted). On a mismatch: stay entryless — the pass
        // state below explains and offers the retry — and neither the log
        // nor the copy echoes the ticket. fix-ocr26 #5: every refusal NAMES
        // its reason (the i18n'd preview.* keys) — a silent return here read
        // as a generic in-flight wait while every retry burned another
        // single-use ticket.
        if (previewOriginBlocked(origin, locationOrigin)) {
          setExchangeRefusal({ kind: "sameOrigin" });
          return;
        }
        if (!HTTP_ABSOLUTE.test(origin)) {
          // fix-ocr24 #1: the navigated address must be http(s) too. The
          // hostname line cannot see scheme-shaped answers (an empty
          // hostname mismatches an honest webapp_url — but MATCHES a
          // malformed one, and non-special schemes keep a real host); the
          // scheme is the fact the whole host-isolation design stands on,
          // so it is checked on the address the frame actually navigates.
          setExchangeRefusal({ kind: "nonHttp" });
          return;
        }
        if (!samePreviewHostname(origin, webappUrl)) {
          setExchangeRefusal({ kind: "foreignOrigin" });
          return;
        }
        applyEntry({
          src: previewEntryUrl(origin, ticket),
          plain: origin,
          enteredFor: webappUrl,
          forSession: sessionId,
        });
      })
      .catch((error: unknown) => {
        // fix-ocr26 #3: the then-head's guard, mirrored — a run whose guard
        // was cancelled (a session switch, a same-input effect replay) must
        // not write its late rejection over the LIVE run's refusal state.
        if (guard.cancelled) return;
        // Stay entryless — and KEEP the reason: the server's displayable
        // sentence (or the transport's own "Failed to fetch") renders under
        // the pass hint below, so a retry that keeps failing shows why. The
        // pass state's refetch bumps dataUpdatedAt, which re-runs this
        // effect. fix-ocr27 #10: the server arm stores the sentence verbatim
        // — it is language-neutral by construction (the server authored it),
        // so there is nothing to re-translate at render.
        setExchangeRefusal({
          kind: "server",
          text:
            error instanceof Error && error.message ? error.message : "",
        });
      })
      .finally(() => {
        if (pendingExchangeRef.current === guard) {
          pendingExchangeRef.current = null;
        }
      });
    return () => {
      if (pendingExchangeRef.current === guard) guard.cancelled = true;
    };
  }, [
    serving,
    webappUrl,
    liveEntry,
    legacy,
    sameOriginBlocked,
    sessionId,
    info.dataUpdatedAt,
    // The closed gate is part of the decision (fix-ocr26 #4): the answer's
    // reason field appearing or clearing must re-walk it, same as serving.
    closedReason,
    // exchangePass deliberately absent (fix-ocr10 #1): v5 re-derives
    // mutateAsync on every mutation state transition; the call goes through
    // exchangePassRef above, so the decision deps on nothing mutation-shaped.
    applyEntry,
    locationOrigin,
    // The brake is part of the decision (fix-ocr11): a streak change (an
    // error counting up, a clean load clearing) re-walks it.
    frameErrorStreak
  ]);

  /*
   * Escape is a convenience, not the contract — and the limit is worth stating because it
   * looks like a bug from the inside. A keydown goes to the focused DOCUMENT, and once the
   * person has clicked into the app to test it, focus is inside the iframe, so the parent
   * never hears the key. No listener on this side can change that; it is what an iframe is.
   * The corner control is therefore the real way out and stays visible the whole time,
   * and Escape works whenever focus is in our chrome (measured both ways in the browser).
   * Focus returns to that control rather than to the top of the document, because it is the
   * same button node in both states — only its icon and label flip.
   */
  useEffect(() => {
    if (!expanded) return;
    toggleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setExpanded(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  if (info.isPending) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {t("preview.loading")}
      </p>
    );
  }

  // The serving pane is entry-gated: an app that is up still needs its one-time
  // pass before a frame may point at the preview origin.
  if (liveEntry) {
    return (
      <div
        // The modal contract, on the wrapper rather than on a portal: the frame
        // inside must not move, so the surface that grows is the one already here.
        {...(expanded
          ? {
              role: "dialog",
              "aria-modal": true,
              "aria-label": t("preview.title"),
            }
          : {})}
        className={cn(
          // The app's own chrome sits under the corner cluster, so the cluster
          // floats on a blur chip rather than hiding what it covers.
          "relative h-full w-full",
          expanded && "fixed inset-0 z-50 bg-background",
        )}
      >
        <iframe
          // ONE FRAME PER SESSION (fix-ocr5 M-2; fix-ocr6 D): a session's frame
          // carries that session's spent-ticket entry URL in its src, and the
          // entry itself names the session that bought it — a panel re-pointed
          // at a different session renders NO entry at all (the gate above),
          // so the key makes the replacement explicit and handleFrameRef turns
          // it into a fresh pass instead of a 401 on the consumed ticket.
          key={sessionId}
          ref={handleFrameRef}
          title={t("preview.title")}
          src={liveEntry.src}
          className="h-full w-full border-0"
          // `allow-same-origin` is HERE ON PURPOSE — and it is safe
          // CONDITIONALLY, on the hostname defense this pane enforces, not on
          // the attribute alone. On the CURRENT preview-origin entry it is
          // safe where it used to be the leak: the frame is served from the
          // PREVIEW ORIGIN (`webapp_url` is absolute, D11), a different HOST
          // from the platform — the browser sends no platform cookie there
          // (F2: cookies isolate by host, not port), and `localStorage` is
          // the preview's own empty store (D2). `allow-same-origin` therefore
          // names the preview's OWN origin, which is exactly what the app
          // needs to be a running app rather than a screenshot: same-origin
          // fetches to its API routes, Server Actions, storage. Removing it
          // would opaque the origin and break all of that (F3) — the
          // isolation comes from the host split, not from this attribute.
          // The premise is enforced twice: previewOriginBlocked refuses the
          // page's own host BEFORE the exchange, and the entry re-checks the
          // address actually navigated afterwards (samePreviewHostname).
          // That premise does NOT hold for the LEGACY entry: the same
          // element hangs the same sandbox over the old same-origin relative
          // path, where the platform's cookies ARE in scope — the F1 escape
          // shape, D10's accepted known open risk for stock sessions
          // (docs/craft-preview-origin.md keeps that framing). This comment
          // must not be read as clearing the legacy path.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
        {/*
         * The corner cluster: expand/collapse as one button (its node identity is what keeps
         * focus and the un-remounted iframe honest), plus the same URL in a real tab for when
         * testing wants devtools, a true viewport, or its own storage. The plain address is
         * enough there: the entry hop already planted the preview domain's cookie, and a
         * top-level navigation carries it (SameSite=None; Secure — None permits exactly
         * this top-level GET, just as the Lax this comment used to claim would; the
         * attributes themselves were #365 F-1's, fix-ocr16 only corrects the words).
         */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/85 p-0.5 shadow-card supports-backdrop-filter:bg-background/60 supports-backdrop-filter:backdrop-blur-sm">
          <a
            aria-label={t("preview.openInNewTab")}
            href={liveEntry.plain}
            target="_blank"
            rel="noopener noreferrer"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <IconExternalLink className="size-3.5" />
          </a>
          <button
            ref={toggleRef}
            type="button"
            aria-label={expanded ? t("preview.collapse") : t("preview.expand")}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {expanded ? (
              <IconArrowsMinimize className="size-3.5" />
            ) : (
              <IconArrowsMaximize className="size-3.5" />
            )}
          </button>
        </div>
        {/*
         * The D10 hint (#367): a legacy preview looks different from the new
         * shape (same-origin path, no pass), and the sentence says so in the
         * same words the docs do — one line, muted, out of the app's way.
         */}
        {legacy ? (
          // fix-ocr7: a transparent div still participates in hit testing, so
          // this strip would swallow clicks on the iframe's bottom edge —
          // pointer-events-none passes them through to the app below.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center p-2">
            <p className="max-w-[48ch] rounded-lg border border-border bg-background/85 px-3 py-1 text-center text-xs text-muted-foreground shadow-card supports-backdrop-filter:bg-background/60 supports-backdrop-filter:backdrop-blur-sm">
              {t("preview.legacyNotice")}
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  // The origin gate is closed (m-5): a scaffolded app exists, but this
  // deployment answers no preview address — the server's displayable reason is
  // the whole point of the field. fix-ocr27 #11: the closed judgment is the
  // render's FIRST pane-state card — the SAME order the effect judges
  // (fix-ocr26 #4, its own first gate) — so a malformed answer carrying
  // closedReason AND a same-origin webapp_url shows the closed card instead
  // of the sameOrigin card, whose advice (open the platform from a different
  // address) cannot heal a closed origin. An exchange can never succeed
  // against a closed origin either way, so the pass state must not win here
  // either.
  if (closedReason && hasWebapp) {
    return (
      <PreviewPaneState
        title={t("preview.closedTitle")}
        hint={closedReason}
      />
    );
  }

  // The same-origin refusal (fix-ocr4 #1), in the closed form's shape: the
  // pane's own words, because no server field can carry this reason — the
  // server never sees which origin the person is accessing the platform
  // through. Like every non-serving state here: NO iframe, ever.
  if (sameOriginBlocked) {
    return (
      <PreviewPaneState
        title={t("preview.sameOriginTitle")}
        hint={t("preview.sameOriginHint")}
      />
    );
  }

  // The serving-but-entryless state: the exchange is in flight or failed — the
  // pass state explains it, and its refetch (a fresh dataUpdatedAt) re-runs the
  // exchange. A serving app must never fall into the "isn't running" state:
  // the server IS running; only the one-time pass is missing.
  if (serving) {
    return (
      <PreviewPaneState
        title={t("preview.passTitle")}
        hint={t("preview.passHint")}
      >
        {exchangeRefusal ? (
          // The refusal's own sentence (fix-ocr25 #2), the closedReason
          // precedent's shape: the person retrying reads the reason instead
          // of hammering a hint that never changes. fix-ocr27 #10: the KIND
          // arm translates at render time (the current language, always);
          // the server arm renders the server's own sentence verbatim.
          <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
            {exchangeRefusal.kind === "server"
              ? exchangeRefusal.text
              : t(EXCHANGE_REFUSAL_COPY[exchangeRefusal.kind])}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            // THE MANUAL PATH OUT OF THE CAP (fix-ocr11): a hand on this
            // button is evidence no automatic signal can be — clear the
            // streak and re-walk the exchange. The refetch is the pass
            // state's own retry semantics (a fresh dataUpdatedAt).
            setFrameErrorStreak({ address: "", count: 0 });
            void info.refetch();
          }}
          disabled={info.isFetching}
        >
          {t("preview.downRetry")}
        </Button>
      </PreviewPaneState>
    );
  }

  // An app exists but its dev server is down: the honest middle state, and the one the
  // iframe used to swallow whole.
  const down = hasWebapp;

  return (
    <PreviewPaneState
      chrome
      title={down ? t("preview.downTitle") : t("preview.emptyTitle")}
      hint={
        <div className="space-y-1.5">
          <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
            {down ? t("preview.downHint") : t("preview.emptyHint")}
          </p>
          <p className="text-xs text-muted-foreground/80">
            {t("preview.emptyTabs")}
          </p>
        </div>
      }
    >
      {down ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void info.refetch()}
          disabled={info.isFetching}
        >
          {t("preview.downRetry")}
        </Button>
      ) : null}
    </PreviewPaneState>
  );
}
