import { z } from "zod";

const identifier = z.string().min(1).max(180);
export const supportResource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("conversation"), id: identifier }),
  z.strictObject({ kind: z.literal("file"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("computer-session"), id: identifier }),
]);

export type SupportResource = z.infer<typeof supportResource>;
export const supportReason = z.string().trim().min(1).max(500);
export const maxSupportSeconds = 24 * 60 * 60;
