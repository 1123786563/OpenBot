import type { Context } from "hono";

export function corsairWebReturn(
  context: Context,
  provider: "github" | "slack",
  outcome: "connected" | "failed",
) {
  if (
    context.req.method === "GET" &&
    context.req.path.endsWith("/callback") &&
    context.req.header("Accept")?.includes("text/html")
  ) {
    return context.redirect(`/connections/${provider}?corsair=${outcome}`, 303);
  }
}
