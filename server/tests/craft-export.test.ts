import { describe, expect, test } from "bun:test";
import { exportDocx, exportPptx } from "../src/craft/export";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function hasBytes(buf: Uint8Array, needle: string): boolean {
  const bytes = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= buf.length - bytes.length; i++) {
    for (let j = 0; j < bytes.length; j++) {
      if (buf[i + j] !== bytes[j]) continue outer;
    }
    return true;
  }
  return false;
}

const MARKDOWN = [
  "# Quarterly Report",
  "",
  "A summary of **sales** and _trends_.",
  "",
  "## Region A",
  "",
  "- First item",
  "- Second item with `code`",
  "",
  "1. Ordered one",
  "2. Ordered two",
  "",
  "| Name | Q1 | Q2 |",
  "| --- | --- | --- |",
  "| North | 10 | 12 |",
  "| South | 8 | 9 |",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "> A blockquote.",
  "",
  "---",
].join("\n");

describe("exportDocx", () => {
  test("produces a zip whose document part is present", async () => {
    const buf = await exportDocx(MARKDOWN);
    expect(buf.length).toBeGreaterThan(0);
    expect([...buf.slice(0, 4)]).toEqual(ZIP_MAGIC);
    expect(hasBytes(buf, "word/document.xml")).toBe(true);
  });

  test("empty markdown still yields a valid docx", async () => {
    const buf = await exportDocx("");
    expect([...buf.slice(0, 4)]).toEqual(ZIP_MAGIC);
    expect(hasBytes(buf, "word/document.xml")).toBe(true);
  });
});

describe("exportPptx", () => {
  test("produces a zip whose presentation part is present", async () => {
    const buf = await exportPptx(MARKDOWN);
    expect(buf.length).toBeGreaterThan(0);
    expect([...buf.slice(0, 4)]).toEqual(ZIP_MAGIC);
    expect(hasBytes(buf, "ppt/presentation.xml")).toBe(true);
  });
});
