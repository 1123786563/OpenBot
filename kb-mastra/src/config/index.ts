/**
 * kb-mastra 的运行时配置：全部来自环境变量（对齐 kb-service 的 config.go 哲学——
 * 不引入配置文件，单进程可跑）。加载失败 fail fast，不产出半份配置。
 *
 * 与 WeKnora 的对应：`internal/config/` 的 env 解析 + tenants.retrieval_config 默认值。
 */

/** API Key 的身份与权限范围（对齐 kb-service auth.APIKey）。 */
export type APIKeyEntry = {
  key: string;
  tenantId: string;
  /** read | write | admin。 */
  role: "read" | "write" | "admin";
  /** kb id 白名单；空 = 租户内全库。 */
  kbIds: Set<string>;
};

export type Config = {
  port: number;
  databaseUrl: string;
  redisUrl: string;
  qdrantUrl: string;
  qdrantApiKey: string;
  /** Qdrant upsert 批量（A16 调优档，默认 40 对齐 WeKnora BatchSave）。 */
  qdrantBatch: number;
  apiKeys: Map<string, APIKeyEntry>;
  docreaderAddr: string;
  docreaderCallTimeoutMs: number;
  ollamaBaseUrl: string;
  embedModel: string;
  /** Qdrant collection vectors.size + 启动自检基准（R9）。 */
  embedDimensions: number;
  batchEmbedSize: number;
  embedMaxConcurrency: number;
  rerankEnabled: boolean;
  rerankUrl: string;
  rerankModel: string;
  storageType: "local";
  storageLocalPath: string;
  maxFileSizeMb: number;
  vectorThreshold: number;
  keywordThreshold: number;
  defaultTopK: number;
  rerankTopK: number;
  rerankThreshold: number;
};

const DEFAULT_API_KEYS = "sk-kb-dev-001:tenant-a:admin";

function env(name: string, fallback = ""): string {
  const value = process.env[name]?.trim() ?? "";
  return value !== "" ? value : fallback;
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

/**
 * 解析 `KB_API_KEYS`：`;` 分隔多 key，每条 `<key>:<tenant>:<role>[:kb1,kb2]`。
 * 直译 kb-service parseAPIKeys：字段不足 3 段的条目静默跳过（开箱即用优先，
 * 错误条目在 Authenticate 时自然 401）。
 */
export function parseAPIKeys(raw: string): Map<string, APIKeyEntry> {
  const out = new Map<string, APIKeyEntry>();
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const fields = trimmed.split(":");
    if (fields.length < 3) continue;
    const key = fields[0]?.trim() ?? "";
    if (key === "") continue;
    const tenantId = fields[1]?.trim() ?? "";
    const roleRaw = fields[2]?.trim() ?? "";
    const role: APIKeyEntry["role"] | null =
      roleRaw === "read" || roleRaw === "write" || roleRaw === "admin"
        ? roleRaw
        : null;
    if (tenantId === "" || role === null) continue;
    const kbIds = new Set(
      (fields[3] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id !== ""),
    );
    out.set(key, { key, tenantId, role, kbIds });
  }
  return out;
}

let cached: Config | null = null;

/** 加载并缓存配置（进程内一次；测试可用 loadConfig(true) 强制重读）。 */
export function loadConfig(force = false): Config {
  if (cached && !force) return cached;
  const embedModel = env("KB_EMBED_MODEL");
  if (embedModel === "") {
    // embedding 模型是摄取与检索的硬依赖；缺了它进程其余部分无意义，拒绝启动。
    throw new Error("KB_EMBED_MODEL must be set (no default embedding model).");
  }
  cached = {
    port: envInt("KB_PORT", 8082),
    databaseUrl: env("KB_DATABASE_URL"),
    redisUrl: env("KB_REDIS_URL", "redis://localhost:6379"),
    qdrantUrl: env("QDRANT_URL", "http://localhost:6333").replace(/\/+$/, ""),
    qdrantApiKey: env("QDRANT_API_KEY"),
    qdrantBatch: envInt("KB_QDRANT_BATCH", 40),
    apiKeys: parseAPIKeys(env("KB_API_KEYS", DEFAULT_API_KEYS)),
    docreaderAddr: env("DOCREADER_ADDR", "localhost:50051"),
    docreaderCallTimeoutMs: envInt("DOCREADER_CALL_TIMEOUT_MS", 1_800_000),
    ollamaBaseUrl: env("OLLAMA_BASE_URL", "http://localhost:11434").replace(
      /\/+$/,
      "",
    ),
    embedModel,
    embedDimensions: envInt("KB_EMBED_DIMENSIONS", 1024),
    batchEmbedSize: envInt("BATCH_EMBED_SIZE", 5),
    embedMaxConcurrency: envInt("KB_EMBED_MAX_CONCURRENCY", 32),
    rerankEnabled: envBool("KB_RERANK_ENABLED", false),
    rerankUrl: env("KB_RERANK_URL"),
    rerankModel: env("KB_RERANK_MODEL"),
    storageType: "local",
    storageLocalPath: env("STORAGE_LOCAL_PATH", "./data/kb-files"),
    maxFileSizeMb: envInt("MAX_FILE_SIZE_MB", 50),
    vectorThreshold: envFloat("KB_VECTOR_THRESHOLD", 0.15),
    keywordThreshold: envFloat("KB_KEYWORD_THRESHOLD", 0.3),
    defaultTopK: envInt("KB_DEFAULT_TOP_K", 50),
    rerankTopK: envInt("KB_RERANK_TOP_K", 10),
    rerankThreshold: envFloat("KB_RERANK_THRESHOLD", 0.2),
  };
  return cached;
}
