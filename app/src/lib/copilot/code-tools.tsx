import { z } from "zod";
import { useActiveBotId } from "./active-bot";
import { useFrontendTool } from "./approval-tools";
import { callCodeSandbox } from "@/lib/codesandbox/call";

/**
 * The run_code tool, offered to the model whenever the person is chatting with a Bot. The server
 * decides whether the deployment actually has a sandbox; a refusal comes back as the tool result
 * either way, so the model can tell the person instead of guessing.
 */
export function CodeSandboxTools() {
  const botId = useActiveBotId();

  useFrontendTool({
    name: "run_code",
    description:
      "Run a code task in the Bot's sandboxed computer: write and execute scripts, analyze data files, produce output files. The sandbox has Python 3 and Node. Describe the task and the wanted artifacts; the sandbox agent iterates on its own.",
    parameters: z.object({
      task: z
        .string()
        .describe(
          "The complete task for the sandbox agent, including what output files to produce.",
        ),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(600)
        .optional()
        .describe(
          "Execution budget in seconds. Default 120, maximum 600.",
        ),
    }),
    handler: async (
      { task, timeoutSeconds }: { task: string; timeoutSeconds?: number },
      { signal }: { signal?: AbortSignal; toolCall?: { id?: string } } = {},
    ) => {
      if (!botId) return "No active Bot, so there is nothing to run code for.";
      return callCodeSandbox(
        { botId, task, ...(timeoutSeconds ? { timeoutSeconds } : {}) },
        signal,
      );
    },
  });

  return null;
}
