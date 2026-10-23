# OCR Repair Round 2 — 独立复审报告(Spec compliance + code quality)

**Date:** 2026-10-23 · **Reviewer:** 独立只读复审(未改文件、未跑测试套件、未执行 git 写命令)
**对象:** `docs/plans/reports/2026-10-23-ocr-repair-impl.md` 所述 6 项修复
**依据:** 分诊表 `docs/verification/workspace-redesign/ocr/2026-10-23-b1-triage.md`;证据树 `docs/verification/workspace-redesign/final-closure-r7/ocr-repair/`(PRE/POST/pre-red/post-green/native-full/driven)

## 证据链完整性(前置核验)

- POST 副本与工作树逐字节一致:8 个文件的 SHA-256 全部匹配(`POST/SHA256SUMS.txt` vs 现算值)。
- PRE 副本 SHA 与实现报告表格逐项一致;PRE→工作树 diff 与报告披露的改动面完全吻合,无未披露生产改动。
- 运行证据:`pre-red` summary `selected 3 / passed 0 / failed 3`;`post-green` `3/3`;`native-full` `1014/1014`(run.vcs.commit `f55d12f899`,dirty=true,与 worktree 状态一致);`driven` `6/6`。与实现报告验证表逐项吻合。
- Round-2 时间窗边界(mtime 证据):03:57:01–03:58:42 之间仅触碰 checkbox.tsx、skills.tsx、field-describedby.test.tsx、combobox.tsx、field.tsx、skills-edit-target.test.tsx、switch.tsx、scripts/iso-login.html 共 8 个文件。git status 中其余已改文件(channel/new.tsx 01:45、questionnaire 02:09、item 02:11、ui-wrapper-merge.test 02:20、routines-list 02:27、experiments-section 02:34、demonstration-recorder 02:41)均早于本轮窗口,对应 round-1 修复(2026-10-23-b1-ocr-repair-01..06 计划/报告已存在),不属于本轮改动面。

---

## Spec 轴

### S1 — 六项对应与清单外改动:PASS

- 6 条修复与分诊表"有效 → 修复"6 条一一对应,逐条 diff 核对:
  1. iso-login 移出 public/(sec-med):`app/public/` 现为空,`scripts/iso-login.html` 在位;
  2. skills.tsx key(`app/src/routes/_authed/_app/skills.tsx:123,137`);
  3. checkbox 死类移除(`app/src/components/ui/checkbox.tsx:73`);
  4. switch 注释修正 + 死类移除 + useCallback(`app/src/components/ui/switch.tsx:36-39,83-113,119-123`);
  5. field.tsx 存在性上报(`app/src/components/ui/field.tsx:27-30,107-111,261-270`);
  6. combobox 切换语义(`app/src/components/ui/combobox.tsx:128`)。
- 两个披露偏差均属实且最小:
  - iso-login lint 修复:diff 仅含 doctype 之后的注释插入、`lang="zh-CN"`、两处字符串拼接→模板字面量(输出字节等价),fetch/redirect/凭据逻辑未动;
  - combobox/field 整文件格式化:diff 中除披露的语义改动外仅为 import 重排与折行,与 `bunx biome check --write`(safe fixes)的描述一致。
- 无清单外生产改动(见前置核验的时间窗证据)。

### S2 — skills key 修复保持草稿语义 + 先红后绿:PASS

- `draftKey`(:81-85)、`currentDraft`(:91)、`saveDraft`(:95-97)逻辑未动;PRE diff 仅新增 :123 `key="new"` 与 :130-137 注释+`key={editingSlug}`。
- 草稿语义保持:alpha→beta 切换后 `skillDraft.key="edit:alpha"` ≠ `draftKey="edit:beta"` → `currentDraft` 为 undefined → 新挂载表单吃 beta 默认值;回切 alpha 时 currentDraft 重新命中,草稿恢复行为与 PRE 一致。
- 新测试经生产 seam:`app/tests/skills-edit-target.test.tsx:170-184` 用 `SkillsRoute.update({...})` 挂真实路由组件,无手植 key。
- RED 证据可查:`pre-red/results/skills-edit-target-test-switching-the-edit-target-starts-6e689a557f447db2/trace.md` 记录 `expected "Alpha skill (dirtied)" to be "Beta skill"`;run summary 0/3 → `post-green` 3/3。与报告引用逐字一致。

### S3 — field 存在性上报与 dialog 模式同构 + 不回归:PASS

