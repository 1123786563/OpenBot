#!/usr/bin/env bun
/**
 * T05 冒烟全序列（v1 §9 1-4 + 越权 + PDF 全链）。
 * 前置：postgres/qdrant/redis/docreader(+mock-ollama) 已起，kb-mastra :8082 已起。
 * 用法：bun scripts/kb/t05-smoke.ts
 */

const B = process.env.KB_URL ?? "http://127.0.0.1:8082";
const ADMIN = { authorization: "Bearer sk-t05-admin" };
const READER = { authorization: "Bearer sk-t05-read" };
const OTHER = { authorization: "Bearer sk-t05-other" };

/** One JSON answer, always read defensively (`?.` + fallback) in this script. */
type JsonValue = null | boolean | number | string | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue };

let pass = 0;
let fail = 0;

function check(name: string, expected: string, actual: string): void {
  if (expected === actual) {
    console.log(`PASS ${name} (${actual})`);
    pass += 1;
  } else {
    console.log(`FAIL ${name}: expected ${expected} got ${actual}`);
    fail += 1;
  }
}

async function json(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: JsonRecord | null }> {
  const response = await fetch(`${B}${path}`, {
    method,
    headers:
      body !== undefined
        ? { ...headers, "content-type": "application/json" }
        : headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? null : (JSON.parse(text) as JsonRecord),
  };
}

async function main() {
  // 1. 建库（admin）
  const created = await json("POST", "/kb", ADMIN, {
    name: `t05-${Date.now().toString(36)}`,
    description: "e2e smoke",
    chunk_size: 64,
    chunk_overlap: 8,
  });
  const kbId: string = String(created.json?.id ?? "");
  check("create-kb", "200", String(created.status));
  check("create-kb id len", "36", String(kbId.length));
  console.log("  kb:", JSON.stringify(created.json).slice(0, 140));

  // 2. 上传 text 文档
  const paragraphs = Array.from(
    { length: 8 },
    (_, i) => `第${i + 1}段：OpenBot 知识库迁移冒烟测试内容填充。`,
  ).join("\n\n");
  const added = await json("POST", `/kb/${kbId}/documents`, ADMIN, {
    type: "text",
    title: "t05 text doc",
    content: paragraphs,
  });
  const docId: string = String(added.json?.doc_id ?? "");
  check("upload-text", "202", String(added.status));
  console.log("  add:", JSON.stringify(added.json));

  // 3. 轮询 task 至 completed
  let status = "";
  for (let i = 0; i < 30; i += 1) {
    const task = await json("GET", `/kb/${kbId}/tasks/${docId}`, ADMIN);
    status = String(task.json?.status ?? "");
    if (status === "completed" || status === "failed") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check("task completed", "completed", status);
  const taskFinal = await json("GET", `/kb/${kbId}/tasks/${docId}`, ADMIN);
  console.log(
    "  task:",
    JSON.stringify({
      status: taskFinal.json?.status,
      progress: taskFinal.json?.progress,
      chunks: `${taskFinal.json?.chunks_done}/${taskFinal.json?.chunks_total}`,
    }),
  );

  // 4. 检索命中
  const retrieved = await json("POST", `/kb/${kbId}/retrieve`, ADMIN, {
    query: "知识库迁移冒烟",
    top_k: 5,
    hybrid: true,
  });
  check("retrieve-hits", "200", String(retrieved.status));
  check(
    "retrieve count>0",
    "true",
    String(Number(retrieved.json?.count ?? 0) > 0),
  );
  console.log(
    "  hit:",
    JSON.stringify(
      (retrieved.json as { results?: unknown[] })?.results?.[0] ?? {},
    ).slice(0, 160),
  );

  // 5. 删除文档 → 检索空 → task 404
  const deleted = await json("DELETE", `/kb/${kbId}/documents/${docId}`, ADMIN);
  check("delete-doc", "200", String(deleted.status));
  const after = await json("POST", `/kb/${kbId}/retrieve`, ADMIN, {
    query: "知识库迁移冒烟",
    top_k: 5,
  });
  check("retrieve-after-delete", "0", String(after.json?.count ?? -1));
  const taskAfter = await fetch(`${B}/kb/${kbId}/tasks/${docId}`, {
    headers: ADMIN,
  });
  check("task-after-delete 404", "404", String(taskAfter.status));

  // 6. PDF 全链（docreader builtin）
  const pdfBytes = minimalPdf();
  const form = new FormData();
  form.append(
    "file",
    new File([pdfBytes], "t05-smoke.pdf", { type: "application/pdf" }),
  );
  form.append("title", "t05 pdf doc");
  const pdfUpload = await fetch(`${B}/kb/${kbId}/documents`, {
    method: "POST",
    headers: ADMIN,
    body: form,
  });
  const pdfJson = await pdfUpload.json().catch(() => ({}));
  const pdfId: string = pdfJson?.doc_id ?? "";
  check("pdf-upload", "202", String(pdfUpload.status));
  console.log("  pdf add:", JSON.stringify(pdfJson));
  let pdfStatus = "";
  for (let i = 0; i < 90; i += 1) {
    const task = await json("GET", `/kb/${kbId}/tasks/${pdfId}`, ADMIN);
    pdfStatus = String(task.json?.status ?? "");
    if (pdfStatus === "completed" || pdfStatus === "failed") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  check("pdf completed", "completed", pdfStatus);
  const pdfTask = await json("GET", `/kb/${kbId}/tasks/${pdfId}`, ADMIN);
  console.log(
    "  pdf task:",
    JSON.stringify({
      status: pdfTask.json?.status,
      chunks: `${pdfTask.json?.chunks_done}/${pdfTask.json?.chunks_total}`,
    }),
  );
  if (pdfStatus === "completed") {
    const pdfRetrieve = await json("POST", `/kb/${kbId}/retrieve`, ADMIN, {
      query: "OpenBot kb-mastra PDF smoke",
      top_k: 5,
    });
    check(
      "pdf retrieve-hits",
      "true",
      String(Number(pdfRetrieve.json?.count ?? 0) > 0),
    );
  }

  // 7. 越权：tenant-b → 404
  const cross = await fetch(`${B}/kb/${kbId}`, { headers: OTHER });
  check("cross-tenant 404", "404", String(cross.status));

  // 8. read 角色建库 → 403
  const forbidden = await json("POST", "/kb", READER, { name: "nope" });
  check("read-role 403", "403", String(forbidden.status));

  // 9. 删库 → 404
  const dekb = await json("DELETE", `/kb/${kbId}`, ADMIN);
  check("delete-kb", "200", String(dekb.status));
  const kbGone = await fetch(`${B}/kb/${kbId}`, { headers: ADMIN });
  check("kb-after-delete 404", "404", String(kbGone.status));

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  console.log(fail === 0 ? "SMOKE PASS" : "SMOKE FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

/** 最小合法 PDF（1 页一行文本，docreader builtin 可解析）。 */
function minimalPdf(): Uint8Array<ArrayBuffer> {
  const content = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 58>>stream
BT /F1 24 Tf 72 700 Td (OpenBot kb-mastra PDF smoke) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`;
  return new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
}

main().catch((error) => {
  console.error("smoke crashed:", (error as Error).message);
  process.exit(1);
});

export {};
