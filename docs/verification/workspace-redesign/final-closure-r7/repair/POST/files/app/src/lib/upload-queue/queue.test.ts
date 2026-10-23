import "../../../tests/preload";
import { type BatchEnd, createUploadQueue } from "@/lib/upload-queue/queue";
import type { UploadPayload } from "@/lib/upload-queue/state";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "../../../../tests/support/bun-test-compat";

/**
 * QA 补盲区：queue 编排层的集成级纯逻辑（mock 注入 uploadDocumentFile）。
 * 覆盖：并发上限、dedupKey 错峰、saving 禁取消、代数隔离（clear 后旧传输
 * 不得写新状态）、失败重试、batchEnd 事件流。
 *
 * uploadDocumentFile 经模块图注入 mock：queue.ts 顶层 import 了它，这里用
 * module.mock 替换，避免真实 XHR。
 */

type UploadCall = {
  kbId: string;
  name: string;
  onProgress: (ratio: number) => void;
  abort: () => void;
  resolve: (value: { task_id: string; doc_id: string }) => void;
  reject: (error: Error) => void;
};

let calls: UploadCall[] = [];

/**
 * mock.module 返回的注销句柄。Bun 1.4.2 的 mock.module 不返回句柄（实测为 undefined），
 * 此时 afterEach 里的注销按 no-op 处理，句柄一旦存在（未来 Bun 版本）即自动生效；
 * mock.restore() 只还原 spy，不还原 module mock，所以这里单独收口。
 */
let uninstallKnowledgeMock: unknown;

beforeEach(() => {
  calls = [];
  uninstallKnowledgeMock = mock.module("@/lib/knowledge", () => ({
    uploadDocumentFile: (
      kbId: string,
      file: File,
      options?: { onProgress?: (r: number) => void; signal?: AbortSignal },
    ) =>
      new Promise<{ task_id: string; doc_id: string }>((resolve, reject) => {
        const controller = new AbortController();
        const entry: UploadCall = {
          kbId,
          name: file.name,
          onProgress: options?.onProgress ?? (() => {}),
          abort: () => controller.abort(),
          resolve,
          reject,
        };
        calls.push(entry);
        options?.signal?.addEventListener("abort", () => {
          entry.reject(new DOMException("aborted", "AbortError"));
        });
      }),
  }));
});

afterEach(() => {
  // 每轮结束注销本轮安装的 module mock，不让它泄漏到同进程的后续文件。
  if (typeof uninstallKnowledgeMock === "function")
    (uninstallKnowledgeMock as () => void)();
  mock.restore();
});

function fileOf(name: string, size: number): UploadPayload {
  return { file: new File([new Uint8Array(size)], name) };
}

/** 事件收集器：seen 数组记录 onBatchEnd，queue 是产生它的队列实例。 */
function ends(): BatchEnd[] & { queue: ReturnType<typeof createUploadQueue> } {
  const seen: BatchEnd[] = [];
  const queue = createUploadQueue((end) => seen.push(end));
  return Object.assign(seen, { queue });
}

