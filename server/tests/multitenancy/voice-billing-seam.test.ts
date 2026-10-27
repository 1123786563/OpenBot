// server/tests/multitenancy/voice-billing-seam.test.ts
// MOD24（Issue #644，根 #620）：语音听写媒体链路复用模型费用与当前资格——现状钉套件。
//
// 本套件是 VOICE 出口与三绕过面（B1/B2/B3）现状的源级钉，native 形（e2e-compat、
// 根入口收集、manifest 零触碰、零数据库）。票面红线「不新增业务功能、不补做
// Bifrost 原票未实现功能」：接门产品语义缺口=登记（报告 §登记节），本套件只钉现状：
//
//   D1  出口等价：voice/public.ts 恰 re-export M04 消费所需，label.ts 已改道，
//       跨模块深取 voice/cut 零残留。
//   D2  验收① 现状钉：免费路径身份资格三件套（requireUser、归属/频控、actor.id）
//       源级钉；B3 摘要链恰两路径防扩散钉（新增第三条直取即红）。
//   D3  验收② 现状钉：槽释放、dictation abort→504、abort 信号贯通 transport；
//       OpenBot 侧零账务词边界扫（grant 族零命中防回流）；Bifrost 门内尾部结算
//       事实以既有 integration 件存在性为指针（读数落 reports 台账）。
//   D4  验收③ 现状钉：scope-key 切换即 session.end()、dictation 代次卫兵、
//       服务端不消费范围对（防误认为已绑定）、客户端范围对允许面不含 voice/audio
//       写面而流建立面含 /api/voice/calls（MOD19 面）。
//   D5  验收④ 现状钉：供应商封闭枚举三处字面源扫；/v1/realtime 网关面零命中。
//   D6  （不在本文件）存量族两侧对照按计划 §3 验证门执行，读数落
//       reports/mod24-verification/commands.md 台账。
//
// 全部用例源扫描用 node:fs 读源文本；唯一值级断言针对 app 出口文件（零依赖纯
// 函数文件，不经模块图引入 app 其余面）。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "../../../tests/support/e2e-compat";

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
const repoDir = fileURLToPath(new URL("../../../", import.meta.url));
const appLib = `${repoDir}app/src/lib`;

const read = (path: string) => readFileSync(path, "utf8");
const serverVoice = (name: string) => read(`${srcDir}/voice/${name}`);
const serverDictation = (name: string) => read(`${srcDir}/dictation/${name}`);

function walkTs(from: string): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string) => {
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      const next = rel ? `${rel}/${name.name}` : name.name;
      if (statSync(`${abs}/${name.name}`).isDirectory())
        visit(`${abs}/${name.name}`, next);
      else if (name.name.endsWith(".ts") || name.name.endsWith(".tsx"))
        out.push(next);
    }
  };
  visit(from, "");
  return out;
}

describe("MOD24 D1：voice/public.ts 出口等价（恰符号+同绑定）", () => {
  test("出口恰 re-export M04 消费所需的名字（cut.ts 导出面中仅 openingOf 被消费）", () => {
    const exports = read(`${appLib}/voice/public.ts`)
      .split("\n")
      .filter((line) => line.startsWith("export "))
      .map((line) => line.trim());
    expect(exports).toEqual(['export { openingOf } from "./cut";']);
  });

  test("同绑定：出口行指向 cut.ts，cut.ts 导出面未漂移", () => {
    expect(read(`${appLib}/voice/cut.ts`)).toContain(
      "export function openingOf(text: string, limit: number): string {",
    );
    expect(read(`${appLib}/voice/cut.ts`)).toContain(
      "export function closingOf(text: string, limit: number): string {",
    );
  });

  test("M04 消费点已改道公开出口，VOICE 模块外再无 voice/cut 深取", () => {
    expect(read(`${appLib}/channels/label.ts`)).toContain(
      'from "@/lib/voice/public"',
    );
    expect(read(`${appLib}/channels/label.ts`)).not.toContain(
      "@/lib/voice/cut",
    );
    for (const file of walkTs(`${repoDir}app/src`)) {
      if (file.startsWith("lib/voice/")) continue;
      expect(
        read(`${repoDir}app/src/${file}`).includes("@/lib/voice/cut"),
        file,
      ).toBe(false);
    }
  });
});

describe("MOD24 D2：验收① 免费路径身份资格现状（源级钉）", () => {
  test("voice 路由：requireUser 全量中间件+身份取 actor.id+频控与并发槽三件套", () => {
    const routes = serverVoice("routes.ts");
    expect(routes).toContain('app.use("*", requireUser)');
    expect(routes).toContain("const userId = context.var.actor.id;");
    expect(routes).toContain("attempts.get(userId)");
    expect(routes).toContain("active.size >= 8");
    expect(routes).toContain("active.add(userId)");
  });

  test("session 路由挂载于 voice router 认证中间件之下（独立于 live 配置）", () => {
    expect(serverVoice("session-routes.ts")).toContain(
      "Mounted beneath the voice router's authentication middleware",
    );
  });

  test("dictation 路由：requireUser 全量中间件", () => {
    expect(serverDictation("routes.ts")).toContain('app.use("*", requireUser)');
  });

  test("B3 摘要链防扩散钉：恰两条既有路径，无第三条直取、无 mastra/billing 直依赖", () => {
    const summary = serverVoice("summary.ts");
    expect(summary.split("new PlanModel(").length - 1).toBe(1);
    expect(summary.split("options.resolveApiKey()").length - 1).toBe(1);
    expect(summary).not.toContain('from "../mastra');
    expect(summary).not.toContain('from "../billing');
  });

  test("B3 接门缺口证据：PlanModel 订阅域明示不进 credit admission；受管模型缝必收 run 身份", () => {
    expect(read(`${srcDir}/agents/plan-model.ts`)).toContain(
      "never reserves or settles",
    );
    const model = read(`${srcDir}/mastra/model.ts`);
    expect(model).toContain("export type GovernedModelContext = {");
    expect(model).toContain("runId: string;");
    expect(model).toContain("attemptId: string;");
  });
});

