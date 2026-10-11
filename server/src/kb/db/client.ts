/**
 * Postgres 连接与 Drizzle 实例（元数据四表专用；向量在 Qdrant，本连接不承载）。
 *
 * postgres.js（postgres@3）驱动 + drizzle-orm/postgres-js。进程内单例：迁移、
 * server、worker 共享一个连接池。
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let dbSingleton: Db | null = null;
let sqlSingleton: postgres.Sql | null = null;

/** 取共享连接（首次调用创建）。测试传 connectionUrl 建独立实例。 */
export function getDb(connectionUrl?: string): Db {
  if (dbSingleton && !connectionUrl) return dbSingleton;
  const url = connectionUrl ?? process.env.KB_DATABASE_URL;
  if (!url) throw new Error("KB_DATABASE_URL is not configured.");
  const sql = postgres(url, {
    // 元数据访问是小查询为主；池不必大。摄取管线批量写走事务，同池复用。
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });
  if (!connectionUrl) {
    dbSingleton = db;
    sqlSingleton = sql;
  }
  return db;
}

/** 进程退出时优雅关闭（index.ts 与测试用）。 */
export async function closeDb(): Promise<void> {
  if (sqlSingleton) {
    await sqlSingleton.end({ timeout: 5 });
    sqlSingleton = null;
    dbSingleton = null;
  }
}
