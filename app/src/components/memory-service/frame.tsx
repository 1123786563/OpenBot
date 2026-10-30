import { useEffect, useRef, useState } from "react";

/*
 * #731 受控 iframe 承载页。src、允许的 Origin 与 requestId 全部来自服务器
 * （GET /api/memory-service/entry）；浏览器不拼 URL、不从消息里取地址。
 *
 * 消息校验三件齐备才处理：精确 Origin、source 必须是本 iframe 的 window、
 * requestId 必须是本次装载。任一不符即丢弃——未允许的宿主或伪造消息既不能
 * 建立身份，也不能改变页面。
 *
 * auth-required 只触发顶层登录并回到登记的承载路由；消息里即便带了 URL
 * 也不会被读取（合同里它本来也不该带）。
 */

const MESSAGE_TYPES = new Set([
  "memory.ready",
  "memory.resize",
  "memory.auth-required",
  "memory.logged-out",
]);

export type MemoryServiceFrameProps = {
  src: string;
  allowedOrigin: string;
  requestId: string;
  title: string;
  onAuthRequired?: () => void;
  onLoggedOut?: () => void;
};

/** 承载页的默认最小高度与上限：宿主保留自己的侧栏与滚动，不做整页接管。 */
const MIN_HEIGHT = 480;
const MAX_HEIGHT = 2400;

export function MemoryServiceFrame({
  src,
  allowedOrigin,
  requestId,
  title,
  onAuthRequired,
  onLoggedOut,
}: MemoryServiceFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== allowedOrigin) return;
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as
        | { type?: unknown; requestId?: unknown; height?: unknown }
        | null;
      if (typeof data !== "object" || data === null) return;
      if (typeof data.type !== "string" || !MESSAGE_TYPES.has(data.type)) return;
      if (data.requestId !== requestId) return;
      switch (data.type) {
        case "memory.resize":
          if (typeof data.height === "number" && Number.isFinite(data.height)) {
            setHeight(Math.min(Math.max(Math.ceil(data.height), MIN_HEIGHT), MAX_HEIGHT));
          }
          return;
        case "memory.auth-required":
          // 顶层完成统一登录；回跳只到 OpenBot 登记的承载路由。
          if (onAuthRequired) onAuthRequired();
          else window.location.assign("/memory?login=1");
          return;
        case "memory.logged-out":
          onLoggedOut?.();
          return;
        default:
          // memory.ready 只表示承载页已建立通道。
          return;
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [allowedOrigin, requestId, onAuthRequired, onLoggedOut]);

  return (
    <iframe
      ref={frame}
      src={src}
      title={title}
      className="w-full rounded-lg border"
      style={{ height }}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    />
  );
}