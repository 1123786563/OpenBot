import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import { useScopedCache } from "@/lib/enterprise/tenant/scoped-cache";
import {
  scopedConnectionsQueryOptions,
  type PluginConnection,
  personalConnections,
  pluginKeys,
} from "@/lib/plugins/queries";

/** How often a waiting card asks again whether this person is connected yet. */
const POLL_MS = 2_000;
/** How long a card keeps asking before it says so and hands the wait back to the person. */
const WAIT_LIMIT_MS = 5 * 60 * 1_000;

/**
 * The authorization url, only when it is a web address a tab may be sent to.
 *
 * THE ANSWER CROSSES A TRUST BOUNDARY the click did not: it is whatever the broker (or a catalogue
 * entry) answered with, and the tab this card claimed was opened with this app's own origin — so a
 * `javascript:` answer would run here, as this app. Every other external href the transcript
 * renders is checked the same way, and the catalogue and broker paths both answer https, so the
 * check costs nothing honest.
 */
function webUrl(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}

/**
 * A connections row plus the revoked flag the card refuses success on.
 *
 * The row type the connections list declares carries no `revoked` today, and the absent field must
 * read as not revoked — a row that simply does not say is this person's live one. But the flag is
 * the honest answer when a list ever does carry it, so it is read rather than assumed: `undefined
 * !== true` passes the rows this deployment serves, and a `true` can never be talked into success.
 */
type ConnectableRow = PluginConnection & { revoked?: boolean };

/**
 * The app a Bot needed, offered where the person is reading, instead of the name of a screen.
 *
 * A NEW TAB RATHER THAN THIS ONE, and that is the whole shape of this card. A consent screen is the
 * vendor's own page and the trip to it is a full navigation, so sending this tab would take the
 * person out of the conversation they are in the middle of. The flow finishes over there; this tab
 * stays where it was and watches for the connection to appear.
 *
 * WATCHING, NOT TRUSTING. The return trip proves nothing — it is an ordinary redirect in a tab this
 * one cannot read — so nothing here treats "they came back" or "they closed the tab" as "it
 * worked". While the person is away the card polls their own connections every {@link POLL_MS},
 * and only a live personal row for this app ends the wait. After {@link WAIT_LIMIT_MS} the wait
 * ends into an explicit state with the same press that started it, rather than a button that
 * silently stops meaning anything.
 *
 * WHAT SUCCESS IS WORTH. A row appearing is a fact about the person's account, not an instruction:
 * the card says connected and stops, and the original call stays refused. Asking the Bot again is
 * the person's own next step — replaying a write for them is not this card's to do.
 */
