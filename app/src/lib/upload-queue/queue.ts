/**
 * 有界并发上传队列，WeKnora `stores/uploadQueue.ts` 的直译并按 OpenBot 裁剪：
 * 有界并发（默认 3）、dedupKey=`kbId:fileSize` 错峰、AbortController 取消
 * （saving 阶段禁取消：服务端已在写盘）、失败手动重试。解析进度不在队列内——
 * OpenBot 上游的 task 级进度由 React Query 的 taskQueryOptions 承载，队列只
 * 负责把文件送到服务端。
 *
 * axios→XHR 适配点：`upload` 直接用 `lib/knowledge.ts` 的 XHR 版
 * uploadDocumentFile（onProgress + signal），队列本身不接触网络实现。
 * WeKnora 的批次（batch）对象在这里退化为条目上的 kbId——上游没有文件夹/
 * 标签维度，批次除了目标库之外不再携带任何信息。
 */

import { uploadDocumentFile } from "@/lib/knowledge";
import {
  canCancel,
  canRetry,
  itemPhase,
  pickNextToStart,
  type UploadItem,
  type UploadPayload,
} from "./state";

/** 并发传输数：小并发既填满管道又不把服务端的哈希/落盘压垮。 */
const CONCURRENCY = 3;

let idSeq = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

/** 一次批次结束事件：uploaded=确有文件落库（列表要刷新），settled=该库再无任务。 */
export interface BatchEnd {
  kbId: string;
  uploaded: boolean;
  settled: boolean;
}

export type UploadQueue = ReturnType<typeof createUploadQueue>;

export function createUploadQueue(onBatchEnd: (end: BatchEnd) => void) {
  const items: UploadItem[] = [];
  // File payload 与 AbortController 不进 items：面板永不渲染它们，外部 store
  // 的快照也不该碰到 File。
  const payloads = new Map<string, UploadPayload>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<() => void>();
  // clear() 递增代数：清空前发起的传输回来后不得再写新世界的状态。
  let generation = 0;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const isBusy = (kbId: string) =>
    items.some(
      (item) =>
        (item.transfer === "queued" || item.transfer === "uploading") &&
        item.kbId === kbId,
    );

  // 同库同大小不同时在传：给服务端内容去重（只见已写盘的行）留窗口。
  const dedupKey = (item: UploadItem) => `${item.kbId}:${item.size}`;

  const pump = () => {
    let dirty = false;
    for (const item of pickNextToStart(items, CONCURRENCY, dedupKey)) {
      void transfer(item);
      dirty = true;
    }
    if (dirty) notify();
  };

  const transfer = async (item: UploadItem) => {
    const payload = payloads.get(item.id);
    if (!payload) {
      item.transfer = "failed";
      notify();
      return;
    }
    const startedIn = generation;
    const controller = new AbortController();
    controllers.set(item.id, controller);
    item.transfer = "uploading";
    item.loaded = 0;
    item.error = undefined;
    notify();

    let uploaded = false;
    let failure: string | undefined;
    try {
      await uploadDocumentFile(item.kbId, payload.file, {
        onProgress: (ratio) => {
          if (item.transfer === "uploading") {
            item.loaded = Math.min(item.size, Math.round(ratio * item.size));
            notify();
          }
        },
        signal: controller.signal,
      });
      uploaded = true;
    } catch (error) {
      // 取消产生的 AbortError 不展示：用户自己按的取消。真实失败带服务端信息。
      failure = error instanceof Error ? error.message : String(error);
    }
    // 同 id 的重试会开新一次尝试；只有最新尝试有权写条目终态。
    const latestAttempt = controllers.get(item.id) === controller;
    if (latestAttempt) controllers.delete(item.id);
    const aborted = controller.signal.aborted;

    // 清空后落地的文件仍是服务端的新行。
    if (startedIn !== generation) {
      if (!aborted && uploaded)
        onBatchEnd({
          kbId: item.kbId,
          uploaded: true,
          settled: !isBusy(item.kbId),
        });
      return;
    }
    if (!latestAttempt) return;

    if (aborted) {
      if (item.transfer === "uploading") {
        item.transfer = "cancelled";
        item.loaded = 0;
      }
    } else if (uploaded) {
      item.transfer = "uploaded";
      item.loaded = item.size;
      payloads.delete(item.id);
    } else {
      item.transfer = "failed";
      item.error = failure;
    }
    notify();
    onBatchEnd({
      kbId: item.kbId,
      uploaded: item.transfer === "uploaded",
      settled: !isBusy(item.kbId),
    });
    pump();
  };

  const enqueue = (kbId: string, uploads: UploadPayload[]) => {
    if (!kbId || uploads.length === 0) return;
    for (const upload of uploads) {
      const id = nextId("upload");
      payloads.set(id, upload);
      items.push({
        id,
        batchId: id,
        kbId,
        name: upload.file.name,
        size: upload.file.size,
        loaded: 0,
        transfer: "queued",
      });
    }
    pump();
    notify();
  };

  const cancel = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (!item || !canCancel(item)) return;
    item.transfer = "cancelled";
    item.loaded = 0;
    const controller = controllers.get(id);
    if (controller) {
      // transfer 回调负责收尾与 onBatchEnd。
      controller.abort();
      notify();
      return;
    }
    notify();
    if (!isBusy(item.kbId))
      onBatchEnd({ kbId: item.kbId, uploaded: false, settled: true });
  };

  const cancelAll = () => {
    for (const item of [...items]) cancel(item.id);
  };

  const retry = (id: string) => {
    const item = items.find((entry) => entry.id === id);
    if (!item || !canRetry(item, payloads.has(id))) return;
    item.transfer = "queued";
    item.loaded = 0;
    item.error = undefined;
    pump();
    notify();
  };

  const retryFailed = () => {
    for (const item of [...items]) retry(item.id);
  };

  const clear = () => {
    generation += 1;
    const busyKbIds = new Set(
      items
        .filter(
          (item) => item.transfer === "queued" || item.transfer === "uploading",
        )
        .map((item) => item.kbId),
    );
    for (const item of items) {
      // saving 阶段不 abort：请求体已全部发出，服务端无论如何都会写盘。
      if (itemPhase(item) !== "saving") controllers.get(item.id)?.abort();
    }
    controllers.clear();
    payloads.clear();
    items.splice(0);
    for (const kbId of busyKbIds)
      onBatchEnd({ kbId, uploaded: false, settled: true });
    notify();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    items,
    enqueue,
    cancel,
    cancelAll,
    retry,
    retryFailed,
    clear,
    subscribe,
  };
}
