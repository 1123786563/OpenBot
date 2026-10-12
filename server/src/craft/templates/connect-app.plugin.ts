// A no-op `connect_app` tool the agent calls to ask the user to connect an org
// app it isn't set up for yet. It does nothing itself: `context.ask` pauses the
// turn and the api-server drives the connect card, then answers allow/deny (see
// serve-client's connect_app handling + connect-app-routes.ts).
//
// Ported verbatim from onyx `sandbox/image/opencode-plugins/connect-app.ts`
// (schema strings and both result strings byte-for-byte). One mechanical
// deviation, forced by this file's home inside the server tree (it ships as
// TEXT — written into each session workspace beside the turn-budget plugin,
// because the agent-sandbox image cannot bake it): the `satisfies Plugin` type
// sugar is dropped and the runtime SDK load is tried through additional
// absolute-path candidates beside onyx's two (`@opencode-ai/plugin` is not a
// server dependency, and the deployed sandbox image's install layout differs
// from onyx's). The candidate list is the one piece the agent-sandbox image
// must confirm; a miss is a load error opencode reports per-plugin, never a
// turn failure.
//
// Module resolution: the workspace has no node_modules, so a bare runtime
// `import` of the SDK cannot resolve. The `tool` helper is loaded at runtime by
// absolute path from opencode's bundled SDK (same approach as onyx's image).

const SDK_TOOL_PATHS = [
  "/home/sandbox/.opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
  "/home/sandbox/.config/opencode/node_modules/@opencode-ai/plugin/dist/tool.js",
];

/**
 * A structural stand-in for the SDK's `tool` helper — erased at runtime (the
 * real helper arrives through the dynamic import below); it exists only so
 * this text ships typechecked. `schema` mirrors the two builder chains the
 * args use, to the depth they are chained.
 */
type ToolFactory = {
  (definition: ToolDefinition): unknown;
  schema: {
    number(): { int(): { describe(description: string): unknown } };
    string(): { optional(): { describe(description: string): unknown } };
  };
};

async function loadToolFactory(): Promise<ToolFactory> {
  for (const path of SDK_TOOL_PATHS) {
    try {
      return (await import(path)).tool;
    } catch {
      // biome-ignore lint/complexity/noUselessContinue: onyx-verbatim loop shape
      continue;
    }
  }
  throw new Error("could not resolve the @opencode-ai/plugin tool helper");
}

type ToolDefinition = {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: { external_app_id: number; reason?: string },
    context: {
      ask(input: {
        permission: string;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
      }): Promise<unknown>;
    },
  ): Promise<string>;
};

export default async () => {
  const tool = await loadToolFactory();

  return {
    tool: {
      connect_app: tool({
        description:
          "Ask the user to connect an org app you aren't set up to use yet. " +
          "Pass the app's numeric ID (as listed under 'Connectable apps' in AGENTS.md). " +
          "This pauses for the user to connect it. If this returns normally the " +
          "app is connected and you can use it; if it is denied, do not retry — " +
          "offer an alternative.",
        args: {
          external_app_id: tool.schema
            .number()
            .int()
            .describe("Numeric ID of the connectable app, e.g. 42"),
          reason: tool.schema
            .string()
            .optional()
            .describe(
              "One short sentence on why you need it, shown to the user",
            ),
        },
        async execute(args, context) {
          // Blocks until the user answers; resolves on connect, throws on
          // decline. Requires opencode.json `connect_app: "ask"` to prompt.
          try {
            await context.ask({
              permission: "connect_app",
              patterns: [String(args.external_app_id)],
              always: [],
              metadata: {
                external_app_id: args.external_app_id,
                reason: args.reason ?? "",
              },
            });
          } catch {
            // Return a normal result so the agent keeps control and picks an
            // alternative, rather than letting the rejection abort the turn.
            return (
              `The user declined to connect external app ${args.external_app_id}. ` +
              `Do not retry connecting ` +
              `it; offer an alternative or proceed without it.`
            );
          }
          return `External app ${args.external_app_id} is connected. You can use it now.`;
        },
      }),
    },
  };
};
