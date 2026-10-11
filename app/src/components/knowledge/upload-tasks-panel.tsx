import { IconRefresh, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/lib/knowledge-format";
import type { UploadTaskView } from "@/lib/upload-queue/store";
import { uploadCommands, useUploadTasksFor } from "@/lib/upload-queue/store";

/**
 * 上传任务面板：详情页固定区（非全局浮层——OpenBot 无全局浮层惯例）。
 * 活动任务行 = 文件名 + 进度条（宽度百分比 div）+ 取消按钮（saving 阶段
 * 隐藏：服务端已在写盘，取消只会藏行）；失败行带重试。任务全部结束且无
 * 失败时延迟数秒自动收起，避免一整块"全部完成"长期占位。
 */

const AUTO_COLLAPSE_MS = 6_000;

export function UploadTasksPanel({ kbId }: { kbId: string }) {
  const { t } = useTranslation("knowledge");
  const tasks = useUploadTasksFor(kbId, () => {});
  const hasAny = tasks.length > 0;

  // 无任务不渲染（首屏干净）；面板自身可手动收起，来新任务再自动展开。
  const [collapsed, setCollapsed] = useState(false);
  const [autoHidden, setAutoHidden] = useState(false);
  const prevCountRef = useRef(tasks.length);

  useEffect(() => {
    // 新任务入队：展开并取消自动隐藏。
    if (tasks.length > prevCountRef.current) {
      setAutoHidden(false);
      setCollapsed(false);
    }
    prevCountRef.current = tasks.length;
  }, [tasks.length]);

  const allSettled = useMemo(
    () =>
      tasks.every(
        (task) =>
          task.phase === "uploaded" ||
          task.phase === "failed" ||
          task.phase === "cancelled",
      ),
    [tasks],
  );
  const failedCount = tasks.filter(
    (task) => task.phase === "failed" || task.phase === "cancelled",
  ).length;

  // 全部结束且无失败：延迟自动隐藏。有失败留着（还能重试）。
  useEffect(() => {
    if (!allSettled || failedCount > 0 || tasks.length === 0) return;
    const timer = setTimeout(() => setAutoHidden(true), AUTO_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [allSettled, failedCount, tasks.length]);

  if (!hasAny || autoHidden) return null;

  const active = tasks.filter(
    (task) =>
      task.phase === "waiting" ||
      task.phase === "uploading" ||
      task.phase === "saving",
  );
  const done = tasks.filter((task) => task.phase === "uploaded").length;
  const settledFailed = tasks.filter((task) => task.phase === "failed");

  const title = !allSettled
    ? t("upload.panelUploading", {
        done: String(done),
        total: String(tasks.length),
      })
    : failedCount > 0
      ? t("upload.panelDoneWithIssues", {
          ok: String(done),
          bad: String(failedCount),
        })
      : t("upload.panelDone");

  return (
    <section className="grid gap-2 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        <div className="flex items-center gap-1">
          {failedCount > 0 && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => uploadCommands.retryFailed()}
            >
              <IconRefresh data-icon="inline-start" />
              {t("upload.retryFailed", { count: failedCount })}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? t("upload.expand") : t("upload.collapse")}
          </Button>
        </div>
      </div>
      {collapsed ? null : (
        <ul className="grid gap-2">
          {active.map((task) => (
            <ActiveTaskRow key={task.id} task={task} />
          ))}
          {settledFailed.map((task) => (
            <FailedTaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
      {active.length > 0 && (
        <p className="text-xs text-muted-foreground">{t("upload.hint")}</p>
      )}
    </section>
  );
}

/** 活动行：文件名 + 体积 + 进度条 + 取消（saving 期禁用）。 */
function ActiveTaskRow({ task }: { task: UploadTaskView }) {
  const { t } = useTranslation("knowledge");
  const ratio = task.size > 0 ? Math.min(1, task.loaded / task.size) : 0;
  const saving = task.phase === "saving";

  return (
    <li className="grid gap-1">
      <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
        <span className="min-w-0 truncate font-medium" title={task.name}>
          {task.name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {task.phase === "waiting"
            ? t("upload.phaseWaiting")
            : saving
              ? t("upload.phaseSaving")
              : `${Math.round(ratio * 100)}%`}
          {task.size > 0 ? ` · ${formatFileSize(task.size)}` : ""}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("upload.cancel")}
          disabled={saving}
          onClick={() => uploadCommands.cancel(task.id)}
        >
          <IconX />
        </Button>
      </div>
      {/* 进度条：无 progress 组件，宽度百分比 div（spec §1 C4 降级方案）。 */}
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <div
          className="h-full bg-primary transition-[width] duration-150"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
    </li>
  );
}

/** 失败行：文件名 + 原因 + 重试。 */
function FailedTaskRow({ task: failed }: { task: UploadTaskView }) {
  const { t } = useTranslation("knowledge");
  return (
    <li className="flex min-w-0 items-center justify-between gap-2 text-sm">
      <div className="grid min-w-0 gap-0.5">
        <span className="truncate font-medium" title={failed.name}>
          {failed.name}
        </span>
        <span className="truncate text-xs text-destructive" role="alert">
          {failed.error || t("upload.phaseFailed")}
        </span>
      </div>
      <Button
        size="xs"
        variant="outline"
        onClick={() => uploadCommands.retry(failed.id)}
      >
        <IconRefresh data-icon="inline-start" />
        {t("upload.retry")}
      </Button>
    </li>
  );
}
