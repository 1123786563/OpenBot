/**
 * simple 解析引擎：md/txt/csv/json 的本地直读。WeKnora 本地解析路径的直译——
 * 文件字节按 UTF-8 解码为 markdown 内容，无图片、无 source blocks。
 * 纯函数 + 注入式解码，测试无需真实 fs。
 */
import type { ReadResult } from "../sanitize";
import { type Parser, SIMPLE_EXTENSIONS } from "./registry";

export type TextDecoderLike = (bytes: Uint8Array) => string;

/** 默认按 UTF-8 解码（致命模式：非法序列折成替换符，后续 sanitize 会剥除）。 */
const defaultDecode: TextDecoderLike = (bytes) =>
  new TextDecoder("utf-8").decode(bytes);

export function simpleParser(decode: TextDecoderLike = defaultDecode): Parser {
  return {
    name: "simple",
    extensions: SIMPLE_EXTENSIONS,
    async parseFile({ fileContent, fileName }) {
      const text = decode(fileContent);
      const result: ReadResult = {
        markdownContent: text,
        imageDirPath: "",
        metadata: { file_name: fileName },
        error: "",
        imageRefs: [],
        sourceBlocks: text
          ? [
              {
                start: 0,
                end: codePointLength(text),
                locatorJson: JSON.stringify({ type: "text" }),
              },
            ]
          : [],
      };
      return result;
    },
    async parseURL() {
      // simple 引擎不处理 URL（URL 摄取在 service 层先下载再按类型路由）。
      throw new Error("simple parser does not handle URLs");
    },
  };
}

function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}