- 同构性:`field.tsx:261-270` 的 effect(claim `setPresent(true)` / cleanup `setPresent(false)`)与 `dialog.tsx:537-554`(`DialogDescriptionContext` 的 `Dispatch<SetStateAction<boolean>>` + 同形 effect)同构,并正确适配了 FieldError 可为空的差异(`!content` 早退,不注册)。
- 有 FieldError 场景行为不变:content-bearing FieldError 挂载后 `invalid && hasError` → `aria-describedby` 仍含相同 errorId。
- 既有断言覆盖确认:`app/tests/ui-wrapper-merge.test.tsx:18-37` 的"invalid + FieldError → describedby 含 existing 与 alert id"断言保留且仍绿(native-full 含该文件,1014/1014);新 `field-describedby.test.tsx` 补的是无效-无-FieldError 与空-FieldError 两条负分支,属纯增量,无覆盖面回归。
- 非阻塞备注(info):describedby 现在比首次渲染晚一个 effect tick 才含 errorId——与 dialog.tsx 既有设计同性质,可接受;单 Field 挂两个 content-bearing FieldError 时后卸载者会提前释放槽位——dialog 模式同款边界,单错误为主流用法,不构成缺陷。

### S4 — combobox 切换语义:PASS(问题问题本身:无破坏),但带一个 medium finding(见 Finding 1)

- `open` 状态全部写点:仅两处——trigger `onClick`(:128)与 Popover `onOpenChange={setOpen}`(:144)。组件无外部受控 open API(Props 接口无 `isOpen`),不存在受控冲突;键盘路径(input autoFocus、Escape 经 RAC overlay 处理)未触碰;多选/commit 路径不写 `open`。
- 功能更新式 toggle 不引入双重翻转竞态:关闭态点击 → `!false=true`,与原 `setOpen(true)` 等价。
- 但切换语义的**前提与注释所述机制在锁定的 RAC 版本中不成立**,详见 Finding 1。

#### Finding 1 — medium — combobox.tsx:123-127 注释断言的库机制在锁定版本中不存在;toggle 在 open 态路径上不可达

证据(读的是安装源码,非回忆):

- `combobox.tsx` 组合的是裸 `Popover`(react-aria-components 1.22.1),**未传 `isNonModal`** → `usePopover`(node_modules/.bun/react-aria-components@1.22.1…/node_modules/react-aria/dist/private/overlays/usePopover.mjs)走默认 modal 分支:全屏 underlay(`<div data-testid="underlay" position:fixed inset:0>`)+ `ariaHideOutside([popoverRef], {shouldUseInert:true})`(trigger 被 inert 且被 underlay 覆盖)。RAC 自家 ComboBox 给 Popover 传的是 `isNonModal: true`(dist/private/ComboBox.mjs),本适配器没有。
- `useInteractOutside`(react-aria/dist/private/interactions/useInteractOutside.mjs)的 `isValidEvent` 只排除 popover 自身子树与 `[data-react-aria-top-layer]`,**没有任何 trigger 排除逻辑**;`useOverlay`/`usePopover`/RAC `Popover` 亦无。新注释"React Aria excludes the popover's own trigger from its outside-press dismiss"在 pinned 依赖里找不到对应实现。
- 运行时推演:popover open 时按下 trigger 位置 → 事件目标是 underlay(文档级 capture 监听器可见)→ outside-press dismissal 关闭 popover;按钮自身 `onClick` 不触发(toggle 不可达)。PRE 与 POST 在这条路径上的可观察行为相同(都是关)。即便假设 trigger 可达,RAC outside-press 的 click 处理器 `stopPropagation`(capture@document)也会吞掉按钮的冒泡 onClick,toggle 依旧不执行。
- 推论:分诊第 6 条的运行时前提("触发恒开无法点击关闭")可疑——按安装源码,open 态点 trigger 本就经 underlay dismissal 关闭;本次 toggle 很可能是无害的 no-op。修复方向若真要 trigger 关闭,应评估 `isNonModal`(对齐 RAC 自家 ComboBox),属本轮范围外的后续决策。
- 缓解:改动本身零回归(见上),且 open 态 trigger 点击路径无任何测试覆盖(`channel-new-recipients.test.tsx:282` 仅从关闭态点击一次,报告如实披露"no test asserted the always-open behaviour"),native 1014/1014 不能证明也不能证伪该行为。
- 建议:真实浏览器验证一次 open 态点 trigger 的实际行为;无论结果如何,把 :123-127 注释改为可由锁定版本源码佐证的表述(或先补 `isNonModal` 决策再写注释)。

