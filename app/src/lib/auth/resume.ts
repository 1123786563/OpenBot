/** The flow handle only ever becomes a query value on this deployment’s verifier. */
const VERIFIER_PATH = "/api/plugins/arcade/verify";

/**
 * Longer than any handle the server issues, short enough that a crafted link cannot make the
 * callback URL arbitrarily large. Over the cap the value is not truncated: a truncated handle is a
 * different handle, so it is treated as no handle at all.
 */
const MAX_FLOW_ID_LENGTH = 256;

function usable(flowId: string | undefined): flowId is string {
  return (
    typeof flowId === "string" &&
    flowId.length > 0 &&
    flowId.length <= MAX_FLOW_ID_LENGTH
  );
}

/** The verifier's path with the handle as a query value, or null when there is no usable handle. */
export function verifierPathFor(flowId: string | undefined): string | null {
  return usable(flowId)
    ? `${VERIFIER_PATH}?flow_id=${encodeURIComponent(flowId)}`
    : null;
}

/**
 * Where sign-in should send the browser back to: the verifier carrying the handle,
 * the requested Web page, or the origin itself when neither applies.
 */
export function resumeUrlFor(
  origin: string,
  flowId: string | undefined,
  returnTo?: string,
): string {
  const path = verifierPathFor(flowId) ?? appReturnPath(returnTo);
  return path ? `${origin}${path}` : origin;
}

/** Only a root-relative Web page can be resumed after sign-in or onboarding. */
export function appReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return;
  const base = "https://openbot.invalid";
  const url = URL.parse(value, base);
  if (
    !url ||
    value.startsWith("//") ||
    value.includes("\\") ||
    url.origin !== base ||
    url.pathname.startsWith("//")
  )
    return;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/sign" || path === "/onboarding" || /^\/api(?:\/|$)/.test(path))
    return;
  return `${url.pathname}${url.search}${url.hash}`;
}
