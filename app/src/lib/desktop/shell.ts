/** The part of Tauri's injected IPC this page uses. Present only inside the Desktop window. */
export type ShellIpc = {
  transformCallback: (callback: (message: unknown) => void) => number;
  unregisterCallback?: (id: number) => void;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/** The local OpenBot Desktop shell, or null when the page uses regular web behavior. */
export function desktopShell(): ShellIpc | null {
  if (typeof window === "undefined") return null;
  const internals = (
    window as {
      __TAURI_INTERNALS__?: Partial<ShellIpc> & {
        metadata?: { currentWebview?: { label?: string } };
      };
    }
  ).__TAURI_INTERNALS__;
  // Tauri injects its JS API in cloud windows too. Only main has the local shell permissions.
  const label = internals?.metadata?.currentWebview?.label;
  if (label !== undefined && label !== "main") return null;
  return typeof internals?.invoke === "function" &&
    typeof internals.transformCallback === "function"
    ? (internals as ShellIpc)
    : null;
}

/**
 * `&from=desktop` on a request that starts an app's sign-in from the Desktop window, and nothing in a
 * browser. The sign-in opens in the person's own browser, so the server sends it back to a page that
 * hands the person back to OpenBot Desktop (`/desktop-return`) instead of leaving them on OpenBot in
 * that browser.
 */
export function desktopConsentQuery(): string {
  return desktopShell() ? "&from=desktop" : "";
}
