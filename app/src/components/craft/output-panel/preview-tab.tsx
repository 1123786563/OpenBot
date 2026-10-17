import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconExternalLink,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { craftPreviewTicketMutationOptions, craftWebappQueryOptions } from "@/lib/craft/queries";
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
 * The one-hop preview entry (#362, D4): the absolute preview address plus the
 * single-use ticket, exactly once. The preview origin answers this hop with a
 * 302 to the same address WITHOUT the query — from there the frame rides the
 * preview domain's own cookie, and the ticket is dead (single use) and gone
 * from every URL that follows.
 */
export function previewEntryUrl(origin: string, ticket: string): string {
  return `${origin}${origin.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
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
  const [entry, setEntry] = useState<{ src: string; plain: string } | null>(
    null,
  );
  const hasWebapp = info.data?.has_webapp === true;
  const serving = hasWebapp && info.data?.ready === true;
  const webappUrl = serving ? info.data?.webapp_url : null;
  const closedReason = info.data?.previewOriginClosedReason ?? null;

  useEffect(() => {
    if (!serving || !webappUrl) {
      setEntry(null);
      return;
    }
    if (entry !== null) return;
    let cancelled = false;
    void exchangePass()
      .then(({ ticket, origin }) => {
        if (!cancelled) {
          setEntry({ src: previewEntryUrl(origin, ticket), plain: origin });
        }
      })
      .catch(() => {
        // Stay entryless: the pass state below explains and offers the retry
        // (its refetch bumps dataUpdatedAt, which re-runs this effect).
      });
    return () => {
      cancelled = true;
    };
  }, [serving, webappUrl, entry, sessionId, info.dataUpdatedAt, exchangePass]);

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
  if (entry) {
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
          title={t("preview.title")}
          src={entry.src}
          className="h-full w-full border-0"
          // `allow-same-origin` is HERE ON PURPOSE, and since #362 it is safe
          // where it used to be the leak: the frame is served from the PREVIEW
          // ORIGIN (`webapp_url` is absolute, D11), a different HOST from the
          // platform — the browser sends no platform cookie there (F2: cookies
          // isolate by host, not port), and `localStorage` is the preview's own
          // empty store (D2). `allow-same-origin` therefore names the preview's
          // OWN origin, which is exactly what the app needs to be a running app
          // rather than a screenshot: same-origin fetches to its API routes,
          // Server Actions, storage. Removing it would opaque the origin and
          // break all of that (F3) — the isolation comes from the host split,
          // not from this attribute.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
        />
        {/*
         * The corner cluster: expand/collapse as one button (its node identity is what keeps
         * focus and the un-remounted iframe honest), plus the same URL in a real tab for when
         * testing wants devtools, a true viewport, or its own storage. The plain address is
         * enough there: the entry hop already planted the preview domain's cookie, and a
         * top-level navigation carries it (SameSite=Lax permits exactly this GET).
         */}
        <div className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/85 p-0.5 shadow-card supports-backdrop-filter:bg-background/60 supports-backdrop-filter:backdrop-blur-sm">
          <a
            aria-label={t("preview.openInNewTab")}
            href={entry.plain}
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
      </div>
    );
  }

  // The origin gate is closed (m-5): a scaffolded app exists, but this
  // deployment answers no preview address — the server's displayable reason is
  // the whole point of the field. Checked BEFORE the pass state: an exchange
  // can never succeed against a closed origin, so the pane must not sit in the
  // pass state waiting for one.
  if (closedReason && hasWebapp) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
        <div className="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8">
            <p className="text-xs text-muted-foreground">
              {t("preview.closedTitle")}
            </p>
          </div>
        </div>
        <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
          {closedReason}
        </p>
      </div>
    );
  }

  // The serving-but-entryless state: the exchange is in flight or failed — the
  // pass state explains it, and its refetch (a fresh dataUpdatedAt) re-runs the
  // exchange. A serving app must never fall into the "isn't running" state:
  // the server IS running; only the one-time pass is missing.
  if (serving) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
        <div className="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8">
            <p className="text-xs text-muted-foreground">
              {t("preview.passTitle")}
            </p>
          </div>
        </div>
        <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
          {t("preview.passHint")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void info.refetch()}
          disabled={info.isFetching}
        >
          {t("preview.downRetry")}
        </Button>
      </div>
    );
  }

  // An app exists but its dev server is down: the honest middle state, and the one the
  // iframe used to swallow whole.
  const down = hasWebapp;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="w-full max-w-[300px] overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-1.5 border-b border-border px-3.5 py-2.5">
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="size-2 rounded-full bg-muted-foreground/25" />
          <span className="ml-2 h-3 flex-1 rounded-full bg-muted" />
        </div>
        <div className="p-4">
          <div className="flex min-h-[104px] items-center justify-center rounded-lg border border-dashed border-input px-4 py-8">
            <p className="text-xs text-muted-foreground">
              {down ? t("preview.downTitle") : t("preview.emptyTitle")}
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="mx-auto max-w-[36ch] text-sm leading-relaxed text-muted-foreground">
          {down ? t("preview.downHint") : t("preview.emptyHint")}
        </p>
        <p className="text-xs text-muted-foreground/80">
          {t("preview.emptyTabs")}
        </p>
      </div>
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
    </div>
  );
}
