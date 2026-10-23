# B1 OCR Repair — Round 2 独立验证报告

**日期:** 2026-10-23 · **验证者:** frontend_validator(只读独立验证) · **对象:** `docs/plans/reports/2026-10-23-ocr-repair-impl.md`
**需求依据:** `docs/verification/workspace-redesign/ocr/2026-10-23-b1-triage.md`(6 条有效修复)
**本验证产物目录:** `…/ocr-repair/validation/`(v-field / v-native / v-driven 为本次新鲜复跑的 e2e report 目录)

---

## 1. 哈希核对

### 1.1 POST 清单 vs 工作树(独立重算 sha256)

对 POST 清单 8 个文件,逐一用 `shasum -a 256` 独立重算工作树对应文件并比对:

| 工作树文件 | POST 清单哈希 | 独立重算 | 一致 |
|---|---|---|---|
| `app/src/components/ui/checkbox.tsx` | `16635063…76b82e` | `16635063…76b82e` | ✓ |
| `app/src/components/ui/combobox.tsx` | `142680b8…7135c5` | `142680b8…7135c5` | ✓ |
| `app/src/components/ui/field.tsx` | `d8b80f60…ef112b` | `d8b80f60…ef112b` | ✓ |
| `app/src/components/ui/switch.tsx` | `ce8714b2…4ce161c9` | `ce8714b2…4ce161c9` | ✓ |
| `app/src/routes/_authed/_app/skills.tsx` | `31226c5d…2db89e20` | `31226c5d…2db89e20` | ✓ |
| `app/tests/field-describedby.test.tsx` | `56c6feeb…c02e4b791` | `56c6feeb…c02e4b791` | ✓ |
| `app/tests/skills-edit-target.test.tsx` | `71fa9bf3…2c02e4b791` | `71fa9bf3…2c02e4b791` | ✓ |
| `scripts/iso-login.html` | `67a7a179…563d37ea00e` | `67a7a179…563d37ea00e` | ✓ |

`shasum -c` 对 PRE 与 POST 两个 SHA256SUMS.txt 均全 OK(清单自洽)。**8/8 工作树文件与 POST 清单逐一吻合,交付面与证据面一致。**

### 1.2 PRE 副本溯源(附加核对)

- 6 个 PRE 副本中 **5 个与 `HEAD:<path>` 字节一致**(iso-login、checkbox、combobox、switch、skills)。
- **例外:`field.tsx` 的 PRE 副本 ≠ HEAD**(`89e0fb6b…` vs HEAD `af9e7b9d…`)。HEAD→PRE 差异仅为迁移期未提交改动:react import 排版、`Field` 签名排版、`forwardedProps` 先剥 `data-invalid` 再在 spread 后回填(修正属性覆盖顺序)。这些不是本轮修复内容(PRE→POST diff 另见 1.3),属工作树迁移状态快照,与实施报告"PRE 为修复前工作树状态、worktree 存在未提交迁移改动"的框架一致。**记录为透明性备注,非缺陷。**

### 1.3 PRE→POST diff 抽查(逐文件)

| 文件 | diff 实际内容 | 与报告所述 |
|---|---|---|
| checkbox.tsx | 删 `cn` import;`cn("ob-checkbox", className)` → `className={className}` + 注释 | 一致 |
| switch.tsx | 头注释改为真话(无 `.ob-switch` 规则);删 `ob-switch`;inline `inputRef` 回调整体迁入 `useCallback`(deps `[ariaLabel, id, inputRef]`),监听逻辑逐字未变 | 一致 |
| field.tsx | FieldContext 增 `setPresent`;`hasError` state;`aria-describedby` 改 `invalid && hasError` 门控;FieldError 增存在性 `useEffect`;头注释;import 扩容 | 一致 |
| combobox.tsx | `setOpen(true)` → `setOpen((value) => !value)` + 注释;其余仅 import 排序/换行(safe fixes,报告已披露) | 一致 |
| skills.tsx | 仅新增 `key="new"`(NewSkill)与 `key={editingSlug}`(EditSkill)+ 注释 | 一致 |
| iso-login(public→scripts) | 头部使用边界注释;`lang="zh-CN"`;两处字符串拼接→模板字面量 | 一致(报告已披露为对"内容不变"的最小机械偏离) |

**diff 抽查未发现报告未述及的改动。**

---

## 2. 新鲜复跑(本次验证独立执行,退出码与结果行如下)

| # | 命令 | 退出码 | 结果行 |
|---|---|---|---|
| a | `E2E_UNIT_OUTPUT=…/validation/v-field bunx e2e run --config e2e.unit.config.ts app/tests/field-describedby.test.tsx app/tests/skills-edit-target.test.tsx` | **0** | `Test Files 2 passed (2)` · `Tests 3 passed (3)` |
| b | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=…/validation/v-native bunx e2e run --config e2e.unit.config.ts` | **0** | `Test Files 134 passed (134)` · `Tests 1014 passed (1014)` |
| c | `E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=…/validation/v-driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | **0** | `Test Files 1 passed (1)` · `Tests 6 passed (6)`(6 组 bun runtime suite 全绿;"共享进程才红"的 8 文件由驱动层单独重跑后过,符合 ADR 0008 规则) |
| d | `bunx biome check <8 个改动文件>` | **0** | `Checked 8 files in 21ms. No fixes applied.` |
| e | `bun run --cwd app typecheck` | **0** | `tsc --noEmit` 干净退出 |

附加(对照实施报告第 6 条):`bun scripts/e2e-coverage-audit.mjs` → 退出码 **0**,`1082 suite files … 605 native e2e · 462 driven · 10 engine · 5 named exclusions`,`no gaps` —— 与报告数字逐项一致。

