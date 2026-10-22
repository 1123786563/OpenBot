# R03 独立 Review — 研究工具标签与 skill 选择 UI（AC A10 前端，Issue #500 / up10 criteria 5–6）

- Reviewer: 独立 reviewer（Task R03，只读；唯一写入为本报告）。
- 日期: 2026-10-21。OCR 已取消（Ruling OCR-waive），本审查为最终质量关口。
- 方法: 亲读全部改动源码与上游参考；before/after-tracked.diff 机比；亲跑 native 27/27、driven 27/27（136 expect）、回归 41/41（28+13）+ 22/22 + 62/62、`bun run --filter app typecheck` exit 0、`bunx biome format` 10 文件 exit 0；R03 窗口（23:30–23:46）mtime 全树清扫恰 10 个 owned 文件；R02-F1 修复点亲读 store.ts 确认在位。实现者/验证者两份报告的可复核声明全部独立复现，未发现虚报。

## Spec compliance

- **Criterion 5（共享角色三处一致 + 合法角色不当失效 ref）— pass。** 三个消费面读同一 shared 词表：引导语 `server/src/plugins/tools.ts:286`（`RESEARCH_TOOLS[entry.key]?.notes` 并入 Bot 指引，且"Do not name the provider"与匿名标签同设计）、技能选择 `app/src/components/skills/skill-tools.tsx:157`（`RESEARCH_ROLES` 两枚角色按钮）+ `app/src/lib/skills/form.ts:87`（`researchRoleOf(ref) === null` 豁免，恰 shared 解析器两个答案，错拼 fail-closed 有测试钉死）、对话摘要 `app/src/components/channels/tool-activity.tsx:233`（`researchRoleOfTool` 分类 search/fetch）。两端保存校验（`server/src/plugins/store.ts:5066`，R02-F1 修复）与 app 端 `undeclaredElsewhere` 用同一过滤形状，picker→保存→selection 端到端闭环成立。
- **Criterion 6（来源/结果保留、页数真实、未知工具原名）— pass。** fetch 步骤单 http(s) URL 渲染真实 `<a href>`（`tool-activity.tsx:262-274`，非 http(s) 不链接、多 URL 不强加单一目标）；展开层完整 inputs + `forDisplay` 输出；失败组测试钉 provider 原因文本与 `a[href="https://example.com/source"]` 同时保留。**pages 只在 completed 计数（tool-activity.tsx:281-284）**：对上游 `Math.max(urls.length,1)` 无条件计数的缺陷是真实修正（pending/failed/refused 一律 0，测试矩阵逐态钉死），`summarise` 的 `browsed` 同步收窄为仅 browser 步骤，fetch 页数不串入"浏览了"。未知工具（`web_search_advanced_exa`/`deep_research`）保原名/原 detail、无 labelKey、计入 connectors 而非 searches——"不误标成功/只读"成立（权限分类仍全在 server，`classifyTool` 未触碰）。
- **旧 Parallel 兼容 + 不默认启用 — pass。** catalogue 保留 parallel 条目；`researchRoleOf("parallel/web_search") === null` 钉死，真实 ref 走原路径；无 server 提供时照旧进 "Not connected here"（兼容测试在位）。角色按钮只产出声明、不产生 grant，gating 仅 `plugins.data`，与上游同型；无任何 provider 被默认启用。
- **i18n — pass。** en +6 / zh +4 键与 before/after diff 逐键吻合；en 回退串与 en locale 同串有测试钉死；zh 摘要与角色标签有渲染层断言；`_one/_other` 复数结构正确（zh 仅 `_other` 符合其复数类别）；locales 外无新增硬编码用户可见文案（多 URL "and N more" 不移植是有理由的偏差，全量 URL 保留在展开层）。

**结论：up10 criteria 5、6（前端面）与 Spec §7 相关条目全部满足。Spec compliance 无保留。**

## Code quality

