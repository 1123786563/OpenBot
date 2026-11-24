import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  loadMeteredChatExecutor,
  requireBillingCasdoorProvider,
} from "./direct-chat-test-credit-config";
import { WEKNORA_APPLICATION_ID } from "./weknora-ingestion";

const bindings = z.record(
  z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .refine((id) => id !== "openbot" && id !== WEKNORA_APPLICATION_ID),
  z.string().regex(/^[a-f0-9]{64}$/),
);

export function loadIndependentAppBilling(
  environment: Record<string, string | undefined>,
) {
  const raw = environment.TEST_CREDIT_APPLICATION_BINDINGS;
  if (!raw?.trim()) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Invalid Test Credit application bindings.");
  }
  const parsed = bindings.safeParse(data);
  if (!parsed.success)
    throw new Error("Invalid Test Credit application bindings.");
  const credentials = new Map(Object.entries(parsed.data));
  if (
    credentials.size === 0 ||
    new Set(credentials.values()).size !== credentials.size
  )
    throw new Error(
      "Test Credit applications require distinct credential digests.",
    );
  return {
    casdoor: requireBillingCasdoorProvider(environment),
    execute: loadMeteredChatExecutor(environment),
    async authenticate(request: Request, applicationId: string) {
      const expected = credentials.get(applicationId);
      const credential = request.headers.get("authorization");
      if (!expected || !credential?.startsWith("Bearer ")) return false;
      const token = credential.slice(7);
      if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) return false;
      return timingSafeEqual(
        Buffer.from(expected, "hex"),
        createHash("sha256").update(token).digest(),
      );
    },
  };
}
