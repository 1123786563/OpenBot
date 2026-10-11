/**
 * 上传队列的纯状态规则，WeKnora `stores/uploadTasksState.ts` 的直译（裁剪掉
 * OpenBot 上游不存在的状态）：一条传输折叠成什么展示阶段、哪些条目还轮询、
 * 下一个该启动谁。无框架依赖，队列层与 UI 之间唯一共享的语言。
 */

/** 一个文件的 HTTP 上传在客户端的六种状态（上游无 duplicate 语义，裁剪）。 */
export type TransferStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "failed"
  | "cancelled";

export interface UploadItem {
  id: string;
  /** WeKnora 的批次 id 在这里退化为条目自身 id：批次除目标库外无信息。 */
  batchId: string;
  /** 目标知识库：面板按库切片、批次结束事件按库上报。 */
  kbId: string;
  name: string;
  size: number;
  /** 已发送字节数（由 multipart 进度比例换算）。 */
  loaded: number;
  transfer: TransferStatus;
  /** 传输失败原因。 */
  error?: string;
}

/**
 * 一行在面板上的展示阶段。`saving` 是请求体已全部发出、等待服务端落盘的
 * 窗口——这个阶段取消已经没有意义（服务端无论如何都会写入该行），面板据此
 * 隐藏取消按钮。
 */
export type ItemPhase =
  | "waiting"
  | "uploading"
  | "saving"
  | "uploaded"
  | "failed"
  | "cancelled";

export function itemPhase(item: UploadItem): ItemPhase {
  switch (item.transfer) {
    case "queued":
      return "waiting";
    case "uploading":
      return item.size > 0 && item.loaded >= item.size ? "saving" : "uploading";
    case "uploaded":
      return "uploaded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

export interface UploadPayload {
  file: File;
}

/** 取消只对这两个阶段有意义；saving 期服务端已在写盘，取消会藏行。 */
export function canCancel(item: UploadItem): boolean {
  return item.transfer === "queued" || itemPhase(item) === "uploading";
}

/** failed/cancelled 且文件仍在（未随成功上传释放）的条目可重试。 */
export function canRetry(item: UploadItem, hasPayload: boolean): boolean {
  return (
    (item.transfer === "failed" || item.transfer === "cancelled") && hasPayload
  );
}

/**
 * 现在应启动哪些排队条目：并发不超过 `concurrency`，且与在传条目共享
 * `conflictKey` 的排队条目让位给后面的。WeKnora 的 dedupKey=
 * `kbId:fileSize` 语义保留——同库同大小的两个文件不同时在传，给服务端
 * 的内容去重留出看到前一行再写第二行的窗口。
 */
export function pickNextToStart<T extends UploadItem>(
  items: readonly T[],
  concurrency: number,
  conflictKey: (item: T) => string,
): T[] {
  let running = 0;
  const busyKeys = new Set<string>();
  for (const item of items) {
    if (item.transfer !== "uploading") continue;
    running += 1;
    busyKeys.add(conflictKey(item));
  }
  const picked: T[] = [];
  for (const item of items) {
    if (running >= concurrency) break;
    if (item.transfer !== "queued") continue;
    const key = conflictKey(item);
    if (busyKeys.has(key)) continue;
    busyKeys.add(key);
    picked.push(item);
    running += 1;
  }
  return picked;
}

export interface UploadSummary {
  total: number;
  waiting: number;
  /** 含 saving。 */
  uploading: number;
  uploaded: number;
  failed: number;
  cancelled: number;
  retryable: number;
}

export function summarizeItems(items: readonly UploadItem[]): UploadSummary {
  const summary: UploadSummary = {
    total: items.length,
    waiting: 0,
    uploading: 0,
    uploaded: 0,
    failed: 0,
    cancelled: 0,
    retryable: 0,
  };
  for (const item of items) {
    const phase = itemPhase(item);
    if (phase === "waiting") summary.waiting += 1;
    else if (phase === "uploading" || phase === "saving")
      summary.uploading += 1;
    else if (phase === "uploaded") summary.uploaded += 1;
    else if (phase === "failed") {
      summary.failed += 1;
      summary.retryable += 1;
    } else if (phase === "cancelled") {
      summary.cancelled += 1;
      summary.retryable += 1;
    }
  }
  return summary;
}
