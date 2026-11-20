import {
  CopilotKitIntelligence,
  IntelligenceAgentRunner,
} from "@copilotkit/runtime/v2";
import { createTurnRunner } from "@openbot/toolkit/run-turn";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  buildAgents,
  chooseOpenAIApi,
  normalizeModelBaseUrls,
  registeredAgentFromRow,
} from "../copilot";
import type { Database } from "../db/client";
import {
  agentProfiles,
  agents,
  personalWorkspaceDefaultBots,
  personalWorkspaces,
} from "../db/schema";
import { readExecutionAccess } from "./account-access";

const botRuntimeConfig = z.object({
  INTELLIGENCE_API_URL: z.url({ protocol: /^https?$/ }),
  INTELLIGENCE_GATEWAY_WS_URL: z.url({ protocol: /^wss?$/ }),
  CPK_INTELLIGENCE_API_KEY: z.string().min(1),
  BOT_MODEL: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

export function createPersonalBotRuntime(database: Database) {
  const config = botRuntimeConfig.safeParse(process.env);
  if (!config.success)
    throw new Error(
      `Invalid Personal SaaS Bot runtime configuration: ${config.error.issues.map(({ path }) => path.join(".")).join(", ")}`,
    );
  const env = config.data;
  const intelligence = new CopilotKitIntelligence({
    apiUrl: env.INTELLIGENCE_API_URL,
    wsUrl: env.INTELLIGENCE_GATEWAY_WS_URL,
    apiKey: env.CPK_INTELLIGENCE_API_KEY,
  });
  const model = { provider: "openai", defaultModel: env.BOT_MODEL } as const;
  normalizeModelBaseUrls();
  chooseOpenAIApi(model);
  return createTurnRunner({
    intelligence,
    runner: new IntelligenceAgentRunner({
      url: intelligence.ɵgetRunnerWsUrl(),
      authToken: intelligence.ɵgetRunnerAuthToken(),
    }),
    admission: async ({ ownerUserId, signal }) => {
      const access = await database.transaction((tx) =>
        readExecutionAccess(tx, ownerUserId, Date.now),
      );
      if (access?.kind !== "active" || !signal)
        throw new Error("Workspace execution is unavailable");
      signal.throwIfAborted();
      return signal;
    },
    buildAgentFor: async ({ ownerUserId, agentId }) => {
      const [row] = await database
        .select({
          id: agents.id,
          name: agents.name,
          configuration: agents.configuration,
          type: agents.type,
          title: agentProfiles.title,
          roleDescription: agentProfiles.roleDescription,
        })
        .from(personalWorkspaces)
        .innerJoin(
          personalWorkspaceDefaultBots,
          eq(personalWorkspaceDefaultBots.workspaceId, personalWorkspaces.id),
        )
        .innerJoin(agents, eq(agents.id, personalWorkspaceDefaultBots.agentId))
        .innerJoin(agentProfiles, eq(agentProfiles.agentId, agents.id))
        .where(
          and(
            eq(personalWorkspaces.ownerId, ownerUserId),
            eq(agents.id, agentId),
            eq(agents.type, "built_in"),
            isNull(agentProfiles.deletedAt),
          ),
        );
      const definition = row && registeredAgentFromRow(row);
      if (!definition) throw new Error("Personal Assistant is unavailable");
      const built = await buildAgents([definition], model, env.OPENAI_API_KEY);
      const agent = built[agentId];
      if (!agent) throw new Error("Personal Assistant could not start");
      return agent;
    },
  });
}
