import { Platform } from "react-native";

/**
 * OpenBot 部署地址与运行时开关。
 *
 * `EXPO_PUBLIC_OPENBOT_URL` 指向 OpenBot server（与 openmuse 自家后端的
 * `EXPO_PUBLIC_API_URL` 相互独立）；`EXPO_PUBLIC_BACKEND` 选择数据源：
 * - `openbot`：登录、工作区、会话、消息全部走 OpenBot；
 * - `openmuse`（默认/缺省）：保持原有本地 sample 链路，可随时回退。
 */
const configured = process.env.EXPO_PUBLIC_OPENBOT_URL?.trim() || "http://localhost:3001";
const backend = (process.env.EXPO_PUBLIC_BACKEND?.trim() || "openmuse") as
  | "openbot"
  | "openmuse";

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("EXPO_PUBLIC_OPENBOT_URL 必须是完整 URL，例如 http://localhost:3001");
  }
  // 服务端把 OAuth 回调注册在 localhost：浏览器 cookie 按 host 隔离，
  // 127.0.0.1 页面拿不到回调种下的会话（state_mismatch）。两个回环名
  // 指向同一台机器，web 构建统一归一到 localhost。
  if (Platform.OS === "web" && endpoint.hostname === "127.0.0.1")
    endpoint.hostname = "localhost";
  if (endpoint.protocol !== "https:" && !(__DEV__ && endpoint.protocol === "http:"))
    throw new Error("OpenBot 原生登录要求 HTTPS（开发调试允许 http）。");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error("OPENBOT_URL 不能携带凭据、查询串或锚点。");
  return endpoint;
}

export const openbotBackend = backend;
export const openbotEndpoint = parseEndpoint(configured);
export const openbotUrl = openbotEndpoint.origin;
/** 原生回跳 scheme；web 构建回到当前页面 origin（服务端 TRUSTED_ORIGINS 放行）。 */
export const openbotCallbackTarget =
  Platform.OS === "web" ? window.location.origin : "openmuse://";
