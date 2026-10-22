# OCR round5 编号修复计划 — round6

依据：`ocr/round5.json`（exit=0，status=partial：51 项中 27 完成、**24 项 429 未审**；28 findings = 1 high / 7 medium / 20 low）。
覆盖债：round4/5 合计仍有 **12 个核心服务文件从未被审**（plugin-packages 服务层 + app queries/mutations/use-package-scope + client.ts）——round6 以降并发（`--concurrency 4`）+ 必要时 `--resume` 链式补审，直至覆盖。
范围口径不变：`--exclude 'docs/plans/**,plugins/.artifacts/**'`。

## 修复项

| # | 严重度 | 位置 | 内容 | 角色 |
|---|---|---|---|---|
| R6-1 | **high**·bug | `app/src/routes/_authed/packages.tsx:4` | 路由挂 `/_authed` 直下丢失 `_app.tsx` 应用外壳（侧边栏）；相邻成员入口 /skills /bots /craft 均在 `_app` 下。**移至 `app/src/routes/_authed/_app/packages.tsx`**，URL 保持 `/packages` 不变；routeTree 重生成；sidebar 既有入口路径不动；页面测试相应更新并补外壳渲染断言 | frontend |
| R6-2 | medium·maint | `server/src/index.ts:1168` | operator 通道 createDatabase/verify 失败被静默吞掉，plan/apply 全 503 时运维无法区分"未配置 vs 配置失效"。降级路径补结构化日志（对照同块目录加载失败的 log.error 先例），含原因码；不改变降级语义 | backend |
| R6-3 | medium·bug | `scripts/plugin-packages/build.ts:138` | 循环内 storeArtifact 无错误处理：单条目写盘失败以未处理 rejection 终止全循环，failed 标志与 exitCode 语义失真。逐条目 try/catch：失败记录、继续后续条目、最终 exit 1 语义保持 | backend |
| R6-4 | medium·security | `server/src/plugin-packages/artifact.ts:194` | walkPackage 文件有 MAX_FILES=512 上限、目录无上限：海量空目录使栈与遍历无界。补 MAX_DIRS 上限（对齐 MAX_FILES 风格，建议 256）+ 超限品牌化错误 + 测试 | backend |
| R6-5 | medium·security | `server/src/plugin-packages/artifact.ts:225` | readVerifiedFile realpath 包含性校验后仍用原始拼接路径 open（O_NOFOLLOW 只拦最后一段）：中间目录组件被并发换成根外 symlink 时根外字节入摘要并被存为"已验证"。改为用 realpath 解析结果路径 open（保留 O_NOFOLLOW）；补中间目录 symlink 场景测试（可行时） | backend |
| R6-6 | medium·bug | `scripts/plugin-packages/build.ts:154` | 历史条目分支跳过 identityMatches：version 不同时源目录 manifest 属于另一 packageKey 也被当"历史条目"静默放过。历史分支同样先做身份校验，不匹配即硬失败；测试覆盖错包源目录场景 | backend |
| R6-7 | medium·doc | `server/src/index.ts:1134` | 注释声称 artifact root 缺失也 503，实际仅 index 缺失/非法才 503。先核实 artifact root 缺失的真实行为，注释改为如实描述 | backend |
| R6-8 | medium·bug | `app/src/components/market/package-experts.tsx:232` | 只读 summary/systemPrompt 展示来源（列表行 display.summary）与服务器实际写入来源（verified 模板）不一致。改从 installDetail 的 expertTemplate 资源读取展示；无模板资源时回退并注明；测试覆盖来源一致性 | frontend |

## Parked（20 low 不扩面；attempt JSON 留痕）

沿 round3/4/5 纪律；billing-credits-ui 的 flake/单跑红为预先存在、与本交付无关。

## 流程

frontend（R6-1、R6-8）/ backend（R6-2..R6-7）并行 → 主控 fresh 复核 → 独立 reviewer → cp24 → **OCR round6：`--concurrency 4` 全量**，未审文件未清零则 `--resume` 链式补跑直到 12 个欠审文件覆盖 → 有效 critical/high/medium 归零后收口 final-report。
