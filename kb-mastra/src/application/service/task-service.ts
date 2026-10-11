/**
 * task 投影（v1 §6.3）：knowledges 行 + progress jsonb → OpenBot 的
 * KnowledgeTask DTO（4 态 wire）。tasks/:taskId 的 taskId 语义 = knowledgeId
 * （kb-service 契约：上传返回 {task_id=knowledgeId, doc_id}）。
 *
 * ParseStatus 7→4 投影表是契约核心：finalizing→processing（前端轮询单调跳变）、
 * deleting/cancelled→failed（停止轮询语义）。B 线 handler 若需同款投影，
 * toWireParseStatus 从这里 import（单一出处）。
 */

import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { knowledges, type ParseStatusInternal } from "../../db/schema";

/** 对外 4 态（OpenBot ParseStatus）。 */
export type WireParseStatus = "pending" | "processing" | "completed" | "failed";

/** 7→4 投影（v1 §6.3 表）。 */
export function toWireParseStatus(status: ParseStatusInternal): WireParseStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "processing":
    case "finalizing":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
    case "deleting":
    case "cancelled":
      return "failed";
  }
}

/** OpenBot KnowledgeTask 的 wire 形状（server/src/knowledge/types.ts 镜像）。 */
export type KnowledgeTaskDTO = {
  task_id: string;
  kb_id: string;
  doc_id: string;
  status: WireParseStatus;
  /** 0-100。 */
  progress: number;
  chunks_done: number;
  chunks_total: number;
  error?: string;
  created_at: string;
};

/**
 * 查一条 task 投影。行不在或跨租户 → null（handler 折 404）。
 */
export async function getTaskProjection(
  db: Db,
  input: { tenantId: string; kbId: string; taskId: string },
): Promise<KnowledgeTaskDTO | null> {
  const [row] = await db
    .select()
    .from(knowledges)
    .where(eq(knowledges.id, input.taskId))
    .limit(1);
  if (!row || row.tenantId !== input.tenantId || row.knowledgeBaseId !== input.kbId) {
    return null;
  }

  const progress = row.progress;
  const chunksTotal = progress?.chunksTotal ?? 0;
  const chunksDone = progress?.chunksDone ?? 0;
  // 百分比：有总数按 chunk 进度；终态恒 100（failed 也 100——前端停轮询靠 status）。
  const status = toWireParseStatus(row.parseStatus);
  const percent =
    status === "completed" || status === "failed"
      ? 100
      : chunksTotal > 0
        ? Math.floor((chunksDone / chunksTotal) * 100)
        : row.parseStatus === "pending"
          ? 0
          : 10; // processing 无 chunk 计数时的低保真进度。

  return {
    task_id: row.id,
    kb_id: row.knowledgeBaseId,
    doc_id: row.id,
    status,
    progress: percent,
    chunks_done: chunksDone,
    chunks_total: chunksTotal,
    ...(row.errorMessage !== "" ? { error: row.errorMessage } : {}),
    created_at: row.createdAt.toISOString(),
  };
}
