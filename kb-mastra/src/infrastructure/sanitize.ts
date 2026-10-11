/**
 * 解析结果清洗：WeKnora `internal/common/tools.go CleanInvalidUTF8` +
 * `internal/application/service/knowledge_process.go sanitizeReadResult` +
 * chunker `NormalizeLineEndings` 的直译。图片引用解包（UnwrapLinkedImages）
 * 与图片引用提取（ExtractImageRefs，splitter.go 尾部）一并收口在这里。
 */
import { normalizeLineEndings } from "./chunker/breadcrumbs";
import type { ImageRef } from "./chunker/splitter";

export { normalizeLineEndings };

/** ReadResult 的 TS 形状（docreader.proto ReadResponse 的领域投影）。 */
export type ReadResult = {
  markdownContent: string;
  imageDirPath: string;
  metadata: Record<string, string>;
  error: string;
  imageRefs: ReadImageRef[];
  sourceBlocks: SourceBlock[];
};

export type ReadImageRef = {
  filename: string;
  originalRef: string;
  mimeType: string;
  storageKey: string;
};

/** 原文位置块：markdown 内 code point 偏移（end-exclusive）+ 定位 JSON。 */
export type SourceBlock = {
  start: number;
  end: number;
  locatorJson: string;
};

/**
 * 移除非法 UTF-8 序列与 \x00。JS 字符串本身是 UTF-16；对应 Go 的
 * RuneError+size==1（非法字节跳过）与 r==0（NUL 跳过）语义：
 * 先剥 U+FFFD 替换符（非法字节的解码产物）与 U+0000。
 */
export function cleanInvalidUTF8(s: string): string {
  let out = "";
  for (const r of s) {
    const cp = r.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0xfffd) continue; // 非法 UTF-8 解码出的替换符
    if (cp === 0) continue; // NUL
    out += r;
  }
  return out;
}

/** 对 ReadResult 的全部字符串字段做 UTF-8 清洗（就地改写）。 */
export function sanitizeReadResult(result: ReadResult): void {
  result.markdownContent = cleanInvalidUTF8(result.markdownContent);
  result.imageDirPath = cleanInvalidUTF8(result.imageDirPath);
  result.error = cleanInvalidUTF8(result.error);
  for (const key of Object.keys(result.metadata)) {
    result.metadata[key] = cleanInvalidUTF8(result.metadata[key]);
  }
  for (const ref of result.imageRefs) {
    ref.filename = cleanInvalidUTF8(ref.filename);
    ref.originalRef = cleanInvalidUTF8(ref.originalRef);
    ref.mimeType = cleanInvalidUTF8(ref.mimeType);
    ref.storageKey = cleanInvalidUTF8(ref.storageKey);
  }
}

/** 嵌入用预处理：剥 base64 数据 URI、截 20000 字符（WeKnora sanitizeForEmbedding 对齐）。 */
const DATA_URI_PATTERN = /data:[^;]+;base64,[^\s)"']+/g;
export const EMBEDDING_MAX_CHARS = 20000;

export function sanitizeForEmbedding(content: string): string {
  const stripped = content.replace(DATA_URI_PATTERN, "");
  const chars = Array.from(stripped);
  if (chars.length <= EMBEDDING_MAX_CHARS) return stripped;
  return chars.slice(0, EMBEDDING_MAX_CHARS).join("");
}

/**
 * [![alt](img_url)](link_url) → ![alt](img_url)：解开外层链接包装，让下游
 * 图片正则只需处理扁平形态。URL 组支持一层平衡括号。
 * WeKnora docparser/image_resolver.go UnwrapLinkedImages 直译。
 */
const RE_LINKED_IMAGE = new RegExp(
  `\\[!\\[([^\\]]*)\\]\\(([^()\\s]*(?:\\([^)]*\\)[^()\\s]*)*)\\)\\]` + // [![alt](img_url)]
    `\\([^()\\s]*(?:\\([^)]*\\)[^()\\s]*)*\\)`, // (link_url) 捕获但丢弃
  "g",
);

export function unwrapLinkedImages(markdown: string): string {
  return markdown.replace(RE_LINKED_IMAGE, "![$1]($2)");
}

/** ![alt](url) 提取；URL 组支持一层平衡括号。先解包嵌套链接。 */
const IMAGE_REF_PATTERN = /!\[([^\]]*)\]\(([^()\s]*(?:\([^)]*\)[^()\s]*)*)\)/g;

export function extractImageRefs(text: string): ImageRef[] {
  const unwrapped = unwrapLinkedImages(text);
  const refs: ImageRef[] = [];
  for (const m of unwrapped.matchAll(IMAGE_REF_PATTERN)) {
    const whole = m[0];
    if (m.index === undefined) continue;
    refs.push({
      originalRef: m[2], // url
      altText: m[1], // alt
      start: m.index,
      end: m.index + whole.length,
    });
  }
  return refs;
}
