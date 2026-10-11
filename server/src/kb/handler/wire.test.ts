import { describe, expect, test } from "bun:test";
import {
  type DocRow,
  type KbRow,
  toWireDocument,
  toWireKB,
  toWireTask,
  validateCreateKbInput,
  validateRetrieveInput,
} from "./shared";
import { fromWireSource, toIso, toWireParseStatus, toWireSource } from "./wire";

/** wire 投影与 handler 校验：与 Go kb-service 响应结构逐字段对照。 */

describe("ParseStatus 7→4 投影（v1 §6.3）", () => {
  test("direct mappings", () => {
    expect(toWireParseStatus("pending")).toBe("pending");
    expect(toWireParseStatus("processing")).toBe("processing");
    expect(toWireParseStatus("completed")).toBe("completed");
    expect(toWireParseStatus("failed")).toBe("failed");
  });

  test("finalizing → processing（前端轮询单调跳变）", () => {
    expect(toWireParseStatus("finalizing")).toBe("processing");
  });

  test("deleting/cancelled → failed", () => {
    expect(toWireParseStatus("deleting")).toBe("failed");
    expect(toWireParseStatus("cancelled")).toBe("failed");
  });

  test("unknown internal value fails closed", () => {
    expect(toWireParseStatus("garbage")).toBe("failed");
  });
});

describe("source manual↔text 双向映射（v1 §6.2）", () => {
  test("outgoing: manual → text", () => {
    expect(toWireSource("manual")).toBe("text");
    expect(toWireSource("file")).toBe("file");
    expect(toWireSource("url")).toBe("url");
  });

  test("incoming: text → manual", () => {
    expect(fromWireSource("text")).toBe("manual");
    expect(fromWireSource("file")).toBe("file");
    expect(fromWireSource("url")).toBe("url");
  });
});

describe("toWireKB（model.go KnowledgeBase 逐字段）", () => {
  const kb: KbRow = {
    id: "kb-1",
    tenantId: "tenant-a",
    name: "金融知识库",
    description: "政策与手册",
    chunkSize: 512,
    chunkOverlap: 80,
    rerankModel: null,
    createdAt: new Date("2026-10-11T08:00:00Z"),
    updatedAt: new Date("2026-10-11T09:00:00Z"),
  };

  test("fields snake_case, doc_count live, empty rerank_model omitted (Go omitempty)", () => {
    const wire = toWireKB(kb, 7);
    expect(wire).toEqual({
      id: "kb-1",
      tenant_id: "tenant-a",
      name: "金融知识库",
      description: "政策与手册",
      embedder: "",
      chunk_size: 512,
      chunk_overlap: 80,
      doc_count: 7,
      created_at: "2026-10-11T08:00:00.000Z",
      updated_at: "2026-10-11T09:00:00.000Z",
    });
    expect("rerank_model" in wire).toBe(false);
  });

  test("non-empty rerank_model included", () => {
    const wire = toWireKB({ ...kb, rerankModel: "bge-reranker" }, 0);
    expect(wire.rerank_model).toBe("bge-reranker");
  });
});

describe("toWireDocument（model.go Document 逐字段）", () => {
  const base: DocRow = {
    id: "doc-1",
    kbId: "kb-1",
    tenantId: "tenant-a",
    title: "风险手册",
    type: "manual",
    fileName: "",
    fileType: "",
    parseStatus: "finalizing",
    chunkCount: 12,
    metadata: { author: "qa" },
    progress: {
      chunksTotal: 12,
      chunksDone: 8,
      stage: "embed",
      updatedAt: "2026-10-11T09:00:00Z",
    },
    errorMessage: "",
    createdAt: new Date("2026-10-11T08:00:00Z"),
    updatedAt: new Date("2026-10-11T09:00:00Z"),
  };

  test("manual→text, finalizing→processing, metadata passthrough, empty fields omitted", () => {
    const wire = toWireDocument(base);
    expect(wire).toEqual({
      id: "doc-1",
      kb_id: "kb-1",
      tenant_id: "tenant-a",
      title: "风险手册",
      source: "text",
      parse_status: "processing",
      chunk_count: 12,
      metadata: { author: "qa" },
      created_at: "2026-10-11T08:00:00.000Z",
      updated_at: "2026-10-11T09:00:00.000Z",
    });
    expect("file_name" in wire).toBe(false);
    expect("file_type" in wire).toBe(false);
  });

  test("file doc keeps file_name/file_type", () => {
    const wire = toWireDocument({
      ...base,
      type: "file",
      fileName: "report.pdf",
      fileType: "pdf",
    });
    expect(wire.source).toBe("file");
    expect(wire.file_name).toBe("report.pdf");
    expect(wire.file_type).toBe("pdf");
  });
});

