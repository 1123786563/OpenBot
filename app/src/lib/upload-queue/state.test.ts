import "../../../tests/preload";
import { describe, expect, test } from "../../../../tests/support/e2e-compat";
import {
  canCancel,
  canRetry,
  type ItemPhase,
  itemPhase,
  pickNextToStart,
  summarizeItems,
  type UploadItem,
} from "@/lib/upload-queue/state";

/**
 * QA 补盲区：upload-queue 纯状态规则的矩阵覆盖。
 * 语义对照 WeKnora uploadTasksState.ts（OpenBot 裁剪掉 duplicate/finalizing
 * 与解析轮询——上游不存在这些态），按 OpenBot 实现语义断言。
 */

function item(overrides: Partial<UploadItem>): UploadItem {
  return {
    id: "u1",
    batchId: "u1",
    kbId: "kb1",
    name: "f.txt",
    size: 100,
    loaded: 0,
    transfer: "queued",
    ...overrides,
  };
}

describe("itemPhase", () => {
  test("queued → waiting; terminal states map through directly", () => {
    expect(itemPhase(item({ transfer: "queued" }))).toBe<ItemPhase>("waiting");
    expect(itemPhase(item({ transfer: "uploaded" }))).toBe("uploaded");
    expect(itemPhase(item({ transfer: "failed" }))).toBe("failed");
    expect(itemPhase(item({ transfer: "cancelled" }))).toBe("cancelled");
  });

  test("uploading folds into uploading or saving by loaded vs size", () => {
    expect(itemPhase(item({ transfer: "uploading", loaded: 0 }))).toBe(
      "uploading",
    );
    expect(
      itemPhase(item({ transfer: "uploading", loaded: 99, size: 100 })),
    ).toBe("uploading");
    // 全部字节已发出 → saving（等待服务端落盘，取消已无意义）。
    expect(
      itemPhase(item({ transfer: "uploading", loaded: 100, size: 100 })),
    ).toBe("saving");
    expect(
      itemPhase(item({ transfer: "uploading", loaded: 120, size: 100 })),
    ).toBe("saving");
    // size=0 的文件：不可区分进度，按 uploading 展示（除零防护）。
    expect(itemPhase(item({ transfer: "uploading", size: 0, loaded: 0 }))).toBe(
      "uploading",
    );
  });
});

describe("canCancel / canRetry matrix", () => {
  test("cancel only in queued or uploading phase (not saving)", () => {
    expect(canCancel(item({ transfer: "queued" }))).toBe(true);
    expect(canCancel(item({ transfer: "uploading", loaded: 10 }))).toBe(true);
    // saving：body 已发完，服务端无论如何都会写盘，取消只会藏行。
    expect(canCancel(item({ transfer: "uploading", loaded: 100 }))).toBe(false);
    expect(canCancel(item({ transfer: "uploaded" }))).toBe(false);
    expect(canCancel(item({ transfer: "failed" }))).toBe(false);
    expect(canCancel(item({ transfer: "cancelled" }))).toBe(false);
  });

  test("retry only failed/cancelled with payload retained", () => {
    expect(canRetry(item({ transfer: "failed" }), true)).toBe(true);
    expect(canRetry(item({ transfer: "cancelled" }), true)).toBe(true);
    // payload 已随成功上传释放（或 clear 清空）→ 不可重试。
    expect(canRetry(item({ transfer: "failed" }), false)).toBe(false);
    expect(canRetry(item({ transfer: "queued" }), true)).toBe(false);
    expect(canRetry(item({ transfer: "uploading" }), true)).toBe(false);
    expect(canRetry(item({ transfer: "uploaded" }), true)).toBe(false);
  });
});

describe("pickNextToStart", () => {
  const key = (i: UploadItem) => `${i.kbId}:${i.size}`;

  test("respects the concurrency cap", () => {
    const items = [
      item({ id: "a", transfer: "queued", size: 100 }),
      item({ id: "b", transfer: "queued", size: 200 }),
      item({ id: "c", transfer: "queued", size: 300 }),
      item({ id: "d", transfer: "queued", size: 400 }),
      item({ id: "e", transfer: "queued", size: 500 }),
    ];
    expect(pickNextToStart(items, 3, key).map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("counts in-flight transfers toward the cap", () => {
    const items = [
      item({ id: "run1", transfer: "uploading", kbId: "kb1", size: 1 }),
      item({ id: "run2", transfer: "uploading", kbId: "kb2", size: 1 }),
      item({ id: "run3", transfer: "uploading", kbId: "kb3", size: 1 }),
      item({ id: "q1", transfer: "queued", kbId: "kb4", size: 1 }),
      item({ id: "q2", transfer: "queued", kbId: "kb5", size: 1 }),
    ];
    // 已有 3 个在传 → 满员，不再启动。
    expect(pickNextToStart(items, 3, key)).toEqual([]);
    // 并发 4 → 只补 1 个。
    expect(pickNextToStart(items, 4, key).map((i) => i.id)).toEqual(["q1"]);
  });

  test("same conflict key as an in-flight item defers to a later item", () => {
    const items = [
      // kb1:100 在传。
      item({ id: "run", transfer: "uploading", kbId: "kb1", size: 100 }),
      // 排队的同 key（kb1:100）让位……
      item({ id: "same", transfer: "queued", kbId: "kb1", size: 100 }),
      // ……后面的不同 key（kb1:200）拿到空位。
      item({ id: "other", transfer: "queued", kbId: "kb1", size: 200 }),
    ];
    expect(pickNextToStart(items, 3, key).map((i) => i.id)).toEqual(["other"]);
  });

  test("two queued items sharing a conflict key do not both start", () => {
    const items = [
      item({ id: "q1", transfer: "queued", kbId: "kb1", size: 100 }),
      item({ id: "q2", transfer: "queued", kbId: "kb1", size: 100 }),
      item({ id: "q3", transfer: "queued", kbId: "kb1", size: 300 }),
    ];
    expect(pickNextToStart(items, 3, key).map((i) => i.id)).toEqual([
      "q1",
      "q3",
    ]);
  });

  test("skips settled items entirely", () => {
    const items = [
      item({ id: "done", transfer: "uploaded" }),
      item({ id: "err", transfer: "failed" }),
      item({ id: "cx", transfer: "cancelled" }),
      item({ id: "q", transfer: "queued" }),
    ];
    expect(pickNextToStart(items, 3, key).map((i) => i.id)).toEqual(["q"]);
  });
});

describe("summarizeItems", () => {
  test("counts each phase, saving folded into uploading, retryable = failed+cancelled", () => {
    const summary = summarizeItems([
      item({ id: "1", transfer: "queued" }),
      item({ id: "2", transfer: "uploading", loaded: 10 }),
      item({ id: "3", transfer: "uploading", loaded: 100 }),
      item({ id: "4", transfer: "uploaded" }),
      item({ id: "5", transfer: "failed" }),
      item({ id: "6", transfer: "cancelled" }),
    ]);
    expect(summary.total).toBe(6);
    expect(summary.waiting).toBe(1);
    expect(summary.uploading).toBe(2); // 含 saving
    expect(summary.uploaded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.cancelled).toBe(1);
    expect(summary.retryable).toBe(2);
  });

  test("empty input summarises to zeros", () => {
    expect(summarizeItems([])).toEqual({
      total: 0,
      waiting: 0,
      uploading: 0,
      uploaded: 0,
      failed: 0,
      cancelled: 0,
      retryable: 0,
    });
  });
});
