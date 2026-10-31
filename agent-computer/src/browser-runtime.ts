import { browserModeFromEnv, type BrowserMode } from "./browser-mode";

export type BrowserRuntime = {
  backend: "managed" | "local-chrome";
  channel: "chromium" | "chrome";
  mode: BrowserMode;
  useVirtualDisplay: boolean;
  hostname?: "127.0.0.1";
  allowExec: boolean;
  /**
   * Who supplies the process boundary. `none` is the self-managed container, where Chromium keeps
   * its own sandbox where the host allows it. `external` means the sandbox runtime (OpenShell's
   * landlock/seccomp/network policy) is the boundary and Chromium's own sandbox is unavailable.
   */
  isolation: "none" | "external";
};

/** The same launch decision is used by profiles and the computer HTTP process. */
export function browserRuntimeFromEnv(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): BrowserRuntime {
  const backend = env.COMPUTER_BROWSER_BACKEND?.trim() || "managed";
  if (backend !== "managed" && backend !== "local-chrome") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND must be managed or local-chrome.",
    );
  }
  const local = backend === "local-chrome";
  /*
   * Headed wherever a hosted computer runs, which is Linux: a container, a Kubernetes pod, the
   * desktop app's Podman machine. Headless Chromium is the browser bot checks are best at spotting
   * (it says `HeadlessChrome`, renders without a GPU path a person's browser has, and is missing what
   * a windowed browser has), and Cloudflare in front of ChatGPT, Canva and the like challenges it on
   * sight. The window goes to the in-container X server (`virtual-display.ts`), so nothing appears
   * anywhere and the live screen is unchanged. A developer running this directly on a Mac or Windows
   * keeps headless, where a headed default would open windows on their desktop.
   * `COMPUTER_BROWSER_MODE=headless` still chooses headless anywhere.
   */
  const mode = browserModeFromEnv(
    env.COMPUTER_BROWSER_MODE?.trim() ||
      (local || platform === "linux" ? "headed" : "headless"),
  );
  if (local && mode !== "headed") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND=local-chrome requires COMPUTER_BROWSER_MODE=headed.",
    );
  }
  /*
   * An isolation runtime is declared, never inferred. Unset means the self-managed container is the
   * boundary; an unknown value is refused rather than read as "no isolation", so a typo cannot
   * silently launch a browser with neither the runtime's boundary nor Chromium's own sandbox.
   */
  const declared = env.COMPUTER_ISOLATION_RUNTIME?.trim();
  if (declared && declared !== "openshell") {
    throw new Error(
      "COMPUTER_ISOLATION_RUNTIME must name a supported runtime (openshell) when set.",
    );
  }
  return {
    backend,
    channel: local ? "chrome" : "chromium",
    mode,
    useVirtualDisplay: platform === "linux" && mode === "headed",
    ...(local ? { hostname: "127.0.0.1" as const } : {}),
    allowExec: !local,
    isolation: declared === "openshell" ? "external" : "none",
  };
}