### S5 — switch theme-contract 判断:PASS

- 自核 `docs/design/2026-10-20-workspace-redesign/handoff/refinement/theme-contract.json`:grep `switch|track|teal` 零命中;token 表全为 `--ob-*` 颜色/表面 token,无 32×18.4 轨道尺寸、无 teal ON 色。"无 switch 硬性约定"的判断成立。
- `--ob-brand → --ob-action`(#315FCF 蓝)在 `app/src/styles/tokens.css:27,102` 确认。
- `.ob-switch` 规则全仓(src/、styles)不存在,仅存于解释性注释;PRE 注释确曾声称 heroui-theme.css 有该规则(见 PRE 副本 :40-43),属过期声明。新注释(:36-39,119-123)表述与事实一致(删除声明而非发明样式,渲染零变化,因该类本无规则)。

### S6 — iso-login lint 级修复不改页面行为:PASS

- diff(PRE `app_public___iso-login.html` → `scripts/iso-login.html`):line 1 `<!doctype html>` 保留,注释插在 doctype 之后(合法位置,不触发 quirks mode);`<html lang="zh-CN">` 仅加属性;`'<pre>登录失败: '+await r.text()` 与 `'<pre>'+e+'</pre>'` 两处模板字面量转换输出字节等价;fetch URL/method/credentials/body、redirect 目标全部未动。
- `app/public/` 现为空目录,构建发布面已不含该页;头部注释明确禁止移回并说明手动用途。凭据本身仍是明文,但这正是该页的既定用途(手动本地环境),分诊项针对的是"随构建发布",移出即解。

---

## Quality 轴

### Q1 — 新测试与既有约定一致:PASS

- `skills-edit-target.test.tsx` 与 `skills-draft-lifecycle.test.tsx` 的 harness 几乎逐字同构:`./preload`、e2e-compat 的 `expect/test/after*`、`GlobalRegistrator` 生命周期、ResizeObserver Observer 垫片、`captureRouteState/restoreRouteState` 快照保护、memory router + QueryClient 预灌、fetch stub 后在 afterEach 还原(并保留 `preconnect`)。
- `field-describedby.test.tsx` 与 `ui-wrapper-merge.test.tsx` 同构(preload + GlobalRegistrator + afterEach cleanup)。
- 微小差异(info):前者 `register({ url: "http://localhost/" })`、后者 `register()`,无害。

### Q2 — useCallback inputRef 依赖与闭包:PASS

- `switch.tsx:112` deps `[ariaLabel, id, inputRef]` 与回调引用的外部值精确对应;`hiddenInput` 是 ref,正确省略。无 stale 闭包。
- info 备注:依赖变化触发 React 重连时(null → element),`addEventListener("change", …)`(:104-109)不摘旧监听,同一 input 上会叠加。此行为继承自 PRE 的内联版本(每渲染叠加,本轮已是净改善),且监听体幂等(setAttribute/toggleAttribute 同值),无行为危害;如后续要收口可加 `AbortSignal` 或具名 handler 清理。

### Q3 — FieldContext 扩展未破坏既有消费者:PASS

- `FieldContext` 未出现在 `field.tsx` export 列表(模块私有),全仓 grep 无 file.tsx 之外的消费者;类型变更不可能外溢。FieldError 的公共 props(errors/id/children/className)全部保留,调用面不受影响(dialog.tsx 模式同样只经 FieldError/DialogDescription 间接消费)。

### Q4 — 注释风格:PASS

- 四个生产文件的注释均为块式 /* */、解释 why 而非 what,与各自文件既有文风一致:switch.tsx 头注释记录了被删声明的来龙去脉(对齐该文件原有的历史注记风格);skills.tsx key 注释解释 `useForm` defaultValues 只在 mount 读的语义;checkbox/combobox 注释短促因果化。未发现复述代码的注释。

---

## 结论

- **Spec 轴:PASS** —— 六项修复与分诊一一对应、无清单外改动、披露偏差属实且最小、RED→GREEN 证据链完整可查、既有行为面无回归。S4 的注释机制声明问题(Finding 1)是对分诊前提的继承性缺陷,不构成本轮对分诊指令的偏离,记为后续跟进项(浏览器验证 + 注释修正,或 `isNonModal` 决策)。
- **Quality 轴:PASS** —— 测试 harness 与既有约定同构、useCallback 依赖正确、context 扩展无外溢、注释风格一致。两条 info 级备注(监听叠加、describedby 晚一 tick)均为继承自既有设计或模式的非阻塞观察。
