/**
 * Reads and writes for the code_runs table. Deliberately boring: the interesting decisions belong
 * to the gateway; this file only makes sure the row exists before the sandbox is called and is
 * finished after, whichever way the run went.
 */
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/client";
import { codeRuns, type CodeRunStatus } from "../db/schema/code-runs";

export function newCodeRunId(): string {
  return `cr-${randomBytes(12).toString("hex")}`;
}

export type CodeRunCreate = {
  id: string;
  botId: string;
  ownerUserId: string;
  task: string;
  model: string;
};

export type CodeRunFinish = {
  status: CodeRunStatus;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  artifactPaths?: string;
  error?: string;
  finishedAt?: Date;
};

export type CodeRunStore = {
  create(input: CodeRunCreate): Promise<void>;
  finish(id: string, patch: CodeRunFinish): Promise<void>;
  get(id: string): Promise<{
    id: string;
    botId: string;
    status: CodeRunStatus;
    inputTokens: number | null;
    outputTokens: number | null;
    error: string | null;
    finishedAt: Date | null;
  } | undefined>;
};

export function createCodeRunStore(db: Database): CodeRunStore {
  return {
    async create(input) {
      await db.insert(codeRuns).values({
        id: input.id,
        botId: input.botId,
        ownerUserId: input.ownerUserId,
        task: input.task,
        model: input.model,
        status: "running",
        startedAt: new Date(),
      });
    },

    async finish(id, patch) {
      await db
        .update(codeRuns)
        .set({
          status: patch.status,
          sessionId: patch.sessionId,
          inputTokens: patch.inputTokens,
          outputTokens: patch.outputTokens,
          artifactPaths: patch.artifactPaths,
          error: patch.error,
          finishedAt: patch.finishedAt ?? new Date(),
        })
        .where(eq(codeRuns.id, id));
    },

    async get(id) {
      const rows = await db
        .select({
          id: codeRuns.id,
          botId: codeRuns.botId,
          status: codeRuns.status,
          inputTokens: codeRuns.inputTokens,
          outputTokens: codeRuns.outputTokens,
          error: codeRuns.error,
          finishedAt: codeRuns.finishedAt,
        })
        .from(codeRuns)
        .where(eq(codeRuns.id, id))
        .limit(1);
      return rows[0];
    },
  };
}
