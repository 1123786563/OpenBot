import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { seal, unseal } from "../auth/signed-value";
import type { Database } from "../db/client";
import { personalSaasNativeCodes as codes } from "../db/schema/personal-saas";
import { personalSaasStore, sessionSeconds } from "./store";

const client = z.enum(["ios", "android", "desktop"]);
const callbacks = {
  ios: "openbotmobile://auth/personal-saas",
  android: "openbotmobile://auth/personal-saas",
  desktop: "openbot://auth/personal-saas",
} satisfies Record<z.infer<typeof client>, string>;
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const clientState = z.object({
  client,
  state: proof,
});

const startRequest = clientState.extend({ code_challenge: proof }).strict();
const exchangeRequest = clientState
  .extend({ code: proof, code_verifier: proof })
  .strict();
const sessionIdentity = z.object({
  accountId: z.uuid(),
  loginStartedAt: z.number(),
  encryptedAccessToken: z.string(),
});
export type NativeAttempt = z.infer<typeof startRequest>;
type SignInError =
  | "sign_in_incomplete"
  | "email_unverified"
  | "account_unavailable";
const handoffSeal = "personal-saas-native-handoff";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function bearerSession(header: string | undefined) {
  return /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? "")?.[1];
}

export function nativeAuth({
  database,
  encryptionKey,
  now,
}: {
  database: Database;
  encryptionKey: string;
  now: () => number;
}) {
  const routes = new Hono();

  routes.post("/api/auth/native/exchange", async (context) => {
    if (
      context.req
        .header("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return context.json({ error: "invalid_exchange" }, 400);
    const request = exchangeRequest.safeParse(
      await context.req.json<unknown>().catch(() => undefined),
    );
    if (!request.success)
      return context.json({ error: "invalid_exchange" }, 400);
    const { client, state, code, code_verifier } = request.data;
    const token = await database.transaction(async (tx) => {
      const [record] = await tx
        .delete(codes)
        .where(
          and(
            eq(codes.codeHash, sha256(code)),
            eq(codes.client, client),
            eq(codes.state, state),
            eq(codes.challenge, sha256(code_verifier)),
            gt(codes.expiresAt, new Date()),
          ),
        )
        .returning({ identity: codes.identity });
      if (!record) return null;
      const identity = await unseal(
        record.identity,
        encryptionKey,
        handoffSeal,
      );
      if (!identity) throw new Error("Could not decrypt native handoff");
      const pending = sessionIdentity.safeParse(JSON.parse(identity));
      if (!pending.success) return null;
      return personalSaasStore(tx, now).signIn(pending.data);
    });
    if (!token) return context.json({ error: "invalid_exchange" }, 400);
    return context.json({ token, expiresIn: sessionSeconds });
  });

  function handoff(
    attempt: NativeAttempt,
    result: { code: string } | { error: SignInError },
  ) {
    const url = new URL(callbacks[attempt.client]);
    url.search = new URLSearchParams({
      ...result,
      state: attempt.state,
    }).toString();
    return url.href;
  }

  return {
    routes,
    attempt: startRequest,
    fail: (attempt: NativeAttempt, error: SignInError) =>
      handoff(attempt, { error }),
    async complete(
      attempt: NativeAttempt,
      identity: z.infer<typeof sessionIdentity>,
    ) {
      const code = randomBytes(32).toString("base64url");
      const now = new Date();
      await database.delete(codes).where(lte(codes.expiresAt, now));
      await database.insert(codes).values({
        codeHash: sha256(code),
        client: attempt.client,
        state: attempt.state,
        challenge: attempt.code_challenge,
        identity: await seal(
          JSON.stringify(identity),
          encryptionKey,
          handoffSeal,
        ),
        expiresAt: new Date(now.getTime() + 60_000),
      });
      return handoff(attempt, { code });
    },
  };
}