- **角色识别与防漂移**：`readToolName` 命中角色即丢弃 humanise 名与 detail（匿名语义与上游一致），非研究路径逐位未动（HEAD 113 行版本的既有测试 11 例原样保留）。`RESEARCH_ROLES` 落 app 侧而非 shared 是对的：R01 刻意不导出 prefix 常量，此处用 shared `researchRoleOf` 逐条回读 + 钉死序列防漂移——比上游直接消费 shared 常量的漂移面更小，且"若 shared 停止识别即先红"的注释准确描述了机制。
- **StepKind 扩展**：additive（`"search" | "fetch"` 增入 U04 的 `"browser" | "connector"`），`summarise` 保持纯函数 + 组件侧 `t()` 组句的 U04 架构（新增 `searches`/`fetchedPages` 两个字段而非改签名），`labelKey` 复用既有 `stepLabel` 翻译管线，`ResearchLabelKey` 与 `StepLabelKey` 的联合类型干净。
- **form.ts 豁免**：`!known.has(ref) && researchRoleOf(ref) === null` 与上游"把角色 ref 加进 known 集"行为等价，但对错拼更直白地 fail-closed，且与 server 保存校验同构——两份实现互为镜像，好形状。文档注释把"为什么角色不是 leftover"与 fail-closed 边界写清。
- **验证真实性**：RED-1 COLLECTION_ERROR（缺 `RESEARCH_ROLES` named export）与 RED-2 的 9 fail 签名（kind=connector、pages=0、searches=undefined）逐条对应缺失功能，与 U04 偏差 D4（明确不预建角色词表）衔接自洽；时间序 RED(23:37)→GREEN(23:40)→after-diff(23:46) 成立。全部回归数字我已独立复现。

**结论：无 critical/high/medium 代码缺陷。Code quality 无保留。**

## Findings

- **F1（P3，证据文档瑕疵，已有 P3-1 登记，确认成立）**：implementer 报告 §6"直接消费面回归 41/41"的命令行写成单条 `bunx e2e run … skill-form / browser-activity / tool-result / shared/research`，实际需两次调用（app 三文件 `E2E_UNIT_SCOPE=app` 28/28 + `E2E_UNIT_SCOPE=shared` 的 shared/research 13/13；且三件为 `.ts` 非 `.tsx`）。数字本身正确（本人按两 scope 亲跑复现 28+13），纯标注瑕疵，不改代码。验证者 P3-1 定级恰当。
- **F2（Obs，不处理）**：completed fetch 的 pages 保留 `Math.max(urls.length, 1)` 下限——completed 且 args 无任何 URL 时计 1 页。相对上游（无条件计数）已是真实修正，"completed 即返回、返回即读过"的语义在代码注释里成立，且服务端 web_fetch 无 URL 必失败（R02 范围），该边缘实际不可达。留观即可，不构成缺陷。
- **F3（Obs，记账修正）**：brief 中"本地现状 tool-name.ts（152 行）/form.ts（84 行）"与真实前置状态不符——before-tracked.diff 显示两者与 HEAD 一致（实测 113 行/80 行；152 疑为上游文件 153 行之误）。brief 系主控撰写，实现者报告未传播该数字，零实现影响；在此登记供账本勘误。
- **F4（Obs，处置恰当性确认）**：两处 zh 英文回退（`chat-transcript.tsx:1390` 的单条研究调用行、`bot-profile/access.tsx:53` 的 Bot 授权页）均非 owned、以 `readToolName(...).label` 直用不消费 `labelKey`，zh 下显示英文角色标签。实现者列为偏差①②、验证者列为 INFO-1 并建议集成轮处置——**该处置正确**：属本地化覆盖面缺口而非行为缺陷（匿名性不受影响，回退串即设计上的 en 兜底），修复是机械改动（两处消费点补 `labelKey` 翻译参数），必须在集成轮/V01 待办中显式跟踪，不应散落在任务报告里丢失。
- **F5（Obs，接受）**：`researchSearch`/`researchFetch` 键在 channels.json 与 skills.json 各存一份。两 namespace 由不同 `TFunction` 消费，各自自包含是本仓库 i18n 组织的既定形状；测试已钉两语言词条存在性。可接受，不建议为此引入共享 namespace。
- **F6（Info，主控动作项）**：ledger §5 的 R03 行仍为 pending；本 review 通过后由主控更新为 verified 并回填证据路径（对齐 R01/R02 行格式）。
- **交叉核对结论**：两报告之间无矛盾；implementer 报告 §1/§2/§3 的全部具体声明（键数、标签矩阵、豁免语义、测试计数、RED/GREEN 数字）与源码和亲跑结果一致；validator 报告的 5/5 PASS、diff 范围机比（tracked +6 文件、untracked +2 文件恰为 owned）、mtime 窗口核验均独立复现成立。R02-F1 闭环引用属实（store.ts:5066 修复在当前树亲读确认）。

## 验收判定

Task R03（A10 前端半部）达到验收标准：行为双层亲跑全绿且断言逐项属实，skill 选择对合法角色豁免且错拼 fail-closed，页数只从真实返回计数、来源与原因保留、未知工具原名，三处共享角色一致，旧 Parallel ref 兼容，范围恰为 owned 文件，无未披露偏差。

Spec compliance: pass
Code quality: pass
