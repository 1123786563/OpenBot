// server/tests/multitenancy/learning-contract-seam.test.ts
// MOD23（Issue #643，根 #620）：隔离可选 Learning 并整理 toolkit 的真实共享 Seam。
//
// 本套件是学习缝的源级/值级钉，native 形（e2e-compat、根入口收集、manifest 零触碰）。
// 行为底座仍是既有族（learning 12 件 + intelligence-optional + mastra-learned-skills +
// no-intelligence-boot），本套件不重复其行为，只补计划 §1.D 的七组钉：
//
//   D1  A 收敛等价：保留对与 Acquire 类型经 learning/public.ts 出口后值/形不变。
//   D2  验收① 源级钉：/internal/ 依赖点恰 1、client accessor 注入形、关闭零构造。
//   D3  验收② 分列钉：learning 本地写面=两表、不并入个人记忆、两可选字段独立。
//   D4  验收③ 消费面钉：保留对 + execute 单一入口、供应商私有方法零新增直依赖。
//   D5  验收④ 反抽象钉：learning 域 adapter/compat/shim 零文件、toolkit 清单固化。
//   D6  目录实证钉：learning 模块两表与 enterprise-learning 两表分域分列。
//   D7  （不在本文件）存量族两侧对照按计划 §3 验证门执行，读数落
//       reports/mod23-verification/commands.md 台账。
//
// 全部用例不落数据库：源扫描用 node:fs 读源文本，行为用合成 stub（同
// learning-runtime.test.ts 的 synthetic client 形），DB 面由既有 integration 件覆盖。

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningSettings } from "@openbot/shared/learning";
import { describe, expect, test } from "../../../tests/support/e2e-compat";
import {
  type AcquireLearnedSkills,
  LEARNED_SKILL_TOOL_NAMES,
} from "../../src/learning/public";
import * as runtimeModule from "../../src/learning/runtime";
import { createLearningRuntime } from "../../src/learning/runtime";
import type { LearningSettingsStore } from "../../src/learning/settings";
import type { LearnedSkillInvocationSurface } from "../../src/mastra/execution-contracts";
import { createMastraLearnedTools } from "../../src/mastra/tools";

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
const repoDir = fileURLToPath(new URL("../../../", import.meta.url));

/** 递归列出目录下全部 .ts 文件的、相对 from 的路径（无 ./ 前缀）。 */
function walkTs(from: string): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string) => {
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) visit(`${abs}/${name.name}`, next);
      else if (name.name.endsWith(".ts")) out.push(next);
    }
  };
  visit(from, "");
  return out;
}

function serverSrcFiles(): string[] {
  return walkTs(srcDir);
}

const learningFiles = () =>
  readdirSync(`${srcDir}/learning`, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name);

const readLearning = (name: string) =>
  readFileSync(`${srcDir}/learning/${name}`, "utf8");

function disabledStore(): LearningSettingsStore {
  const settings: LearningSettings = {
    enabled: false,
    defaultTarget: { containerId: "openbot" },
    agents: {},
  };
  return {
    read: async () => settings,
    write: async (next) => next,
    saved: async () => true,
    adoptDefault: async () => false,
    bindThread: async () => null,
  };
}

describe("MOD23 D1：learning/public.ts 窄出口收敛等价", () => {
  test("保留对经出口后与 runtime 原件同一实例、内容恰为 SDK 两保留名", () => {
    expect(LEARNED_SKILL_TOOL_NAMES).toBe(
      runtimeModule.LEARNED_SKILL_TOOL_NAMES,
    );
    expect([...LEARNED_SKILL_TOOL_NAMES].sort()).toEqual([
      "copilotkit_load_skill",
      "copilotkit_read_skill_file",
    ]);
  });

  test("出口零判定零抽象：恰 re-export 两个被改道消费者所需的名字", () => {
    const exports = readLearning("public.ts")
      .split("\n")
      .filter((line) => line.startsWith("export "))
      .map((line) => line.trim());
    expect(exports).toEqual([
      'export type { AcquireLearnedSkills } from "./runtime";',
      'export { LEARNED_SKILL_TOOL_NAMES } from "./runtime";',
    ]);
  });

  test("消费点已改道公开出口，业务模块再无 learning/runtime 深取", () => {
    expect(readFileSync(`${srcDir}/mastra/tools.ts`, "utf8")).toContain(
      'import { LEARNED_SKILL_TOOL_NAMES } from "../learning/public";',
    );
    expect(
      readFileSync(`${srcDir}/agents/agent-resolver.ts`, "utf8"),
    ).toContain(
      'import type { AcquireLearnedSkills } from "../learning/public";',
    );
    for (const file of serverSrcFiles()) {
      if (!file.startsWith("mastra/") && !file.startsWith("agents/")) continue;
      if (file === "mastra/execution-contracts.ts") continue;
      expect(
        readFileSync(`${srcDir}/${file}`, "utf8").includes(
          'from "../learning/runtime"',
        ),
        file,
      ).toBe(false);
    }
  });

  test("Acquire 类型经出口后形不变：runtime.acquire 可按该签名赋值与调用", async () => {
    const acquire: AcquireLearnedSkills = createLearningRuntime({
      store: disabledStore(),
      client: new CopilotKitIntelligence({ apiKey: "synthetic-never-sent" }),
    }).acquire;
    expect(await acquire("bot")).toBeUndefined();
  });
});