describe("MOD24 D3：验收② 断流/取消合同现状（源级钉）", () => {
  test("voice 并发槽释放钉（active.delete 即取消路径释放）", () => {
    expect(serverVoice("routes.ts")).toContain("active.delete(userId)");
  });

  test("dictation 取消/超时→504，abort 信号贯通 provider transport", () => {
    const routes = serverDictation("routes.ts");
    expect(routes).toContain("if (signal.aborted)");
    expect(routes).toContain("504");
    const provider = serverDictation("provider.ts");
    expect(provider).toContain("transcribe(file: File, signal: AbortSignal)");
    expect(provider).toContain("signal,");
  });

  test("OpenBot 侧零账务：voice+dictation 四根词边界扫 grant 族零命中（防回流钉）", () => {
    const pattern = /\b(grant|entitlement|budget|reserve|settle)\b/;
    for (const root of [
      `${srcDir}/voice`,
      `${srcDir}/dictation`,
      `${appLib}/voice`,
      `${appLib}/dictation`,
    ]) {
      for (const file of walkTs(root)) {
        expect(pattern.test(read(`${root}/${file}`)), `${root}/${file}`).toBe(
          false,
        );
      }
    }
  });

  test("Bifrost 门内尾部结算事实指针：既有 integration 件在案", () => {
    const settlement = `${repoDir}server/tests/realtime-tail-settlement.integration.test.ts`;
    expect(statSync(settlement).isFile()).toBe(true);
  });
});

describe("MOD24 D4：验收③ 旧媒体响应不污染新上下文现状（源级钉）", () => {
  test("scope-key 变化即 session.end()（use-voice-call 切换半边契约）", () => {
    const hook = read(`${appLib}/voice/use-voice-call.ts`);
    expect(hook).toContain("const seenScopeKey = useRef(streamScopeKey);");
    expect(hook).toContain("seenScopeKey.current = streamScopeKey;");
    expect(hook).toContain("session.end();");
  });

  test("dictation 代次卫兵：generation 计数贯穿取消/转写路径", () => {
    const session = read(`${appLib}/dictation/session.ts`);
    expect(session).toContain("private generation = 0;");
    expect(session).toContain("this.generation++;");
  });

  test("服务端 voice/dictation 不消费范围对（现状钉，防误认为已绑定）", () => {
    const pattern = /scopePair|scope-pair|scopeKey|x-scope/i;
    for (const root of [`${srcDir}/voice`, `${srcDir}/dictation`]) {
      for (const file of walkTs(root)) {
        expect(pattern.test(read(`${root}/${file}`)), file).toBe(false);
      }
    }
  });

  test("MOD19 面在位：流建立允许面含 /api/voice/calls；头允许面不含 voice/audio", () => {
    const streamScope = read(`${appLib}/enterprise/tenant/stream-scope.ts`);
    expect(streamScope).toContain('prefix: "/api/voice/calls"');
    const client = read(`${appLib}/client.ts`);
    const start = client.indexOf("export const SCOPE_HEADER_ALLOWED_PATHS");
    const end = client.indexOf("\n];", start);
    const allowedPaths = client.slice(start, end);
    expect(allowedPaths).not.toContain("/api/voice");
    expect(allowedPaths).not.toContain("/api/audio");
  });
});

describe("MOD24 D5：验收④ 不新增供应商/语言/实时能力现状（源级钉）", () => {
  test("供应商封闭枚举三处字面：两 config 类型收口+provider 分支，且不出第三文件", () => {
    expect(serverVoice("config.ts")).toContain(
      'provider: "openai-realtime" | "xai-realtime"',
    );
    expect(serverVoice("config.ts")).toContain(
      "must be openai-realtime or xai-realtime",
    );
    expect(serverDictation("config.ts")).toContain(
      'provider: "openai-compatible"',
    );
    expect(serverDictation("config.ts")).toContain("must be openai-compatible");
    expect(serverVoice("provider.ts")).toContain(
      'config.provider === "xai-realtime"',
    );
    const enumFiles = new Set<string>();
    const pattern = /"(openai-realtime|xai-realtime|openai-compatible)"/;
    for (const [label, root] of [
      ["voice", `${srcDir}/voice`],
      ["dictation", `${srcDir}/dictation`],
    ] as const) {
      for (const file of walkTs(root)) {
        if (pattern.test(read(`${root}/${file}`)))
          enumFiles.add(`${label}/${file}`);
      }
    }
    expect([...enumFiles].sort()).toEqual([
      "dictation/config.ts",
      "dictation/provider.ts",
      "voice/config.ts",
      "voice/provider.ts",
    ]);
  });

  test("转写模型现状钉：gpt-4o-mini-transcribe 硬编码于 realtime 握手（不补做）", () => {
    expect(serverVoice("provider.ts")).toContain(
      'transcription: { model: "gpt-4o-mini-transcribe" }',
    );
  });

  test("/v1/realtime 网关面零命中（Bifrost Go 面不在此侧复刻，不补做）", () => {
    for (const file of walkTs(`${srcDir}/gateway`)) {
      expect(
        read(`${srcDir}/gateway/${file}`).includes("v1/realtime"),
        file,
      ).toBe(false);
    }
  });
});
