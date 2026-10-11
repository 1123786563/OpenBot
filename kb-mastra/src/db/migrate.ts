/**
 * 启动时自动迁移：drizzle-kit 的编程接口（migrate）+ pg_advisory_lock 互斥。
 *
 * 多实例（HTTP 与 worker 两进程）同时启动会竞争建表；advisory lock 保证同一
 * 时刻只有一个迁移执行者，其余等待后看到已迁移的版本表直接通过。锁是会话级
 * 的（同一池连接内 lock/unlock），崩溃时连接断开自动释放——不留死锁。
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { getLogger } from "../../../shared/logger";
import { getDb } from "./client";

const log = getLogger("kb-mastra");

/** kb-mastra 迁移互斥锁的 advisory key（任意固定 bigint，避开其它服务的取值）。 */
const MIGRATION_ADVISORY_KEY = "92180282001";

/**
 * 跑迁移。幂等：drizzle 版本表记录已应用 journal，重复执行跳过；并发执行者
 * 被 advisory lock 串行化。
 *
 * 锁走独立单连接（不用池）：advisory lock 绑定会话，池连接在 lock 与 unlock
 * 之间被借还的话锁就飘了。迁移本身仍在池连接上跑。
 */
export async function runMigrations(connectionUrl?: string): Promise<void> {
  const url = connectionUrl ?? process.env.KB_DATABASE_URL;
  if (!url) throw new Error("KB_DATABASE_URL is not configured.");

  const guard = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  await guard`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_KEY})`;
  try {
    const db = getDb(connectionUrl);
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await guard`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_KEY})`;
    await guard.end({ timeout: 5 });
  }
}

/** 独立运行入口：`bun src/db/migrate.ts`。 */
if (import.meta.main) {
  try {
    await runMigrations();
    log.info({ type: "kb-migrations-applied" }, "kb-migrations-applied");
    process.exit(0);
  } catch (error) {
    // 不落 error 抛出值本体（可能含连接串），只记名称。
    log.error(
      { type: "kb-migrations-failed", error: (error as Error).name },
      "kb-migrations-failed",
    );
    process.exit(1);
  }
}