export function ConnectAppCard({
  serverId,
  title,
  message,
}: {
  /** The plugin server to connect, as the refusal named it and the connect endpoint accepts it. */
  serverId: string;
  /** The app's own name, for a card that says what it is asking for. */
  title: string;
  /** What the Bot would have said, kept intact for a reader with no card to draw. */
  message: string;
}) {
  const { t } = useTranslation("channels");
  const [waiting, setWaiting] = useState(false);
  /** This app takes a key somebody types, so there is no page to send them to. */
  const [needsKey, setNeedsKey] = useState(false);
  /** The answer was no web address, so there was nowhere this card could send anyone. */
  const [badUrl, setBadUrl] = useState(false);
  /** The authorization url, when the browser refused to open the tab holding it. */
  const [blockedUrl, setBlockedUrl] = useState<string | null>(null);
  /** The wait ran its full limit with no row to show for it. */
  const [timedOut, setTimedOut] = useState(false);
  // The connect ride the scope the chat holds (MT088 AC3): the write carries the selection pair.
  const queryClient = useQueryClient();
  const scope = useScopedCache();
  const connect = useMutation(connectAccountMutationOptions("settings", scope));
  /*
   * ONE ENDING AT A TIME. Every attempt ends in exactly one of these — the key form, an unreachable
   * url, a waiting tab, a blocked tab, or the failure the connector answered with — and each ending
   * replaces the last one wholesale: the outcome flags are cleared together before the path sets
   * the one it means. A hand-maintained per-branch list is how a stale ending survives to sit
   * beside the new one, which is a card answering two different questions at once.
   */
  const resetOutcome = useCallback(() => {
    setWaiting(false);
    setNeedsKey(false);
    setBadUrl(false);
    setTimedOut(false);
    setBlockedUrl(null);
  }, []);
  // The poll watches this scope's own answer (MT088): the connect carried the selection pair, so
  // the row it is waiting for arrives under the same pair — never another scope's cache entry.
  const connections = useQuery({
    ...scopedConnectionsQueryOptions(queryClient, scope),
    // Only while a consent is open in the other tab; otherwise this is an ordinary cached read.
    refetchInterval: waiting ? POLL_MS : false,
  });
  /*
   * A ROW IS NOT ACCESS, which is the whole reason a revoked flag is read here. Withdrawing
   * somebody's access can leave their row in place, so a card drawn over the "your access was
   * withdrawn" refusal would otherwise say the app was connected and take away the button that is
   * the only way to get it back. Read through `personalConnections`, because a Shared app's row is
   * the deployment's and connecting it is an administrator's act, never this person's success.
   */
  const connected = personalConnections(
    connections.data?.connections ?? [],
  ).some(
    (row) =>
      row.serverId === serverId && (row as ConnectableRow).revoked !== true,
  );

  /*
   * The grants a Bot holds and the pages that list accounts are asked against a store that must
   * know about the new account, so they are asked again — once, on the edge, and only of the
   * plugins entity, because a connection is nobody else's cache entry to disturb.
   *
   * THE EDGE IS THIS CARD'S OWN ATTEMPT, not "a row appeared". A transcript keeps its history, so
   * a card from last week mounts with the app already connected and its first read lands a moment
   * later — a fact, not an event. Gating on the attempt is what keeps that ordinary arrival from
   * invalidating the plugins cache every time an old message renders.
   */
  const attempted = useRef(false);
  const was = useRef(connected);
  useEffect(() => {
    if (connected && !was.current && attempted.current) {
      // The row is this person's, so the wait is over — and every ending the wait might have been
      // carrying goes with it. A revocation that flips the row back later must not find a stale
      // ending to fall back to.
      resetOutcome();
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
    }
    was.current = connected;
  }, [connected, resetOutcome]);

  useEffect(() => {
    if (!waiting) return;
    const deadline = setTimeout(() => {
      // The wait ran out, and that is the whole ending: a blocked-tab link left beside it would be
      // one more way to finish the connection without the card ever noticing it happened.
      resetOutcome();
      setTimedOut(true);
    }, WAIT_LIMIT_MS);
    return () => clearTimeout(deadline);
  }, [waiting, resetOutcome]);

  /**
   * The tab, opened on the click itself rather than on the answer to it.
   *
   * A BROWSER ONLY LETS A PAGE OPEN A TAB WHILE A CLICK IS STILL RECENT. The request that mints
   * the authorization url has to finish first, and on a slow deployment the activation can be gone
   * by the time it does — the tab would be blocked and the card would send somebody to finish in a
   * tab that does not exist. The blank tab is claimed first and navigated once the url arrives.
   *
   * `noopener` CANNOT BE PASSED HERE: it makes `window.open` answer null, and null is a handle
   * nothing can navigate later. The opener is severed on the handle instead, which is the same
   * guarantee by a different route.
   */
  const open = () => {
    attempted.current = true;
    const tab = window.open("about:blank", "_blank");
    // A real browser lets the opener be rewritten away (HTML's `window.opener` setter); the one
    // DOM this repository's tests run on keeps the property readonly, and the card must survive
    // that rather than die mid-click.
    try {
      if (tab) tab.opener = null;
    } catch {
      // Readonly there is a test-runtime fact, not a browser one; say so and carry on.
    }
    connect.mutate(serverId, {
      onSuccess: (authorizationUrl) => {
        /*
         * No url means this app is connected by typing a key rather than by visiting a page — the
         * route answers `{ fields }` and the mutation unwraps nothing. Saying so, with the page
         * that has the form, beats a button that silently does nothing. Never a navigation to
         * null: the claimed tab is closed again instead.
         */
        if (!authorizationUrl) {
          tab?.close();
          resetOutcome();
          setNeedsKey(true);
          return;
        }
        /*
         * Not a web address is not a place this card sends anyone, whatever answered with it: the
         * claimed tab is closed and the person is told, the same shape a failed start takes. The
         * url is never rendered either — the blocked-tab fallback below exists for a real page.
         */
        const url = webUrl(authorizationUrl);
        if (!url) {
          tab?.close();
          resetOutcome();
          setBadUrl(true);
          return;
        }
        resetOutcome();
        setWaiting(true);
        if (tab) {
          tab.location.replace(url);
        }
        // The tab was blocked. The url is still good, so offer it as something to click.
        else setBlockedUrl(url);
      },
      // A failed start is its own ending too: the stale outcomes go with it, so the alert shows
      // the one failure the connector answered with and nothing it replaces.
      onError: () => {
        tab?.close();
        resetOutcome();
      },
    });
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
      data-connect-app={serverId}
    >
      <p className="font-medium">{t("connectCard.title", { title })}</p>
      <p className="text-muted-foreground">{message}</p>
      {connected ? (
        <p className="text-muted-foreground" role="status">
          {t("connectCard.connected", { title })}
        </p>
      ) : needsKey ? (
        <p className="text-muted-foreground" role="status">
          {t("connectCard.keyMode", { title })}{" "}
          <Link
            className="underline underline-offset-2"
            params={{ key: serverId }}
            to="/settings/connected-accounts/$key"
          >
            {t("connectCard.keyModeLink", { title })}
          </Link>
          {t("connectCard.thenAskAgain")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {/* The heading above already names the app; the button says what pressing it does. */}
          <Button disabled={connect.isPending} onClick={open} size="sm">
            {waiting
              ? t("connectCard.waitingButton", { title })
              : t("connectCard.connect")}
          </Button>
          {waiting ? (
            <>
              <p className="text-muted-foreground" role="status">
                {t("connectCard.waiting")}
              </p>
              <Button onClick={resetOutcome} size="sm" variant="outline">
                {t("connectCard.stopWaiting")}
              </Button>
            </>
          ) : null}
          {timedOut ? (
            <p className="text-muted-foreground" role="status">
              {t("connectCard.timedOut", { title })}
            </p>
          ) : null}
          {blockedUrl ? (
            <p className="text-muted-foreground" role="status">
              {t("connectCard.blocked")}{" "}
              <a
                className="underline underline-offset-2"
                href={blockedUrl}
                rel="noreferrer"
                target="_blank"
              >
                {t("connectCard.blockedLink", { title })}
              </a>
            </p>
          ) : null}
          {connect.error ? (
            <p className="text-destructive" role="alert">
              {connect.error instanceof Error
                ? connect.error.message
                : t("connectCard.error", { title })}
            </p>
          ) : null}
          {badUrl ? (
            <p className="text-destructive" role="alert">
              {t("connectCard.badUrl", { title })}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
