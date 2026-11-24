import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { VerifiedBillingIdentity } from "./test-credit";

const bearer = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9._~+/-]+=*$/);
const bindings = z
  .array(
    z.strictObject({
      personId: z.string().trim().min(1),
      subject: z.string().trim().min(1),
      token: bearer,
    }),
  )
  .min(1);
const digest = (token: string) => createHash("sha256").update(token).digest();

export function loadTestCreditRuntimeAuthentication(
  raw: string | undefined,
  identityOf:
    | ((personId: string) => Promise<VerifiedBillingIdentity | undefined>)
    | undefined,
) {
  if (raw === undefined) return undefined;
  if (!identityOf)
    throw new Error("Test Credit runtime credentials require Casdoor billing.");

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Parse errors must never include the secret-bearing input.
    throw new Error("Invalid TEST_CREDIT_RUNTIME_BINDINGS.");
  }
  const result = bindings.safeParse(value);
  if (
    !result.success ||
    new Set(result.data.map(({ token }) => token)).size !== result.data.length
  )
    throw new Error("Invalid TEST_CREDIT_RUNTIME_BINDINGS.");

  const credentials = result.data.map(({ personId, subject, token }) => ({
    personId,
    subject,
    hash: digest(token),
  }));
  return async (request: Request) => {
    const token = /^Bearer ([^\s,]+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    if (token === undefined || !bearer.safeParse(token).success)
      return undefined;
    const hash = digest(token);
    const binding = credentials.find((entry) =>
      timingSafeEqual(entry.hash, hash),
    );
    if (!binding) return undefined;
    const identity = await identityOf(binding.personId);
    return identity?.subject === binding.subject ? identity : undefined;
  };
}
