import type { Tool } from "@ag-ui/client";
import {
  formatSkillCatalog,
  loadSkill,
  readSkillFile,
  SkillRegistry,
} from "@copilotkit/runtime/internal/learned-skills";
import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type {
  LearningDeliveryStatus,
  LearningSettings,
  LearningTarget,
} from "@openbot/shared/learning";
import type { LearningSettingsStore } from "./settings";

// This published internal export is pinned to runtime 1.73.1. Keep its use here: the SDK owns
// archive verification, refresh, revocation and stale-cache policy for every OpenBot framework.
export type LearnedSkillInvocation = {
  readonly catalog: string;
  readonly tools: readonly Tool[];
  execute(name: string, args: unknown): Promise<string>;
};
export type AcquireLearnedSkills = (
  agentId: string,
  signal?: AbortSignal,
) => Promise<LearnedSkillInvocation | undefined>;

const LOAD_SKILL_TOOL = "copilotkit_load_skill";
const READ_SKILL_FILE_TOOL = "copilotkit_read_skill_file";
/** The contract surface the framework filters on; the two names above are its only source. */
export const LEARNED_SKILL_TOOL_NAMES = new Set([
  LOAD_SKILL_TOOL,
  READ_SKILL_FILE_TOOL,
]);
const skillArgs = z.object({ skill_name: z.string().min(1) }).strict();
const fileArgs = skillArgs.extend({ path: z.string().min(1) }).strict();
const skillTools: readonly Tool[] = [
  {
    name: LOAD_SKILL_TOOL,
    description:
      "Load a published learned Skill's instructions and supporting file names.",
    parameters: z.toJSONSchema(skillArgs),
  },
  {
    name: READ_SKILL_FILE_TOOL,
    description:
      "Read one supporting text file from a published learned Skill.",
    parameters: z.toJSONSchema(fileArgs),
  },
];

export function selectLearningTarget(
  settings: LearningSettings,
  agentId: string,
): LearningTarget | undefined {
  if (!settings.enabled) return undefined;
  return (
    (Object.hasOwn(settings.agents, agentId)
      ? settings.agents[agentId]
      : settings.defaultTarget) ?? undefined
  );
}

/** Cancel this invocation's wait without cancelling another invocation's shared refresh. */
function waitForSnapshot<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Called once after loadConfig consumes the environment default, before any registry exists. */
export function clearLearningRevisionFallback(
  environment: Record<string, string | undefined> = process.env,
): void {
  delete environment.CPK_INTELLIGENCE_SKILLS_REVISION;
}

export type LearningThread = {
  threadId: string;
  agentId: string;
  userId: string;
};

export function createLearningRuntime(options: {
  store: LearningSettingsStore;
  /**
   * The Intelligence client, or a lazy accessor for one (ME15 #487).
   *
   * Every use is behind the settings read (`selectLearningTarget`), so with
   * learning disabled the client is never resolved and never constructed —
   * the deployment that switched learning off holds no Intelligence client
   * because of this runtime. Pass the accessor from
   * `lazyIntelligenceClient` here, not its result.
   */
  client: CopilotKitIntelligence | (() => CopilotKitIntelligence);
  freshnessWindowMs?: number;
}) {
  const { store } = options;
  const clientOption = options.client;
  const clientOf = (): CopilotKitIntelligence =>
    typeof clientOption === "function" ? clientOption() : clientOption;
  const registries = new Map<string, SkillRegistry>();
  const registryKey = (target: LearningTarget) =>
    `${target.containerId}\n${target.revision ?? ""}`;
  const registryFor = (target: LearningTarget) => {
    const key = registryKey(target);
    let registry = registries.get(key);
    if (!registry) {
      registry = new SkillRegistry({
        client: clientOf(),
        containerId: target.containerId,
        ...(target.revision ? { revision: target.revision } : {}),
        ...(options.freshnessWindowMs === undefined
          ? {}
          : { freshnessWindowMs: options.freshnessWindowMs }),
      });
      registries.set(key, registry);
      // One live registry per container: a registry pinned to an older revision is
      // unreachable once the target moves on, so it is dropped instead of accumulating.
      for (const existingKey of registries.keys()) {
        if (
          existingKey !== key &&
          existingKey.split("\n")[0] === target.containerId
        )
          registries.delete(existingKey);
      }
    }
    return registry;
  };

  const acquire: AcquireLearnedSkills = async (agentId, signal) => {
    signal?.throwIfAborted();
    const target = selectLearningTarget(await store.read(), agentId);
    signal?.throwIfAborted();
    if (!target) return undefined;
    const snapshot = await waitForSnapshot(
      registryFor(target).acquireSnapshot(),
      signal,
    );
    signal?.throwIfAborted();
    return {
      catalog: snapshot.skills.length > 0 ? formatSkillCatalog(snapshot) : "",
      tools: snapshot.skills.length > 0 ? skillTools : [],
      execute: async (name, args) => {
        if (name === LOAD_SKILL_TOOL) {
          return loadSkill(snapshot, skillArgs.parse(args).skill_name);
        }
        if (name === READ_SKILL_FILE_TOOL) {
          const parsed = fileArgs.parse(args);
          // Local containment check beside the SDK's own: the model supplies this path, so
          // absolute paths and upward segments never reach the snapshot reader.
          const path = parsed.path;
          if (
            path.startsWith("/") ||
            /^[a-zA-Z]:/.test(path) ||
            path.split(/[\\/]/).includes("..")
          ) {
            throw new Error("That path is outside the Skill's files.");
          }
          return readSkillFile(snapshot, parsed.skill_name, path);
        }
        throw new Error("That is not a learned Skill tool.");
      },
    };
  };

  return {
    acquire,
    /**
     * Bind once, before thread creation. The SDK calls this selector before its ownership check,
     * so the verified user scopes the durable decision. Existing Threads are never backfilled.
     */
    async containerForThread(
      input: LearningThread,
    ): Promise<string | undefined> {
      if (!input.userId.trim())
        throw new Error("Learning Thread assignment requires a verified user.");
      const target = selectLearningTarget(await store.read(), input.agentId);
      if (!target) return undefined;
      let exists = false;
      try {
        await clientOf().getThread({
          threadId: input.threadId,
          userId: input.userId,
        });
        exists = true;
      } catch (error) {
        // 404 is judged by the structured status field alone: pinning the error class name
        // too would read "thread exists" as a real fault when the SDK reshapes its errors.
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? (error as { status?: unknown }).status
            : undefined;
        if (status !== 404) throw error;
      }
      const containerId = await store.bindThread({
        userId: input.userId,
        threadId: input.threadId,
        agentId: input.agentId,
        containerId: exists ? null : target.containerId,
      });
      return containerId ?? undefined;
    },
    async status(agentId: string): Promise<LearningDeliveryStatus> {
      const target = selectLearningTarget(await store.read(), agentId);
      if (!target)
        return { configured: false, initialized: false, stale: false };
      const status = registries.get(registryKey(target))?.status;
      return {
        configured: true,
        containerId: target.containerId,
        initialized: status?.initialized ?? false,
        stale: status?.stale ?? false,
        ...(status?.revision ? { revision: status.revision } : {}),
        ...(status?.lastCheckedAt
          ? { lastCheckedAt: status.lastCheckedAt }
          : {}),
        ...(status?.lastError ? { error: status.lastError } : {}),
      };
    },
    inspect: (
      input: Parameters<CopilotKitIntelligence["getInspectorLearning"]>[0],
    ) => clientOf().getInspectorLearning(input),
  };
}
export type LearningRuntime = ReturnType<typeof createLearningRuntime>;
