/**
 * KB-Service 连接配置。
 *
 * KB-Service 是从 WeKnora 抽离出的独立知识库服务（解析/切分/向量化/检索），
 * OpenBot 以 HTTP 直连方式对接它（非 MCP）。这里只负责读取连接参数；服务间
 * 鉴权用的 API Key 只存在于 Server 进程，前端永远接触不到。
 */

export type KnowledgeServiceConfig = {
  /** KB-Service 的 base URL，例如 `http://kb-service:8081`。 */
  baseUrl: string;
  /** KB-Service 的 API Key（服务间鉴权，绑定 tenant 与角色）。 */
  apiKey: string;
  /** 上游请求超时（毫秒）。 */
  timeoutMs: number;
};

/**
 * 从环境变量读取 KB-Service 配置。
 *
 * 返回 `null` 表示知识库功能未启用——此时 `/api/knowledge/*` 端点会以 503 应答，
 * 而不是在调用点崩溃。这样 OpenBot 可以在不部署 KB-Service 的情况下照常运行。
 */
export function knowledgeServiceConfig(): KnowledgeServiceConfig | null {
  const baseUrl = process.env.KB_SERVICE_URL?.trim();
  if (!baseUrl) return null;

  const apiKey = process.env.KB_SERVICE_API_KEY?.trim() ?? "";
  const timeoutMs =
    Number.parseInt(process.env.KB_SERVICE_TIMEOUT_MS ?? "", 10) || 10_000;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    timeoutMs,
  };
}
