/**
 * 上传队列的 React 桥：`useSyncExternalStore` 订阅模块级单例队列。单例在
 * 本文件装配（queue 的 onBatchEnd 上抛到这里登记的 settle 监听器），避免
 * queue.ts ↔ store.ts 的循环引用——queue 是纯逻辑，store 负责订阅与快照。
 *
 * settle 通知（某库批次结束→该刷新文档列表）由详情页登记监听并接 React
 * Query 的 invalidate；store 本身不依赖 React Query。
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { type BatchEnd, createUploadQueue } from "./queue";
import { type ItemPhase, itemPhase, type UploadItem } from "./state";

/** 面板消费的只读快照条目：传输字段 + 折叠后的展示阶段。 */
export type UploadTaskView = UploadItem & { phase: ItemPhase };

const settleListeners = new Set<(end: BatchEnd) => void>();

/** 模块级单例：上传队列跨页面存活（离开详情页再回来任务还在）。 */
const queue = createUploadQueue((end) => {
  for (const listener of settleListeners) listener(end);
});

let snapshot: UploadTaskView[] = queue.items.map(freezeItem);

queue.subscribe(() => {
  // 快照在每次通知时重建；两次通知之间 getSnapshot 返回同一引用——
  // useSyncExternalStore 的 tear-free 约定靠这个保证。
  snapshot = queue.items.map(freezeItem);
});

function freezeItem(item: UploadItem): UploadTaskView {
  return { ...item, phase: itemPhase(item) };
}

/** 全部任务的快照（活动 + 已结束），组件按 kbId/阶段自行切分。 */
export function useUploadTasks(): UploadTaskView[] {
  return useSyncExternalStore(subscribeSnapshot, getSnapshot, getSnapshot);
}

function getSnapshot(): UploadTaskView[] {
  return snapshot;
}

function subscribeSnapshot(listener: () => void): () => void {
  return queue.subscribe(listener);
}

/**
 * 按库切片 + settle 通知。onSettled 在该库批次结束（uploaded 与否都会
 * settled）时触发一次，供调用方 invalidate documents；回调经 ref 保持最新
 * 引用，订阅本身只在挂载周期内登记一次。
 */
export function useUploadTasksFor(
  kbId: string,
  onSettled: (end: BatchEnd) => void,
): UploadTaskView[] {
  const all = useUploadTasks();
  const callbackRef = useRef(onSettled);
  callbackRef.current = onSettled;

  useEffect(() => {
    const listener = (end: BatchEnd) => {
      if (end.kbId === kbId || end.settled) callbackRef.current(end);
    };
    settleListeners.add(listener);
    return () => {
      settleListeners.delete(listener);
    };
  }, [kbId]);

  return all.filter((task) => task.kbId === kbId);
}

/** 入队/取消/重试的直接命令接口（不经 hook 也能用，如测试）。 */
export const uploadCommands = {
  enqueue: queue.enqueue,
  cancel: queue.cancel,
  cancelAll: queue.cancelAll,
  retry: queue.retry,
  retryFailed: queue.retryFailed,
  clear: queue.clear,
};
