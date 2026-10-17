import { describe, expect, test } from "bun:test";
import { deleteKnowledge, deleteKnowledgeBase } from "./knowledge-delete";
import { toWireTask } from "../../handler/shared";
import type { DocRow } from "../../handler/shared";
import type { IndexWriter } from "../repository/retriever/qdrant/index-writer";

/**
 * QA 补盲区（跨模块组合）：删除级联 × task 投影 × Qdrant-first 顺序。
 * 桩对齐 drizzle 链式形态（delete(t).where() / update(t).set().where()），
 * 断言 A15 铁律的执行顺序（qdrant op 的完成先于任何 sql 写 op 开始）。
 */

function makeStubs(rowExists = true) {
  const ops: string[] = [];
  let clock = 0;
  const tick = () => (clock += 1);

  const writer: IndexWriter = {
    async upsertChunks() {},
    async deleteByDoc(tenantId, docId) {
      tick();
      ops.push(`#${clock} qdrant:doc ${tenantId}/${docId}`);
    },
    async deleteByKb(tenantId, kbId) {
      tick();
      ops.push(`#${clock} qdrant:kb ${tenantId}/${kbId}`);
    },
  };

  const chain = (label: string) => {
    const state: Record<string, unknown> = {};
    const c = {
      where() {
        tick();
        ops.push(
          `#${clock} sql ${label} ${JSON.stringify(Object.keys(state))}`,
        );
        return Promise.resolve();
      },
      set(values: Record<string, unknown>) {
        Object.assign(state, values);
        return c;
      },
    };
    return c;
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            rowExists
              ? [
                  {
                    id: "doc-1",
                    tenantId: "t1",
                    knowledgeBaseId: "kb-1",
                    deletedAt: null,
                  },
                ]
              : [],
        }),
      }),
    }),
    delete: (table: unknown) =>
      chain(table === "chunks" ? "delete-chunks" : `delete-${String(table)}`),
    update: (table: unknown) => chain(`update-${String(table)}`),
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩需要覆盖 knowledges/knowledgeBases 标识
  } as any;
  // drizzle 表对象用名字区分（真实代码传 chunks/knowledges/knowledgeBases 表常量——
  // 桩里以字符串伪装，通过 Symbol/toString 区分）。
  const chunks = "chunks";
  const knowledges = "knowledges";
  const knowledgeBases = "knowledgeBases";
  return { ops, writer, db, chunks, knowledges, knowledgeBases };
}

describe("deleteKnowledge: Qdrant-first 铁律（文档级）", () => {
  test("qdrant delete completes before any SQL write starts", async () => {
    const s = makeStubs();
    await deleteKnowledge(
      { db: s.db, indexWriter: s.writer },
      { tenantId: "t1", kbId: "kb-1", knowledgeId: "doc-1" },
    );
    // 顺序断言：第一笔是 qdrant，其后才是 SQL
    expect(s.ops[0]).toMatch(/^#\d+ qdrant:doc/);
    expect(s.ops.length).toBe(3); // qdrant + delete-chunks + update-knowledges
    const qdrantClock = Number(s.ops[0].slice(1).split(" ")[0]);
    for (const op of s.ops.slice(1)) {
      expect(Number(op.slice(1).split(" ")[0])).toBeGreaterThan(qdrantClock);
    }
  });

  test("row absent (already deleted / wrong id) → idempotent no-op, qdrant untouched", async () => {
    const s = makeStubs(false);
    const result = await deleteKnowledge(
      { db: s.db, indexWriter: s.writer },
      { tenantId: "t1", kbId: "kb-1", knowledgeId: "doc-1" },
    );
    expect(result).toEqual({ deleted: false });
    expect(s.ops.length).toBe(0);
  });
});

describe("deleteKnowledgeBase: Qdrant-first 铁律（KB 级）", () => {
  test("kb cascade: qdrant first, then knowledges soft-delete, then KB soft-delete", async () => {
    const s = makeStubs();
    await deleteKnowledgeBase(
      { db: s.db, indexWriter: s.writer },
      { tenantId: "t1", kbId: "kb-1" },
    );
    expect(s.ops[0]).toMatch(/^#\d+ qdrant:kb/);
    expect(s.ops.length).toBe(3); // qdrant + update-knowledges + update-knowledgeBases
    // drizzle 表常量 String() 不可辨——按形状断言：两笔 sql update，先文档行后 KB 行
    // （源码顺序 knowledges 在前、knowledgeBases 在后），且都晚于 qdrant。
    const qdrantClock = Number(s.ops[0].slice(1).split(" ")[0]);
    const sqlOps = s.ops.slice(1);
    for (const op of sqlOps) {
      expect(op).toMatch(/^#\d+ sql update-/);
      expect(Number(op.slice(1).split(" ")[0])).toBeGreaterThan(qdrantClock);
    }
    // 两笔 update 的 set 字段都含 deletedAt（软删语义）
    expect(sqlOps.every((op) => op.includes("deletedAt"))).toBe(true);
  });

  test("cross-tenant KB delete → no-op", async () => {
    // 桩恒返回 tenant t1；用 tenant WRONG 请求 → 判定不通过
    const s = makeStubs(true);
    const result = await deleteKnowledgeBase(
      { db: s.db, indexWriter: s.writer },
      { tenantId: "WRONG", kbId: "kb-1" },
    );
    // 桩的 select 返回固定 t1 行——KB 级第一查是 knowledgeBases 表，
    // 桩同样返回该形状（tenantId t1 ≠ WRONG）→ deleted:false
    expect(result).toEqual({ deleted: false });
    expect(s.ops.filter((op) => op.includes("qdrant")).length).toBe(0);
  });
});

describe("task 投影：deleting/cancelled → failed 路径", () => {
  const baseDoc: DocRow = {
    id: "doc-d",
    kbId: "kb-1",
    tenantId: "t1",
    title: "已删除",
    type: "file",
    fileName: "",
    fileType: "",
    parseStatus: "deleting",
    chunkCount: 0,
    metadata: null,
    progress: null,
    errorMessage: "",
    createdAt: new Date("2026-10-11T08:00:00Z"),
    updatedAt: new Date("2026-10-11T08:00:00Z"),
  };

  test("deleting 投影为 failed（前端停止轮询）", () => {
    expect(toWireTask(baseDoc).status).toBe("failed");
  });

  test("cancelled 同样 failed；failed 带 error", () => {
    expect(toWireTask({ ...baseDoc, parseStatus: "cancelled" }).status).toBe(
      "failed",
    );
    const failed = toWireTask({
      ...baseDoc,
      parseStatus: "failed",
      errorMessage: "docreader timeout",
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("docreader timeout");
  });

  test("deleteKnowledge 置的 deleting 终局：task 无 error 字段（删除非失败语义）", () => {
    const wire = toWireTask(baseDoc);
    expect(wire.progress).toBe(0);
    expect("error" in wire).toBe(false);
  });
});