describe("MOD23 D2：验收① 源级钉（关闭零构造、启用失败不伪造）", () => {
  test("快照合同的 /internal/ 私有依赖全仓恰 1 处，钉在 learning/runtime.ts", () => {
    const hits = serverSrcFiles().filter((file) =>
      readFileSync(`${srcDir}/${file}`, "utf8").includes(
        "@copilotkit/runtime/internal/",
      ),
    );
    expect(hits).toEqual(["learning/runtime.ts"]);
    const source = readLearning("runtime.ts");
    expect(
      source.match(/from "@copilotkit\/runtime\/internal\/learned-skills"/g),
    ).toHaveLength(1);
    expect(source).toContain("pinned to runtime 1.77.0");
  });

  test("client 注入形收 lazy accessor：注入形 = 实例或取实例的函数", () => {
    expect(readLearning("runtime.ts")).toContain(
      "client: CopilotKitIntelligence | (() => CopilotKitIntelligence)",
    );
  });

  test("learning 关闭时 client accessor 永不被求值（零构造）", async () => {
    let constructed = 0;
    const learning = createLearningRuntime({
      store: disabledStore(),
      client: () => {
        constructed++;
        throw new Error("client must stay unconstructed while learning is off");
      },
    });
    expect(await learning.acquire("bot")).toBeUndefined();
    expect(constructed).toBe(0);
  });

  test("mount 拒绝无 execute 的学习面（启用失败不伪造技能成功）", () => {
    const refusal = (() => {
      try {
        createMastraLearnedTools({
          catalog: "",
          tools: [],
        } as LearnedSkillInvocationSurface);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(refusal).toContain("MASTRA_LEARNED_SKILL_UNKNOWN");
    expect(refusal).toContain("refusing to mount");
  });
});

describe("MOD23 D3：验收② 两表外无本地写面、不并入个人记忆", () => {
  test("learning 域恰 settings.ts 一处引用 db 表面，表恰两张", () => {
    const dbImporters = learningFiles().filter((name) =>
      /from "\.\.\/db\//.test(readLearning(name)),
    );
    expect(dbImporters).toEqual(["settings.ts"]);
    const schema = readFileSync(`${srcDir}/db/schema/learning.ts`, "utf8");
    expect(schema.match(/pgTable\(/g)).toHaveLength(2);
    expect(schema).toContain('"learning_settings"');
    expect(schema).toContain('"learning_thread_bindings"');
  });

  test("learning 域零 personalMemory 引用（Skill 快照不并入个人记忆）", () => {
    for (const name of learningFiles()) {
      expect(readLearning(name).includes("personalMemory"), name).toBe(false);
    }
  });

  test("ExecutionRequest 的 learnedSkills 与 personalMemoryContext 两字段分列", () => {
    const source = readFileSync(
      `${srcDir}/mastra/execution-contracts.ts`,
      "utf8",
    );
    expect(source).toContain(
      "readonly learnedSkills?: LearnedSkillInvocationSurface;",
    );
    expect(source).toContain("readonly personalMemoryContext?: string;");
  });
});

describe("MOD23 D4：验收③ 快照消费面钉（保留对 + execute 单一入口）", () => {
  test("mastra/tools.ts 不触供应商：零 @copilotkit import，execute 委托恰一处", () => {
    const source = readFileSync(`${srcDir}/mastra/tools.ts`, "utf8");
    expect(source.includes("@copilotkit"), "no SDK import in tools.ts").toBe(
      false,
    );
    expect(
      source.match(/return surface\.execute\(learnedName, input\);/g),
    ).toHaveLength(1);
  });

  test("mount 只认 SDK 保留对：外来名拒绝、两保留名各得一个委托 execute 的工具", async () => {
    let executed: string[] = [];
    const surface: LearnedSkillInvocationSurface = {
      catalog: "",
      tools: [
        {
          name: "copilotkit_load_skill",
          description: "d",
          parameters: { type: "object" },
        },
        {
          name: "copilotkit_read_skill_file",
          description: "d",
          parameters: { type: "object" },
        },
        { name: "foreign_tool", description: "d" },
      ],
      execute: async (name) => {
        executed.push(name);
        return "ok";
      },
    };
    let refusal: string | null = null;
    try {
      createMastraLearnedTools(surface);
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).toContain("MASTRA_LEARNED_TOOL_NAME_FOREIGN");
    expect(refusal).toContain("foreign_tool");

    executed = [];
    const tools = createMastraLearnedTools({
      catalog: "",
      tools: surface.tools.slice(0, 2),
      execute: surface.execute,
    });
    expect(Object.keys(tools).sort()).toEqual([
      "copilotkit_load_skill",
      "copilotkit_read_skill_file",
    ]);
    await tools.copilotkit_load_skill.execute({ skill_name: "s" }, {});
    await tools.copilotkit_read_skill_file.execute(
      { skill_name: "s", path: "p" },
      {},
    );
    expect(executed).toEqual([
      "copilotkit_load_skill",
      "copilotkit_read_skill_file",
    ]);
  });
});

describe("MOD23 D5：验收④ 反抽象钉与 toolkit 清单固化", () => {
  test("learning 域零 adapter/compat/shim 文件（清单登记即交付，无可删项）", () => {
    expect(
      learningFiles().filter((name) =>
        /adapter|compat|shim|legacy/i.test(name),
      ),
    ).toEqual([]);
  });

  test("toolkit core 零 @copilotkit import；私有协议面四点原样在位", () => {
    for (const file of walkTs(`${repoDir}toolkit/src`)) {
      if (file.startsWith("copilotkit/")) continue;
      expect(
        readFileSync(`${repoDir}toolkit/src/${file}`, "utf8").includes(
          'from "@copilotkit/',
        ),
        file,
      ).toBe(false);
    }
    const runTurn = readFileSync(`${repoDir}toolkit/src/run-turn.ts`, "utf8");
    expect(runTurn).toContain("export type IntelligenceLike");
    expect(runTurn).toContain("export type RunnerLike");
    for (const adapter of [
      "toolkit/src/copilotkit/agents.ts",
      "toolkit/src/copilotkit/thread-lock.ts",
    ]) {
      expect(
        readFileSync(`${repoDir}${adapter}`, "utf8").length,
      ).toBeGreaterThan(0);
    }
  });

  test("@openbot/toolkit 消费者恰 server：app/worker/shared/supervisor 零 import", () => {
    for (const pkg of ["app", "worker", "shared", "supervisor"]) {
      expect(
        readFileSync(`${repoDir}${pkg}/package.json`, "utf8").includes(
          "@openbot/toolkit",
        ),
        pkg,
      ).toBe(false);
    }
    expect(readFileSync(`${repoDir}server/package.json`, "utf8")).toContain(
      '"@openbot/toolkit": "workspace:*"',
    );
    for (const dir of ["app/src", "worker/src", "shared"]) {
      for (const file of walkTs(`${repoDir}${dir}`)) {
        expect(
          readFileSync(`${repoDir}${dir}/${file}`, "utf8").includes(
            "@openbot/toolkit",
          ),
          `${dir}/${file}`,
        ).toBe(false);
      }
    }
  });
});

describe("MOD23 D6：目录比对实证钉（两域分列）", () => {
  test("enterprise_learning_* 实存且属 enterprise 域：learning 模块零引用", () => {
    const schema = readFileSync(
      `${srcDir}/db/schema/enterprise-learning.ts`,
      "utf8",
    );
    expect(schema).toContain('"enterprise_learning_containers"');
    expect(schema).toContain('"enterprise_learning_records"');
    for (const name of learningFiles()) {
      expect(readLearning(name).includes("enterpriseLearning"), name).toBe(
        false,
      );
      expect(readLearning(name).includes("enterprise_learning"), name).toBe(
        false,
      );
    }
  });
});