describe("toWireTask（model.go Task 逐字段）", () => {
  const doc: DocRow = {
    id: "doc-9",
    kbId: "kb-1",
    tenantId: "tenant-a",
    title: "t",
    type: "file",
    fileName: "",
    fileType: "",
    parseStatus: "processing",
    chunkCount: 0,
    metadata: null,
    progress: {
      chunksTotal: 20,
      chunksDone: 5,
      stage: "chunk",
      updatedAt: "x",
    },
    errorMessage: "",
    createdAt: new Date("2026-10-11T08:00:00Z"),
    updatedAt: new Date("2026-10-11T08:30:00Z"),
  };

  test("task_id=doc_id, progress percent from chunks ratio", () => {
    const wire = toWireTask(doc);
    expect(wire.task_id).toBe("doc-9");
    expect(wire.doc_id).toBe("doc-9");
    expect(wire.kb_id).toBe("kb-1");
    expect(wire.status).toBe("processing");
    expect(wire.progress).toBe(25); // 5/20
    expect(wire.chunks_done).toBe(5);
    expect(wire.chunks_total).toBe(20);
    expect("error" in wire).toBe(false);
  });

  test("failed task carries error message; completed without progress reports 100", () => {
    const failed = toWireTask({
      ...doc,
      parseStatus: "failed",
      errorMessage: "docreader timeout",
      progress: null,
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("docreader timeout");
    expect(failed.progress).toBe(0);

    const completed = toWireTask({
      ...doc,
      parseStatus: "completed",
      progress: null,
    });
    expect(completed.status).toBe("completed");
    expect(completed.progress).toBe(100);
  });
});

describe("validateCreateKbInput（kb-service createKBRequest 语义）", () => {
  test("empty/missing name rejected", () => {
    expect(validateCreateKbInput({})).toEqual({
      ok: false,
      message: "name is required",
    });
    expect(validateCreateKbInput({ name: "  " })).toEqual({
      ok: false,
      message: "name is required",
    });
  });

  test("defaults 512/80; non-positive chunk_size falls back", () => {
    const out = validateCreateKbInput({ name: "N" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.chunkSize).toBe(512);
      expect(out.value.chunkOverlap).toBe(80);
    }
    const zero = validateCreateKbInput({
      name: "N",
      chunk_size: 0,
      chunk_overlap: -5,
    });
    expect(zero.ok && zero.value.chunkSize).toBe(512);
    expect(zero.ok && zero.value.chunkOverlap).toBe(80);
  });

  test("explicit values kept; name trimmed", () => {
    const out = validateCreateKbInput({
      name: " N ",
      description: "D",
      chunk_size: 256,
      chunk_overlap: 40,
      rerank_model: "r",
    });
    expect(out.ok && out.value.name).toBe("N");
    expect(out.ok && out.value.chunkSize).toBe(256);
    expect(out.ok && out.value.rerankModel).toBe("r");
  });
});

describe("validateRetrieveInput", () => {
  test("missing/blank query rejected 400", () => {
    expect(validateRetrieveInput({})).toEqual({
      ok: false,
      message: "query is required",
    });
    expect(validateRetrieveInput({ query: "  " }).ok).toBe(false);
  });

  test("hybrid=true/false/absent all accepted (never 422)", () => {
    for (const hybrid of [true, false, undefined, "yes", 1]) {
      const out = validateRetrieveInput({ query: "q", hybrid });
      expect(out.ok).toBe(true);
    }
    const absent = validateRetrieveInput({ query: "q" });
    expect(absent.ok && absent.value.hybrid).toBe(true);
    const off = validateRetrieveInput({ query: "q", hybrid: false });
    expect(off.ok && off.value.hybrid).toBe(false);
  });

  test("defaults top_k 5, threshold 0; valid overrides kept", () => {
    const def = validateRetrieveInput({ query: "q" });
    expect(def.ok && def.value.topK).toBe(5);
    expect(def.ok && def.value.scoreThreshold).toBe(0);
    const custom = validateRetrieveInput({
      query: "q",
      top_k: 10,
      score_threshold: 0.3,
    });
    expect(custom.ok && custom.value.topK).toBe(10);
    expect(custom.ok && custom.value.scoreThreshold).toBe(0.3);
  });

  test("non-numeric top_k falls back to 5 (never 422)", () => {
    const out = validateRetrieveInput({ query: "q", top_k: "abc" });
    expect(out.ok && out.value.topK).toBe(5);
  });
});

describe("toIso", () => {
  test("ISO 8601 UTC with milliseconds (Go time.Time JSON shape)", () => {
    expect(toIso(new Date("2026-10-11T08:00:00Z"))).toBe(
      "2026-10-11T08:00:00.000Z",
    );
    expect(toIso("2026-10-11T08:00:00Z")).toBe("2026-10-11T08:00:00.000Z");
    expect(toIso(null)).toBe("1970-01-01T00:00:00.000Z");
    expect(toIso("not a date")).toBe("1970-01-01T00:00:00.000Z");
  });
});
