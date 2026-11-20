import { z } from "zod";

export const personalSaasMode =
  process.env.EXPO_PUBLIC_OPENBOT_MODE === "personal-saas";
export const personalSaasCallbackUrl = "openbotmobile://auth/personal-saas";
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const callback = z.union([
  z.strictObject({ state: proof, code: proof }),
  z.strictObject({
    state: proof,
    error: z.enum([
      "email_unverified",
      "account_unavailable",
      "sign_in_incomplete",
    ]),
  }),
]);
const nativeSession = z.strictObject({
  token: proof,
  expiresIn: z.number().positive(),
});
const pausedWorkspace = z.strictObject({
  status: z.literal("paused"),
  operationId: z.uuid(),
  reason: z.string().nullable(),
  supportEmail: z.email().nullable(),
});
export type PausedWorkspace = z.infer<typeof pausedWorkspace>;
const cutoffState = z.enum(["pending", "confirmed", "failed"]);
const closedWorkspace = z.object({
  status: z.literal("closed"),
  operationId: z.uuid(),
  executionCutoff: z.object({
    sessions: z.literal("revoked"),
    work: cutoffState,
    computer: cutoffState,
  }),
  onlineCleanup: z.literal("pending"),
  remoteRevocation: z.literal("pending"),
  backups: z.literal("pending"),
});
export type ClosedWorkspace = z.infer<typeof closedWorkspace>;
export const nativeExchange = z.union([
  nativeSession,
  pausedWorkspace,
  closedWorkspace,
]);
export const workspaceAccessMs = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(60_000));

const quotaUsage = z.object({
  used: z.number().int().nonnegative().nullable(),
  limit: z.number().int().nonnegative(),
});

export const personalWorkspace = z.object({
  id: z.string().min(1),
  recovery: z
    .array(
      z.object({
        key: z.uuid(),
        instruction: z.string(),
        reasonMessage: z.string(),
        output: z.string().nullable(),
        outcomeUnknown: z.boolean(),
        recovery: z.object({ action: z.enum(["cancel", "retry"]) }).nullable(),
      }),
    )
    .default([]),
  quotas: z
    .object({
      bot: quotaUsage,
      computer: quotaUsage,
      storage: quotaUsage,
      automation: quotaUsage,
    })
    .optional(),
  recoveryCanRetry: z.boolean().default(false),
  personalAssistant: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
});
export type PersonalWorkspace = z.infer<typeof personalWorkspace>;
export const personalConversationHistory = z.object({
  conversations: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string(),
      preview: z.string().nullable(),
    }),
  ),
});

export function parsePersonalSaasCallback(raw: string, state: string) {
  if (!raw.startsWith(`${personalSaasCallbackUrl}?`) || raw.includes("#"))
    return { kind: "invalid" } as const;
  const url = new URL(raw);
  const params = Object.fromEntries(url.searchParams);
  const result = callback.safeParse(params);
  if (
    !result.success ||
    [...url.searchParams].length !== Object.keys(params).length ||
    result.data.state !== state
  )
    return { kind: "invalid" } as const;
  return "code" in result.data
    ? ({ kind: "code", code: result.data.code } as const)
    : ({ kind: "error", error: result.data.error } as const);
}
