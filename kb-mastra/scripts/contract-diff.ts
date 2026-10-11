/**
 * 契约 diff（v1 T04 验收项，T05 落地）：同输入序列打 Go kb-service(:8081)
 * 与 kb-mastra(:8082)，逐端点比较响应 JSON 的**结构**（字段名集合 + 类型形状），
 * 值不比（id/时间戳/mock 向量分天然不同）。
 *
 * 输出：每端点一行 PASS/DIFF + 差异字段清单；退出码 = DIFF 端点数。
 *
 * 用法：bun scripts/contract-diff.ts [goUrl] [mastraUrl]
 */

type Shape = string;

/** JSON 值 → 结构签名（字段名排序 + 类型标记；数组取首元素形状）。 */
function shapeOf(value: unknown, depth = 0): Shape {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${shapeOf(value[0], depth + 1)}]`;
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object": {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const fields = keys.map(
        (key) =>
          `${key}:${shapeOf((value as Record<string, unknown>)[key], depth + 1)}`,
      );
      return `{${fields.join(",")}}`;
    }
    default:
      return typeof value;
  }
}

/** 提取动态字段（id 类）为通配，让两次调用的结构可比。 */
function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      if (
        typeof val === "string" &&
        /^(req-|kb-|doc-)/.test(val)
      ) {
        return "<id>";
      }
      return val;
    }),
  );
}

const GO_URL = process.argv[2] ?? "http://127.0.0.1:8081";
const MA_URL = process.argv[3] ?? "http://127.0.0.1:8082";
const AUTH = { authorization: "Bearer sk-t05-admin" };
const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

let diffs = 0;

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  form?: FormData,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: form ? { ...AUTH } : body !== undefined ? JSON_HEADERS : AUTH,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(form !== undefined ? { body: form } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text === "" ? null : JSON.parse(text),
  };
}

/** 比较一个端点：同请求打两边，比较 status 与 body 结构。 */
async function compare(
  name: string,
  run: (base: string) => Promise<{ status: number; json: unknown }>,
): Promise<void> {
  const goResult = await run(GO_URL);
  const maResult = await run(MA_URL);
  const goShape = shapeOf(normalize(goResult.json));
  const maShape = shapeOf(normalize(maResult.json));
  const statusOk = goResult.status === maResult.status;
  const shapeOk = goShape === maShape;
  if (statusOk && shapeOk) {
    console.log(`PASS ${name} (${goResult.status}) ${goShape.slice(0, 90)}`);
    return;
  }
  diffs += 1;
  console.log(`DIFF ${name}`);
  console.log(`  go  (${goResult.status}): ${goShape}`);
  console.log(`  kbm (${maResult.status}): ${maShape}`);
}

async function main() {
  // 序列：建库 → 上传 text → 列表 → 详情 → 文档详情 → task → retrieve → 删文档 → 删库。
  // 每端点各自独立建一次库（两边同输入），docId 分别记录走完整链。

  // 1. POST /kb
  await compare("POST /kb", (base) =>
    call(base, "POST", "/kb", {
      name: `diff-${Math.random().toString(36).slice(2, 8)}`,
      description: "contract diff",
    }),
  );

  // 2. GET /kb（列表）
  await compare("GET /kb", (base) => call(base, "GET", "/kb"));

  // 完整链（建库→上传→轮询→各查询→删除）：
  const goKb = await call(GO_URL, "POST", "/kb", {
    name: `chain-go-${Math.random().toString(36).slice(2, 8)}`,
  });
  const maKb = await call(MA_URL, "POST", "/kb", {
    name: `chain-ma-${Math.random().toString(36).slice(2, 8)}`,
  });
  const goKbId = (goKb.json as { id: string }).id;
  const maKbId = (maKb.json as { id: string }).id;

  // 3. POST /kb/:id/documents（text）
  await compare("POST documents (text)", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    return call(base, "POST", `/kb/${kbId}/documents`, {
      type: "text",
      title: "diff doc",
      content: "契约对比文档内容。第二段落，用于切分。",
    });
  });

  // 各自上传拿 docId
  const goAdd = await call(GO_URL, "POST", `/kb/${goKbId}/documents`, {
    type: "text",
    title: "diff doc go",
    content: "契约对比文档内容。第二段落，用于切分。",
  });
  const maAdd = await call(MA_URL, "POST", `/kb/${maKbId}/documents`, {
    type: "text",
    title: "diff doc ma",
    content: "契约对比文档内容。第二段落，用于切分。",
  });
  const goDoc = (goAdd.json as { doc_id: string }).doc_id;
  const maDoc = (maAdd.json as { doc_id: string }).doc_id;

  // 4. GET /kb/:id（详情）
  await compare("GET /kb/:id", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    return call(base, "GET", `/kb/${kbId}`);
  });

  // 5. GET /kb/:id/documents（列表）
  await compare("GET documents list", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    return call(base, "GET", `/kb/${kbId}/documents`);
  });

  // 6. GET /kb/:id/documents/:docId（详情）
  await compare("GET document detail", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    const docId = base === GO_URL ? goDoc : maDoc;
    return call(base, "GET", `/kb/${kbId}/documents/${docId}`);
  });

  // 7. GET /kb/:id/tasks/:taskId
  await compare("GET task", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    const docId = base === GO_URL ? goDoc : maDoc;
    return call(base, "GET", `/kb/${kbId}/tasks/${docId}`);
  });

  // 8. POST /kb/:id/retrieve
  await compare("POST retrieve", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    return call(base, "POST", `/kb/${kbId}/retrieve`, {
      query: "契约对比",
      top_k: 5,
      hybrid: true,
    });
  });

  // 9. 越权语义：错误 key → 401
  await compare("unauthorized 401", async (base) => {
    const response = await fetch(`${base}/kb`, { headers: { authorization: "Bearer wrong" } });
    return { status: response.status, json: await response.json().catch(() => null) };
  });

  // 10. DELETE 文档
  await compare("DELETE document", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    const docId = base === GO_URL ? goDoc : maDoc;
    return call(base, "DELETE", `/kb/${kbId}/documents/${docId}`);
  });

  // 11. DELETE KB
  await compare("DELETE /kb/:id", (base) => {
    const kbId = base === GO_URL ? goKbId : maKbId;
    return call(base, "DELETE", `/kb/${kbId}`);
  });

  console.log(
    diffs === 0
      ? "\nCONTRACT DIFF: all endpoints structurally identical"
      : `\nCONTRACT DIFF: ${diffs} endpoints differ`,
  );
  process.exit(diffs);
}

main().catch((error) => {
  console.error("contract-diff crashed:", (error as Error).message);
  process.exit(1);
});
