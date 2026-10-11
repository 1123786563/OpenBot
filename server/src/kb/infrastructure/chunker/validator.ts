/**
 * 层级输出校验：WeKnora chunker/validator.go 直译。
 * 判定某层 splitter 的输出是否可用（不可用则策略链落到下一层）。
 * 故意宽松：只拒「明显坏」的输出，合理的外观变化放行，避免层间震荡。
 */
import { type Chunk, runeLen } from "./splitter";

export type ValidationResult = { ok: boolean; reason: string };

export function validateChunks(
  chunks: Chunk[],
  totalChars: number,
  chunkSize: number,
): ValidationResult {
  if (chunks.length === 0) return { ok: false, reason: "no chunks produced" };

  // 大文档只出一个 chunk = 策略没真正切分，让下一层跑。
  if (chunks.length === 1 && totalChars > 2 * chunkSize) {
    return { ok: false, reason: "single chunk for large document" };
  }

  let maxLen = 0;
  let minLen = Number.MAX_SAFE_INTEGER;
  for (const c of chunks) {
    const l = runeLen(c.content);
    if (l > maxLen) maxLen = l;
    if (l < minLen) minLen = l;
  }

  // 除最后一个 chunk 外都应有实质内容；尾 chunk 小是正常残余。
  let tinyCount = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (i === chunks.length - 1) continue;
    if (runeLen(chunks[i].content) < 50) tinyCount += 1;
  }
  if (tinyCount > chunks.length / 4 && tinyCount > 2) {
    return { ok: false, reason: "too many tiny chunks" };
  }

  // 没有 chunk 达到目标 25% = 切得过碎。
  if (maxLen < chunkSize / 4 && totalChars > chunkSize) {
    return { ok: false, reason: "all chunks far below target size" };
  }

  // 超 2 倍目标 = splitter 无视了尺寸预算。
  if (maxLen > 2 * chunkSize && chunkSize > 0) {
    return { ok: false, reason: "chunk exceeds 2x target size" };
  }

  return { ok: true, reason: "" };
}
