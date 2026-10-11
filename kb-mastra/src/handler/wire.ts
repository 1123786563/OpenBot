/**
 * wire 投影（v1 §6.2 逐字段对照）：
 * KnowledgeBase/KnowledgeDocument/KnowledgeTask/SearchResult 的出向形状与
 * Go kb-service 逐字段一致；ParseStatus 7→4 投影；source manual↔text 双向映射。
 */

/** 对外 4 态（OpenBot ParseStatus）。 */
export type WireParseStatus = "pending" | "processing" | "completed" | "failed";

/** 内部 7 态 → 对外 4 态（v1 §6.3 投影表）。 */
export function toWireParseStatus(internal: string): WireParseStatus {
  switch (internal) {
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
    default:
      return "failed";
  }
}

/** 对外 source：WeKnora manual → OpenBot text（出向）。 */
export function toWireSource(internalType: string): "file" | "url" | "text" {
  if (internalType === "file" || internalType === "url") return internalType;
  return "text"; // manual（及未知）投影为 text
}

/** 入向 source：OpenBot text → WeKnora manual。 */
export function fromWireSource(wire: "file" | "url" | "text"): "file" | "url" | "manual" {
  if (wire === "file" || wire === "url") return wire;
  return "manual";
}

/** ISO 8601 UTC（kb-service time.Time JSON 形态）。 */
export function toIso(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return new Date(0).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
