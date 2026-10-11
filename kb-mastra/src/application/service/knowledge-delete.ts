/**
 * 删除级联（修订 §2.3 铁律 A15）：**先 Qdrant 后 SQL**——中途失败的残留形态
 * 是「SQL 有 chunks 行但无向量」（检索不可见、可重删、无害）；反序会产生会被
 * 检索到的孤儿 point。
 *
 * 文档级：deleteByDoc → chunks 硬删（修订后 chunks 无软删需求？WeKnora 有
 * deleted_at——保留软删语义：文档行软删，chunks 硬删（检索面由 Qdrant 承载）。
 * KB 级：deleteByKb → 文档行/KB 行软删（FK cascade 由 DB 承担 chunks）。
 */

import { eq } from "drizzle-orm";
import { getLogger } from "../../../../shared/logger";
import type { Db } from "../../db/client";
import { chunks, knowledgeBases, knowledges } from "../../db/schema";
import type { IndexWriter } from "../repository/retriever/qdrant/index-writer";

const log = getLogger("kb-mastra");

export type DeleteDeps = {
  db: Db;
  indexWriter: IndexWriter;
};

/** 删一份文档：先 Qdrant points，后 SQL chunks 硬删 + knowledges 软删。幂等。 */
export async function deleteKnowledge(
  deps: DeleteDeps,
  input: { tenantId: string; kbId: string; knowledgeId: string },
): Promise<{ deleted: boolean }> {
  const [row] = await deps.db
    .select()
    .from(knowledges)
    .where(eq(knowledges.id, input.knowledgeId))
    .limit(1);
  if (
    !row ||
    row.tenantId !== input.tenantId ||
    row.knowledgeBaseId !== input.kbId
  ) {
    // 不存在或跨租户：幂等返回（handler 折 404）。
    return { deleted: false };
  }

  // ① Qdrant 先删（wait=true：删完才算数）。
  await deps.indexWriter.deleteByDoc(input.tenantId, input.knowledgeId);
  // ② SQL：chunks 硬删 → knowledges 软删。
  await deps.db.delete(chunks).where(eq(chunks.knowledgeId, input.knowledgeId));
  await deps.db
    .update(knowledges)
    .set({
      deletedAt: new Date(),
      parseStatus: "deleting",
      updatedAt: new Date(),
    })
    .where(eq(knowledges.id, input.knowledgeId));
  log.info(
    { type: "kb-document-deleted", knowledgeId: input.knowledgeId },
    "kb-document-deleted",
  );
  return { deleted: true };
}

/** 删整个 KB：先 Qdrant 全库 points，后 SQL（FK cascade 清 chunks，行软删）。幂等。 */
export async function deleteKnowledgeBase(
  deps: DeleteDeps,
  input: { tenantId: string; kbId: string },
): Promise<{ deleted: boolean }> {
  const [kb] = await deps.db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, input.kbId))
    .limit(1);
  if (!kb || kb.tenantId !== input.tenantId) return { deleted: false };

  // ① Qdrant 全库 points。
  await deps.indexWriter.deleteByKb(input.tenantId, input.kbId);
  // ② SQL：文档行软删（chunks 由 FK ON DELETE CASCADE 跟随）→ KB 行软删。
  await deps.db
    .update(knowledges)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(knowledges.knowledgeBaseId, input.kbId));
  await deps.db
    .update(knowledgeBases)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(knowledgeBases.id, input.kbId));
  log.info({ type: "kb-base-deleted", kbId: input.kbId }, "kb-base-deleted");
  return { deleted: true };
}
