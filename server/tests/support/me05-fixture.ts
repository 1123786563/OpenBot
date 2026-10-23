import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { createTool } from "@mastra/core/tools";
import { PostgresStore } from "@mastra/pg";
import { z } from "zod";
import {
  createDisposableDatabase,
  type DisposableDatabase,
  psql,
  psqlStrict,
} from "./pg-container";

/*
 * ME05 (#477) fixtures: ONE disposable database on the local test Postgres
 * (openbot-test-pg, host port ME01_TEST_PG_PORT) holding BOTH durable sides a
 * suspended execution touches —
 *
 *  1. the OpenBot continuation + receipt tables, created by applying the REAL
 *     drizzle migration `0208_mastra_execution_continuations.sql` (so the
 *     migration itself is what the tests exercise), granted to a restricted
 *     runtime login role, and
 *  2. the Mastra PostgresStore the durable toolCallStep persists suspension
 *     snapshots into, connected with the same restricted role.
 *
 * Everything is dropped in teardown. The dev DATABASE_URL is never read and
 * no .env is consulted. The disposable database + restricted role bootstrap
 * is the shared pg-container helper (R2-10), not a local copy.
 */

export const ME05_CHILD_RESULT_PREFIX = "ME05_CHILD_RESULT:";
export const ME05_TOOL_NAME = "echo_tool";
export const ME05_INSTRUCTIONS =
  "Use the echo tool when asked, then answer briefly from its result.";
// One store secret across every process: production mints and consumes claim
// HMACs under the SAME server secret, so the child process must not carry its
// own spelling (a fork here would only survive while tokens are never
// verified across processes).
export const ME05_STORE_SECRET = "me05-integration-secret";
export const ME05_AGENT_ID = "me05-agent";

export type Me05Database = DisposableDatabase;

/**
 * Disposable database + restricted runtime role (the me01 pattern), with the
 * repository's own continuation migration (0207 in this tree) applied as the admin and then
 * granted to the runtime role. The store under test connects ONLY with the
 * restricted role, so ungranted access fails loudly instead of silently
 * running as a superuser.
 */
export function createMe05Database(): Promise<Me05Database> {
  return createDisposableDatabase({
    label: "me05",
    afterGrants: async (dbName, roleName) => {
      // The REAL migration file: split on the drizzle breakpoint marker and
      // run each statement with ON_ERROR_STOP, so a broken migration fails
      // the fixture instead of half-applying.
      const migration = await readFile(
        join(
          import.meta.dir,
          "..",
          "..",
          "drizzle",
          "0208_mastra_execution_continuations.sql",
        ),
        "utf8",
      );
      const statements = migration
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await psqlStrict(dbName, statement);
      }
      await psql(
        dbName,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mastra_execution_continuations", "mastra_execution_receipts" TO "${roleName}"`,
      );
    },
  });
}

/** Row count of the fixture's own executed-receipt table (exactly-once evidence). */
export async function countMe05Receipts(
  dbName: string,
  runId: string,
): Promise<number> {
  const escaped = runId.replace(/'/g, "''");
  const count = await psql(
    dbName,
    `SELECT count(*) FROM me05_tool_receipts WHERE run_id = '${escaped}'`,
  );
  return Number(count);
}

export interface Me05Stack {
  mastra: Mastra;
  agent: Agent;
  store: PostgresStore;
  /**
   * The loop surface the resume driver's `loopFor` reproduces (fix-round-1):
   * the counting model and the granted-tool record the suspension was written
   * under, so the production driver rebuilds the SAME loop shape.
   */
  model: unknown;
  tools: Record<string, unknown>;
}

/**
 * The durable stack every process uses for the gated tool loop: same agent
 * id, same requireApproval tool, storage-backed Mastra so a suspension
 * persists and a fresh process can resume (the ME01-proven surface). The
 * tool's execute writes one receipt row per execution — the exactly-once
 * evidence every resumers-race and replay test asserts against.
 */
export async function buildMe05Stack(options: {
  providerUrl: string;
  dbUrl: string;
  requireApproval?: boolean;
  /**
   * The engine's suspended-run listing is keyed by the agent identity the
   * suspension was written under, so a resume stack MUST carry the SAME agent
   * id as the stack that suspended (default: the fixture's own).
   */
  agentId?: string;
}): Promise<Me05Stack> {
  const agentId = options.agentId ?? ME05_AGENT_ID;
  const store = new PostgresStore({
    id: `me05-${randomUUID().slice(0, 8)}`,
    connectionString: options.dbUrl,
  });
  try {
    await store.pool.query(`CREATE TABLE IF NOT EXISTS me05_tool_receipts (
         id serial PRIMARY KEY,
         run_id text NOT NULL,
         tool_call_id text NOT NULL,
         args_digest text NOT NULL,
         receipt_status_at_execute text NOT NULL DEFAULT 'not-probed',
         executed_at timestamptz NOT NULL DEFAULT now()
       )`);
    const gatedTool = createTool({
      id: ME05_TOOL_NAME,
      description: "Echo the given value back once.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
      suspendSchema: z.object({ question: z.string() }),
      resumeSchema: z.object({ approved: z.boolean() }),
      ...(options.requireApproval ? { requireApproval: true as const } : {}),
      execute: async (input, context) => {
        const value = (input as { value: string }).value;
        const runId = process.env.ME05_RUN_ID ?? "unknown";
        const toolCallId = String(
          (context as { toolCallId?: string } | undefined)?.toolCallId ??
            "missing",
        );
        // The ordering probe (fix-round-1): at the instant the external
        // effect runs, the continuation-store receipt for THIS run must
        // already exist as 'unknown' (started recorded, not yet confirmed).
        // 'absent' would mean the resume reached the tool before the receipt.
        // Keyed by run id only: the resumed engine's execute context may not
        // carry the payload's toolCallId spelling, and the run has exactly
        // one pending operation.
        const probe = await store.pool.query(
          `SELECT status FROM mastra_execution_receipts WHERE run_id = $1 LIMIT 1`,
          [runId],
        );
        const receiptStatusAtExecute = String(
          probe.rows[0]?.status ?? "absent",
        );
        await store.pool.query(
          `INSERT INTO me05_tool_receipts (run_id, tool_call_id, args_digest, receipt_status_at_execute) VALUES ($1, $2, $3, $4)`,
          [runId, toolCallId, value, receiptStatusAtExecute],
        );
        return { echo: value };
      },
    });
    const model = (
      await import("./me01-fixture")
    ).createCountingControlledModel(options.providerUrl).model;
    const agent = new Agent({
      id: agentId,
      name: "ME05 Agent",
      instructions: ME05_INSTRUCTIONS,
      model: model as never,
      tools: { [ME05_TOOL_NAME]: gatedTool },
    });
    const mastra = new Mastra({
      agents: { [agentId]: agent },
      storage: store,
    });
    return {
      mastra,
      agent,
      store,
      model,
      tools: { [ME05_TOOL_NAME]: gatedTool },
    };
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