describe("upload queue orchestration", () => {
  test("bounded concurrency: 5 queued, only 3 in flight at once", () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [
      fileOf("a", 100),
      fileOf("b", 200),
      fileOf("c", 300),
      fileOf("d", 400),
      fileOf("e", 500),
    ]);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.name)).toEqual(["a", "b", "c"]);
    // 完成一个，下一个（d）被 pump 起来。
    calls[0]?.resolve({ task_id: "t", doc_id: "d" });
    // 让 onBatchEnd / pump 的微任务跑完。
    return Promise.resolve().then(() => {
      expect(
        queue.items.map((i) => i.transfer).filter((s) => s === "uploading")
          .length,
      ).toBe(3);
    });
  });

  test("dedupKey: same kb+size deferred, different size starts", () => {
    const seen = ends();
    seen.queue.enqueue("kb1", [
      fileOf("first", 100),
      fileOf("second", 100),
      fileOf("third", 300),
    ]);
    // first(100) 与 third(300) 启动；second(100) 与 first 同 key 让位。
    expect(calls.map((c) => c.name)).toEqual(["first", "third"]);
  });

  test("cancel mid-flight marks cancelled and frees the slot", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [
      fileOf("a", 100),
      fileOf("b", 200),
      fileOf("c", 300),
      fileOf("d", 400),
    ]);
    const [a] = calls;
    expect(a?.name).toBe("a");
    queue.cancel(queue.items.find((i) => i.name === "a")?.id ?? "");
    // 取消同步标记 cancelled；abort rejection 回落后 pump 才让 d 上场（微任务后）。
    const aItem = queue.items.find((i) => i.name === "a");
    expect(aItem?.transfer).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.map((c) => c.name)).toEqual(["a", "b", "c", "d"]);
    expect(queue.items.find((i) => i.name === "d")?.transfer).toBe("uploading");
  });

  test("saving phase (loaded=size) refuses cancel", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [fileOf("a", 100)]);
    await Promise.resolve();
    const a = calls[0];
    a?.onProgress(1); // 全部字节已发 → saving
    const aItem = queue.items.find((i) => i.name === "a");
    expect(aItem?.transfer).toBe("uploading");
    queue.cancel(aItem?.id ?? "");
    // saving 期取消被拒绝：状态不变、abort 不触发。
    const still = queue.items.find((i) => i.name === "a");
    expect(still?.transfer).toBe("uploading");
    // 服务端随后返回成功 → uploaded（取消没有丢掉这次传输）。
    a?.resolve({ task_id: "t", doc_id: "d" });
    await Promise.resolve();
    expect(queue.items.find((i) => i.name === "a")?.transfer).toBe("uploaded");
  });

  test("failure stores the server error; manual retry re-runs it", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [fileOf("a", 100)]);
    calls[0]?.reject(new Error("unprocessable: empty content"));
    await Promise.resolve();
    const failed = queue.items.find((i) => i.name === "a");
    expect(failed?.transfer).toBe("failed");
    expect(failed?.error).toBe("unprocessable: empty content");
    expect(calls.length).toBe(1);
    // 手动重试：同一 payload 再跑一次。
    queue.retry(failed?.id ?? "");
    expect(calls.length).toBe(2);
    expect(queue.items.find((i) => i.name === "a")?.transfer).toBe("uploading");
  });

  test("abort rejection (user cancel) does not surface as failed", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [fileOf("a", 100)]);
    const id = queue.items.find((i) => i.name === "a")?.id ?? "";
    queue.cancel(id);
    // cancel() 里 controller.abort() → mock reject AbortError → transfer 收尾。
    await Promise.resolve();
    await Promise.resolve();
    const item = queue.items.find((i) => i.name === "a");
    expect(item?.transfer).toBe("cancelled");
    expect(item?.error).toBeUndefined();
  });

  test("clear() isolates generations: a saving-phase transfer finishing late reports uploaded without resurrecting items", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [fileOf("a", 100)]);
    const a = calls[0];
    a?.onProgress(1); // body 全部发出 → saving：clear() 不 abort 这一条。
    queue.clear();
    expect(queue.items.length).toBe(0);
    // saving 传输在 clear 之后正常返回成功：条目不复活（代数隔离），
    // 但 onBatchEnd 上报 uploaded（服务端确实落了行，列表需要刷新）。
    a?.resolve({ task_id: "t", doc_id: "d" });
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.items.length).toBe(0);
    const uploadEvents = seen.filter((e) => e.uploaded);
    expect(uploadEvents.length).toBe(1);
    expect(uploadEvents[0]?.kbId).toBe("kb1");
  });

  test("clear() aborts an in-flight (non-saving) transfer and settles its kb without upload event", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [fileOf("a", 100)]);
    queue.clear();
    expect(queue.items.length).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    // 被 abort 的传输：无 uploaded 事件；busy kb 收到 settled（uploaded:false）。
    expect(seen.filter((e) => e.uploaded).length).toBe(0);
    expect([...seen]).toEqual([
      { kbId: "kb1", uploaded: false, settled: true },
    ]);
  });

  test("batchEnd fires with settled=true when the kb goes idle", async () => {
    const seen = ends();
    const { queue } = seen;
    queue.enqueue("kb1", [fileOf("a", 100), fileOf("b", 200)]);
    calls[0]?.resolve({ task_id: "t1", doc_id: "d1" });
    await Promise.resolve();
    await Promise.resolve();
    // a 完成：b 仍在传 → settled=false 的事件。
    expect(seen.some((e) => e.uploaded && !e.settled)).toBe(true);
    calls[1]?.resolve({ task_id: "t2", doc_id: "d2" });
    await Promise.resolve();
    await Promise.resolve();
    // 全部结束 → settled=true。
    const final = seen.filter((e) => e.settled);
    expect(final.length).toBeGreaterThanOrEqual(1);
    expect(final.every((e) => e.kbId === "kb1")).toBe(true);
  });

  test("enqueue with empty list or empty kbId is a no-op", () => {
    const seen = ends();
    seen.queue.enqueue("", [fileOf("a", 1)]);
    seen.queue.enqueue("kb1", []);
    expect(calls.length).toBe(0);
    expect(seen.queue.items.length).toBe(0);
  });
});
