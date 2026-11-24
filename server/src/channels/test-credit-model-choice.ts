import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { ProfileReadExecutor } from "../agents/profile-store";
import { testCreditModelPick } from "../billing/test-credit";
import {
  agents,
  channelAgents,
  intelligenceChannelMappings,
} from "../db/schema";

export const testCreditModelSelection = z.strictObject({
  selection: testCreditModelPick.nullable(),
});

export type TestCreditModelPick = z.infer<typeof testCreditModelPick>;
const key = "testCreditModel";

function read(value: unknown) {
  if (typeof value !== "object" || value === null || !(key in value))
    return null;
  return testCreditModelPick.parse(Reflect.get(value, key));
}

export async function botTestCreditModel(
  executor: ProfileReadExecutor,
  botId: string,
) {
  const [bot] = await executor
    .select({ configuration: agents.configuration })
    .from(agents)
    .where(eq(agents.id, botId));
  return read(bot?.configuration);
}

export async function conversationTestCreditModels(
  executor: ProfileReadExecutor,
  personId: string,
  botId: string,
  threadId: string,
) {
  const mapping = intelligenceChannelMappings;
  const [row] = await executor
    .select({ selection: mapping.modelSelection, bot: agents.configuration })
    .from(mapping)
    .innerJoin(
      channelAgents,
      and(
        eq(channelAgents.channelId, mapping.channelId),
        eq(channelAgents.agentId, botId),
      ),
    )
    .innerJoin(agents, eq(agents.id, channelAgents.agentId))
    .where(and(eq(mapping.userId, personId), eq(mapping.threadId, threadId)));
  return { conversation: read(row?.selection), bot: read(row?.bot) };
}

export function writeTestCreditModel(
  column:
    | typeof agents.configuration
    | typeof intelligenceChannelMappings.modelSelection,
  selection: TestCreditModelPick | null,
) {
  return selection
    ? sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify({ [key]: selection })}::text::jsonb`
    : sql`${column} - ${key}::text`;
}
