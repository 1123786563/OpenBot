// server/tests/multitenancy/child-backfill-kb.test.ts
// MT116（Issue #159）：知识库侧归属回填与独立进度记录。
//
// 事实裁定：本票正文写作（2026-10-14）先于 ADR 0009（2026-10-19 接受）。
// ADR 0009《移除知识库（KB）子系统》全量下线了 KB 域——kb gRPC 服务、
// knowledge 检索中间件、drizzle-kb 迁移、kb:* 脚本、/admin/knowledge、
// craft company-search 中继与 KB_TEST_DATABASE_URL 等 env 消费者全部删除，
// 且明言「ADR 0004 与各 spec 为历史记录不改写；本文取代其中 kb 相关部分」。
// 存量库的 knowledge_bases/knowledges 表与 enterprise_resources
// kind='knowledge' 行保留为惰性数据——无生产方、无受限查询面、无运行时
// 读取路径。
//
// 因此本票四条验收的诚实形态（MT093/#136 对同域的既定先例——「下线即
// 隔离」，空真钉死 + 复活即红）：
//   AC1 知识库侧回填幂等可续跑、进度独立记录 → 无知识库侧可回填：无库、
//      无文档、无 chunk、无 revision 的任何 schema/服务/迁移面；进度
//      「独立记录」的落点是 MT117 一致性报告把 KB 侧记为 not-applicable
//      （ADR 0009 依据，backfill-consistency.test.ts 钉死）。
//   AC2 归属链一致、不一致被报告 → 无归属链存在即无可不一致；若 KB 面
//      复活（任何 knowledge schema/服务/env 消费者回归），本套件红。
//   AC3 不假装跨库外键/跨库单事务 → 连「跨库」的第二库都不存在，更无
//      假装可言；ADR 0009 后仓库不存在任何 KB 库连接面。
//   AC4 回填后受限查询结果与归属一致 → 无受限查询面（MT061 之后 KB 文
//      件读取属 OpenMuse 文件域，与知识库域无关）。
//
// 本文件就是票面 Verification 条目（child-backfill-kb.test.ts）的裁定
// 落点：钉死「下线状态未被侵蚀」。知识库面若被有意复活，这些钉子应当
// 失败，直到复活面走完自己的多租户归属设计并相应修订本钉。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/bun-test-compat";

const here = fileURLToPath(new URL(".", import.meta.url));
const serverRoot = join(here, "..", "..");
const repoRoot = join(serverRoot, "..");

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let info: ReturnType<typeof statSync> | undefined;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (entry === "node_modules" || entry === ".git") continue;
        visit(full);
      } else if (keep(full)) {
        found.push(full);
      }
    }
  };
  visit(dir);
  return found;
}

// 自身（本钉子文件）不在扫描范围：它必然包含被钉死的词汇。
const SELF = fileURLToPath(import.meta.url);
const SOURCE_FILES = walk(join(serverRoot, "src"), (p) =>
  p.endsWith(".ts"),
).concat(
  walk(join(serverRoot, "scripts"), (p) => p.endsWith(".ts")),
  walk(join(serverRoot, "tests"), (p) => p.endsWith(".ts") && p !== SELF),
  walk(
    join(repoRoot, "app", "src"),
    (p) => p.endsWith(".ts") || p.endsWith(".tsx"),
  ),
);

describe("MT116 — ADR 0009 的下线裁定与知识库面不可复活（空真钉死）", () => {
  test("ADR 0009 存在且已接受（事实源裁定依据）", () => {
    const adrPath = join(
      repoRoot,
      "docs",
      "adr",
      "0009-remove-knowledge-base-domain.md",
    );
    expect(existsSync(adrPath)).toBe(true);
    const text = readFileSync(adrPath, "utf8");
    expect(text).toContain("状态：已接受");
    expect(text).toContain("取代其中 kb 相关部分");
  });

  test("KB 子系统的代码面全部不存在（服务/中间件/迁移/脚本/装配）", () => {
    for (const path of [
      join(serverRoot, "src", "kb"),
      join(serverRoot, "src", "knowledge"),
      join(repoRoot, "docker", "compose", "kb.yml"),
      join(repoRoot, "docker", "kb-mastra"),
    ]) {
      expect(existsSync(path)).toBe(false);
    }
    // drizzle 迁移链上无任何 KB 表族的建表语句（drizzle-kb 迁移已删）。
    const migrations = walk(join(serverRoot, "drizzle"), (p) =>
      p.endsWith(".sql"),
    );
    for (const file of migrations) {
      const text = readFileSync(file, "utf8").toLowerCase();
      expect(
        text.includes("knowledge_bases") || text.includes('"knowledges"'),
        `${file} 提及 KB 表族`,
      ).toBe(false);
    }
    // package.json 无 kb:* 脚本。
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const kbScripts = Object.keys(pkg.scripts ?? {}).filter((key) =>
      key.startsWith("kb:"),
    );
    expect(kbScripts).toEqual([]);
  });

  test("无任何测试或源码读取 KB 测试库 env（ADR 0009 后果逐字钉死）", () => {
    const kbEnvKeys = [
      "KB_TEST_DATABASE_URL",
      "KNOWLEDGE_TEST_DATABASE_URL",
      "KB_DATABASE_URL",
    ];
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file, "utf8");
      for (const key of kbEnvKeys) {
        expect(text.includes(key), `${file} 读取 ${key}`).toBe(false);
      }
    }
  });

  test("惰性 KB 表无任何代码路径（存量行不可被读取面触碰）", () => {
    for (const file of SOURCE_FILES) {
      const text = readFileSync(file);
      // 精确到 SQL 表名形态（from/into/update knowledge_bases 等），注释
      // 与普通词（acknowledges）不算。
      expect(
        /(from|into|update|join)\s+["]?knowledge_bases\b/i.test(text),
        `${file} 引用 knowledge_bases 表`,
      ).toBe(false);
      expect(
        /(from|into|update|join)\s+["]?knowledges\b/i.test(text),
        `${file} 引用 knowledges 表`,
      ).toBe(false);
    }
  });

  test("MT003 注册表不含任何 KB 任务或 KB 表对象（迁移工具不建 KB 面）", () => {
    const registry = readFileSync(
      join(serverRoot, "scripts", "multitenancy", "migrate-test.ts"),
      "utf8",
    );
    expect(/id:\s*"MT0\d+.*kb/i.test(registry)).toBe(false);
    expect(
      /objects:\s*\[[^\]]*"?(knowledge_bases|knowledges|kb_)"/i.test(registry),
    ).toBe(false);
    expect(registry.includes("child-kb")).toBe(false);
  });

  test("主库回填批次闭集不含知识库侧批次 id（进度面同样无 KB 半边）", () => {
    const batch2 = readFileSync(
      join(
        serverRoot,
        "src",
        "enterprise",
        "tenancy",
        "child-backfill-batch2.ts",
      ),
      "utf8",
    );
    // 主库批次闭集 = 第一批 + 第二批（第二批 id 常量字面钉死）。
    expect(batch2).toContain(
      'export const CHILD_BACKFILL_BATCH2_ID = "child-main-batch2"',
    );
    expect(batch2).toContain('batchId: "child-main-batch1"');
    expect(batch2.includes("child-kb")).toBe(false);
    expect(/batchId:\s*"[^"]*kb[^"]*"/i.test(batch2)).toBe(false);
  });
});