期望值核对:b = 134 文件/1014 全过 ✓,c = 6/6 ✓,均与实施报告声称相同。

---

## 3. 关键语义核实

**(a) `__iso-login` 残留** — `grep -rn '__iso-login' app/public/ scripts/` 零命中;`app/public/__iso-login.html` 在工作树已删除(`ls` 确认 No such file);目标文件 `scripts/iso-login.html` 存在,头部含使用边界注释:`Local isolated-environment login helper, for MANUAL use only: never move this back into app/public/ (files there ship in every build and this page carries throwaway test credentials)…`。**满足。**

**(b) 死类残留** — `grep -rn 'ob-checkbox\|ob-switch' app/src app/tests` 仅 3 处命中,全部位于解释性注释内(checkbox.tsx:70、switch.tsx:38/120),无任何 `className` 字符串使用这两个类。**零类使用残留,满足。**(注释中提及类名是实施报告自身披露的说明性文字,预期内。)

**(c) skills-edit-target 测试经生产 seam 驱动** — 测试源码无手工 `key`(仅 `restoreRouteState` 的对象键删除与注释含 "key");测试 import 生产 `Route as SkillsRoute` 并 `.update({ path, getParentRoute })` 挂入真实 TanStack router,`?edit=alpha` 载入 → 打字弄脏 → `router.navigate({ search: { edit: "beta" } })` → 断言 beta 标题、`data-dirty="false"`、POST payload `{slug:"beta", title:"Beta skill"}`。key 由生产代码 `skills.tsx` 提供(`key="new"` / `key={editingSlug}`)。**满足。**

**(d) field.tsx 存在性上报与 dialog.tsx 同构** — `dialog.tsx` 的 `DialogDescriptionContext`:context 携带 slot,`DialogDescription` 以 `useEffect(() => { if (!setPresent) return; setPresent(true); return () => setPresent(false); }, [setPresent])` 声明/释放。`field.tsx`:`FieldContext` 携带 `{ errorId, setPresent }`,`FieldError` 以同构 `useEffect` 声明/释放(deps 增 `content`,并加 `!content` 门控 —— 因 FieldError 可无内容渲染,dialog 的 Description 恒渲染,属正确适配)。`data-invalid` 行(`invalid || undefined`)未改动,样式侧行为不变。报告披露的"自定义 id 仍登记存在性而 describedby 指向 errorId 的错位保留"与源码一致(`id={id ?? field?.errorId}`)。**同构成立。**

**(e) combobox 切换语义与键盘路径** — 源码核实:`open` 单源(`React.useState(defaultOpen)`,行 75),trigger `onClick={() => setOpen((value) => !value)}`(行 128,带 RAC outside-press 豁免注释),Popover `onOpenChange={setOpen}`(行 144)指向同一 setter,无双源。PRE→POST diff 中对键盘路径(input autofocus、Escape 经 RAC)零触碰 —— 除 onClick 一行与注释外仅为 import 排序/换行。**未破坏键盘路径。**

**RED→GREEN 证据** — `pre-red/report.json` status=failed,skills trace 含报告原文 `expected "Alpha skill (dirtied)" to be "Beta skill"`;`post-green/report.json` status=passed。本次验证的 v-field 新鲜复跑 3/3 绿。

---

## 4. 与实施报告逐条对照

| 报告声称 | 验证结果 |
|---|---|
| POST 哈希表(8 项) | 全部吻合(§1.1) |
| 8 项 PRE→POST diff 只含所述改动 | 吻合(§1.3) |
| 修复 1: 移出 public/ + 边界注释 + 披露 3 处机械 lint 修复 | 吻合(§3a、§1.3) |
| 修复 2/3: 死类移除、注释纠偏、useCallback ref | 吻合(§1.3、§3b) |
| 修复 4: FieldError 存在性上报、仿 DialogDescriptionContext、custom-id 错位保留 | 吻合(§3d) |
| 修复 5: toggle + open 单源 + 键盘路径未动 | 吻合(§3e) |
| 修复 6: RED 先行(原文失败一致)、key 挂生产侧、测试走生产 seam | 吻合(§3c、RED 证据) |
| 聚焦 3/3 · native 134/1014 · driven 6/6 · biome 8 文件 · typecheck · 覆盖审计 1082/605/462/10/5 no gaps | 全部新鲜复跑复现,退出码全 0(§2) |
| "Files changed 5 + deletion; Files added 3" | 工作树状态相符(git status + ls 确认) |

### 不一致 / 备注

1. **[透明性备注,非缺陷]** 实施报告未点明 `field.tsx` 的 PRE 副本内容 ≠ HEAD(其余 5 个 PRE 副本 = HEAD)。PRE 为修复前工作树快照,差异属迁移期未提交改动,不影响本轮修复的正确性判定;但后续引用该 PRE 哈希作"HEAD 基线"时应注意此区别。
2. 无其他不一致。任务书 (a) 项预期"scripts/ 有目标文件"——目标文件为 `scripts/iso-login.html`(文件名不再含 `__iso-login`),grep 零命中即无残留,语义满足。

---

## 总结论

**PASS** — 哈希面(8/8 工作树吻合、清单自洽)、五项新鲜复跑(全绿、退出码全 0,期望值 134/1014 与 6/6 精确复现)、五项关键语义(a–e)全部满足;PRE→POST diff 未发现报告未述及的改动;与实施报告逐条对照仅一处透明性备注(PRE field.tsx ≠ HEAD,属迁移期快照,非修复内容)。
