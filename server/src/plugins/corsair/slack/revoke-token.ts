import { z } from "zod";

const result = z.union([
  z.object({ ok: z.literal(true), revoked: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.literal("token_revoked") }),
]);

export async function revokeSlackToken(transport: typeof fetch, token: string) {
  const response = await transport("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok && result.safeParse(await response.json()).success;
}
