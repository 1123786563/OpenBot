import { z } from "zod";

export const coordinationCalls = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(256),
      name: z.string().min(1).max(64),
      arguments: z.string().max(16_384),
    }),
  )
  .min(1)
  .max(8)
  .refine((calls) => new Set(calls.map(({ id }) => id)).size === calls.length);

export const providerCoordinationCalls = z
  .array(
    z.object({
      id: z.string(),
      type: z.literal("function"),
      function: z.object({ name: z.string(), arguments: z.string() }),
    }),
  )
  .min(1)
  .max(8);

export const readProviderCoordinationCalls = providerCoordinationCalls
  .transform((calls) =>
    calls.map((call) => ({ id: call.id, ...call.function })),
  )
  .pipe(coordinationCalls);

export type CoordinationModelCall = z.infer<typeof coordinationCalls>[number];

export type CoordinationToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
