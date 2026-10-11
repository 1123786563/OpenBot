/**
 * BullMQ 队列装配（WeKnora Asynq 的对应物，v1 §5.4）。
 *
 * P1 单队列 `kb:core`（设计 §5.4：WeKnora 6 池 11 队列裁剪为单管线单队列，
 * 队列名常量集中管理留扩展）。attempts 4 = MaxRetry 3 + 1，指数退避 200ms×2^n。
 */

import { Queue } from "bullmq";
import { getLogger } from "../../../shared/logger";

const log = getLogger("kb-mastra");

export const QUEUE_NAME = "kb-core";

/** 摄取任务名（P1 唯一 job name）。 */
export const JOB_DOCUMENT_PROCESS = "document:process";

/**
 * DocumentProcessPayload：对齐 WeKnora v1 §5.2 的全字段（驼峰）。
 * attempt 是世代号语义（与 BullMQ 自身的 attemptsMade 正交）：reparse 时
 * knowledge 行 attempt+1 且新 payload 携带新值；worker 与 DB 不等即跳过。
 */
export type DocumentProcessPayload = {
  requestId: string;
  tenantId: string;
  knowledgeId: string;
  kbId: string;
  /** local 存储的相对路径（file 型）；url/text 型为空。 */
  filePath: string;
  fileName: string;
  fileType: string;
  /** url 型的抓取地址；file/text 型为空。 */
  url: string;
  /** url 抓取后的本地副本路径（fetch 完成后回填）。 */
  fileUrl: string;
  /** text 型的直传内容（P1 manual 入口）；其余为空。 */
  passages: string;
  /** 世代号：payload.attempt ≠ knowledges.attempt → attemptSuperseded 跳过。 */
  attempt: number;
};

export const DEFAULT_ATTEMPTS = 4;
/** 指数退避基数：200ms × 2^n（对齐 WeKnora MinRetryBackoff 语义）。 */
const BACKOFF_BASE_MS = 200;

let queueSingleton: Queue<DocumentProcessPayload> | null = null;

/** 共享队列实例（HTTP 入队与 worker 消费各自进程内单例）。 */
export function getQueue(
  connection?: { url: string },
): Queue<DocumentProcessPayload> {
  if (queueSingleton && !connection) return queueSingleton;
  const queue = new Queue<DocumentProcessPayload>(QUEUE_NAME, {
    connection: connection ?? { url: process.env.KB_REDIS_URL ?? "redis://localhost:6379" },
  });
  if (!connection) queueSingleton = queue;
  return queue;
}

/** 入队一条摄取任务。jobId=knowledgeId：同文档并发 reparse 时新 job 顶旧 job。 */
export async function enqueueDocumentProcess(
  payload: DocumentProcessPayload,
): Promise<void> {
  const queue = getQueue();
  await queue.add(JOB_DOCUMENT_PROCESS, payload, {
    jobId: payload.knowledgeId,
    attempts: DEFAULT_ATTEMPTS,
    backoff: {
      type: "exponential",
      delay: BACKOFF_BASE_MS,
    },
    removeOnComplete: { age: 24 * 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  log.info(
    {
      type: "kb-ingest-enqueued",
      knowledgeId: payload.knowledgeId,
      kbId: payload.kbId,
      attempt: payload.attempt,
      requestId: payload.requestId,
    },
    "kb-ingest-enqueued",
  );
}
