Review complete: 16 finding(s) across 48 selected item(s).

─── scripts/iso-login.html:10-11 ───
[security · low] 两处错误展示均用 innerHTML 拼接服务端响应体/异常对象。`await r.text()` 是完全由 127.0.0.1:3002
侧控制的内容(例如代理错误页、被劫持的本地端口返回的 HTML),一旦包含标签/脚本就会被当作 HTML 在本页源(file:// 或
127.0.0.1:3011)下执行。虽是手动用途的本地辅助页、实际风险低,仍建议改用 textContent 渲染,彻底规避 HTML 解析路径。

- .then(async r=>{ if(!r.ok){document.body.innerHTML=`<pre>登录失败: ${await r.text()}</pre>`;return;} location.href='http://127.0.0.1:3011/'; })
- .catch(e=>document.body.innerHTML=`<pre>${e}</pre>`);
+ .then(async r=>{ if(!r.ok){document.body.textContent=`登录失败: ${await r.text()}`;return;} location.href='http://127.0.0.1:3011/'; })
+ .catch(e=>document.body.textContent=String(e));


─── scripts/iso-login.html:6-6 ───
[bug · low] 页面含中文文案但未声明编码(无 <meta charset>,也没有 charset 的 Content-Type 依赖保证)。该页典型用法是直接 file://
打开或手动拷回 public/,此时浏览器可能回退到 locale 相关的默认编码,导致「正在登录测试环境…」等文案乱码。建议在 <head> 中显式声明 UTF-8(需位于前 1024 字节内)。

- <html lang="zh-CN"><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
+ <html lang="zh-CN"><head><meta charset="utf-8"></head><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">


─── docs/verification/workspace-redesign/final-closure-r7/ocr-repair/POST/scripts_iso-login.html:10-11 ───
[documentation · low] 该 POST 快照当前与 scripts/iso-login.html 逐字节一致,记录本身无误。但快照含与已确认 findings 相同的
innerHTML 渲染与缺失 charset 问题——快照作为验证记录不可单独"修复";正确做法是:按 findings 修复 scripts/iso-login.html 后,同步重新生成本
POST 快照(以及相应审计 JSON),否则 final-closure-r7 的验证记录会与实际文件脱节。



─── app/src/components/routines/routines-list.tsx:433-435 ───
[maintainability · low] aria-label 重复声明：DropdownMenuTrigger 与其 render 内的 Button 同时声明了
`aria-label={t("actions.moreActions")}`。dropdown-menu.tsx 的 mergeRenderProps 以 `{ ...domProps,
...elementProps }` 合并（render 元素属性优先），trigger 上这份永远是死属性；当前两处文案相同所以无行为差异，但日后若只改其中一处，实际生效的只有 Button
那份，易造成困惑。项目内同类先例（voice-call-widget.tsx、connected-accounts/$key.tsx、skills.tsx）均只在 render 的 Button
上声明 aria-label，建议与此保持一致，仅保留 Button 上的一份。

                          <DropdownMenuTrigger
-                           aria-label={t("actions.moreActions")}
                            render={
+                             <Button
+                               aria-label={t("actions.moreActions")}
+                               size="icon"
+                               type="button"
+                               variant="ghost"
+                             >
+                               <IconDots aria-hidden="true" />
+                             </Button>
+                           }
+                         />


─── docs/verification/workspace-redesign/execution/checkpoints/ocr-r4-t05/POST/files/app/tests/routines-list.tsx:1-8 ───
[other · low] 该 POST 快照工件内容与目标路径错位：路径声称记录 `app/tests/routines-list.tsx`，但仓库中并不存在该文件（真实的测试文件是
`app/tests/routines-list.test.tsx`），且本快照内容与同批组件源码快照
`POST/files/app/src/components/routines/routines-list.tsx`（548 行）逐字相同——是组件源码的副本而非任何测试文件的内容。作为
ocr-r4-t05 的验证记录，它会误导后续审计（看起来像存在一个内容与组件相同的 app/tests 文件，且缺失了真实测试文件的 POST
状态）。建议核对校验工具的抓取映射后重新生成此快照，或将其更正为对应路径的真实文件内容。



─── app/src/components/computer/demonstration-recorder.tsx:185-185 ───
[documentation · low] 本次将 ONLY_CONVERSATION 从 "" 改为 "__only_conversation__" 并初始化为选中值后，同一 Select 中
onValueChange 内的注释（第 175–178 行）未同步更新，仍在解释 "" is not that — it is BASE's own `<option
value="">`。空字符串现在已不承载任何业务语义（仅代表 React Aria 关闭列表的 null 之外不存在），该注释会误导后续维护者以为空字符串仍是可选哨兵。建议将注释改为指向
ONLY_CONVERSATION 常量，保持"双向选择"解释准确。

-             <SelectValue />
+             // The H05/H06 null guard means one thing only: closing the list without choosing
+             // keeps the schedule as it was. ONLY_CONVERSATION ("__only_conversation__") is not
+             // that — it is the internal sentinel item ("report in this Bot's only conversation"),
+             // a real item that stays selectable after a channel was picked, so the choice
+             // remains two-way.


─── app/src/components/computer/demonstration-recorder.tsx:125-128 ───
[maintainability · low] 新增的 items 映射经 Object.fromEntries 处理后命中 any 重载：SCHEDULES.map 的回调返回
string[]（非元组），数组字面量整体为 string[][]，不满足 fromEntries 的 Iterable<readonly [PropertyKey, T]> 重载，回退到返回 {
[k: string]: any }。结果是 items 的值失去类型约束——若未来某个 cron 键（如 "custom"）与 SelectItem 的 value
拼写不一致，不会有任何编译期提示，触发器将静默渲染原始 value。建议给 map 回调加显式元组返回类型、字面量断言为元组，使 fromEntries 收敛到 Record<string,
string>。

            items={Object.fromEntries([
-             ...SCHEDULES.map((option) => [option.cron, t(option.label)]),
-             ["custom", t("demonstration.customCron")],
+             ...SCHEDULES.map(
+               (option): [string, string] => [option.cron, t(option.label)],
+             ),
+             ["custom", t("demonstration.customCron")] as [string, string],
            ])}


─── docs/verification/workspace-redesign/final-closure-r7/ocr-repair/POST/app_src_components_ui_combobox.tsx:123-128 ───
[documentation · low] 该 POST 快照与被记录的真实源码（app/src/components/ui/combobox.tsx）已发生漂移：快照注释断言 "React Aria
excludes the popover's own trigger from its outside-press dismiss"，而当前源码中同一段注释已修订为相反结论 —— "the
pinned React Aria Popover has no trigger exclusion, so this handler may not even see those"（关闭实际由模态
underlay 的外压路径处理，另有 happy-dom fireEvent/键盘激活等直接派发路径）。代码行本身一致，但作为 final-closure
验证记录，快照对库行为的机理说明与源码相矛盾，会误导后续维护者。建议将此快照同步为当前源码的注释文本，保持验证记录与被记录源码逐字一致。



─── app/src/components/ui/switch.tsx:104-109 ───
[bug · low] connectInput 的 change 监听缺少清理路径，与注释宣称的 "stable ref callback"
不完全一致：当依赖（ariaLabel/id/inputRef）任一变化时，React 会先以 null 调用旧回调、再以元素调用新回调——旧回调闭包中挂载的 change
监听不会被移除，新回调在同一元素上再挂一个，每次依赖变化在同一 hidden input 上叠加一个监听（例如 aria-label 来自 i18n
文本时，语言切换即触发）。若未来调用方传入内联函数形式的 inputRef，useCallback 完全失效，将退回"每次渲染叠加一个监听"——恰是注释声称已修复的问题。项目使用 React
19.2，ref callback 支持返回清理函数，建议利用该机制在重挂/卸载时移除监听，彻底消除叠加路径。

        if (element) {
-         element.addEventListener("change", () => {
+         const mirrorChange = () => {
            element.setAttribute("aria-checked", String(element.checked));
            element.toggleAttribute("data-checked", element.checked);
-         });
+         };
+         element.addEventListener("change", mirrorChange);
+         // React 19 ref cleanup: runs on unmount and before a re-attach with a
+         // changed callback, so no listener ever stacks on the same input.
+         return () => {
+           element.removeEventListener("change", mirrorChange);
+         };
        }


─── app/src/components/ui/field.tsx:266-270 ───
[maintainability · low] 单一布尔注册标志对同一 Field 下并存的多个 FieldError 不健壮：每个 FieldError 挂载时
setPresent(true)、卸载时 setPresent(false)，若同一 Field 内同时存在两个有内容的 FieldError（例如一个用 children、一个用
errors），任一卸载会把 hasError 置 false，仍渲染的错误随即失去 aria-describedby 引用——回到本次改动要消除的悬空/缺失引用问题。当前全库调用点均为"一
Field 一 FieldError"（gateway.tsx:225/241 分属不同 Field），无现行 bug，但作为共享组件的注册契约，建议将布尔升级为计数（或注册 id
集合），使标志反映"存活实例数 > 0"。另注：useEffect 在提交后才置位，错误首帧可见但尚未被 describedby 引用，属可接受的一帧时序，无须处理。

-   useEffect(() => {
-     if (!setPresent || !content) return;
-     setPresent(true);
-     return () => setPresent(false);
-   }, [setPresent, content]);
+ // Field.tsx — 计数而非布尔，多实例并存时任一卸载不清空他人注册
+ const [errorCount, setErrorCount] = useState(0);
+ const context = useMemo(
+   () => ({
+     errorId,
+     setPresent: (present: boolean) =>
+       setErrorCount((count) => Math.max(0, count + (present ? 1 : -1))),
+   }),
+   [errorId],
+ );
+ // aria-describedby 条件改为 invalid && errorCount > 0


─── docs/verification/workspace-redesign/execution/checkpoints/ocr-r3-t02/PRE/files/app/src/components/ui/item.tsx:185-185 ───
[bug · high] ItemMedia 的 className 被静默丢弃：cva 工厂只消费在 variants 中注册的键（此处仅 variant），把 className 塞进 cva
参数对象不会生效，会被静默忽略。实际后果已可观测：真实源码 app/src/components/ui/item.tsx:191 同样存在该写法，调用点
app/src/components/layout/row-mark.tsx 的 RowMark 显式向 ItemMedia 传 className（"size-9 rounded-lg
bg-ob-muted-surface/60 …" 磁贴样式），整串类完全失效，磁贴退化为裸图标——共享 wrapper 的 className 透传合同被破坏且无任何告警。应对照同文件 Item
的正确用法 cn(itemVariants({ … }), className)，把 className 移出 cva 参数、单独传给 cn。

-       className={cn(itemMediaVariants({ variant, className }))}
+       className={cn(itemMediaVariants({ variant }), className)}


─── docs/verification/workspace-redesign/execution/checkpoints/ocr-r3b-item-class-test/POST/files/app/src/components/ui/item.tsx:191-191 ───
[bug · high] ItemMedia 的 className 被静默丢弃：cva 工厂只消费在 variants 中注册的键（此处仅 variant），把 className 塞进 cva
参数对象不会生效，会被静默忽略。该缺陷在真实源码 app/src/components/ui/item.tsx:191 同样存在，属本批 OCR 修复（r3b 的 mergeItemProps
顺序修复）未覆盖的残留：实际调用点 app/src/components/layout/row-mark.tsx 的 RowMark 显式传 className（"size-9 rounded-lg
bg-ob-muted-surface/60 …"），整串磁贴样式类完全失效，共享 wrapper 的 className 透传合同被破坏且静默无告警。应对照同文件 Item 的正确用法
cn(itemVariants({ … }), className)，把 className 移出 cva 参数、单独传给 cn。

-       className={cn(itemMediaVariants({ variant, className }))}
+       className={cn(itemMediaVariants({ variant }), className)}


─── docs/verification/workspace-redesign/execution/checkpoints/ocr-r3b-item-class-test/POST/files/app/src/components/ui/item.tsx:9-10 ───
[bug · low] ItemGroup 声明 role="list"，但子项 Item 默认渲染无 role 的 div（或经 render 变为 button/a），缺少
role="listitem"，违反 ARIA list 必须拥有 listitem 子项的结构约束，屏幕阅读器无法将各行识别为列表项。真实源码
app/src/components/ui/item.tsx 第 9 行同样存在（PRE 快照亦同）。由于 Item 常经 render 变为交互元素（button 语义不应被 listitem
覆盖），建议移除 ItemGroup 的 role="list"，或仅为默认 div 分支补 role="listitem"。

-       role="list"
        data-slot="item-group"


─── docs/verification/workspace-redesign/final-closure-r7/ocr-repair/POST/app_src_components_ui_switch.tsx:104-109 ───
[bug · medium] 此 change 监听器没有任何清理路径：`connectInput` 的依赖是 `[ariaLabel, id, inputRef]`，当依赖变化时 React 会先用
`null` 调用旧回调、再用同一 hidden input 调用新回调——旧回调不会移除已注册的监听器，新回调又 `addEventListener`
一次，即每次依赖变化都在同一元素上叠加一个监听器。若调用方传入未 memo 的内联 `inputRef` 函数，依赖每次渲染都变，监听器将逐渲染堆积——这正是上方注释声称已通过 useCallback
解决的问题，该"稳定性"保证并不成立。建议在回调重入时移除上一次注册的监听器（或利用 React 19 的 ref cleanup 返回清理函数）。注意：该问题同样存在于被记录的真实源码
app/src/components/ui/switch.tsx 中。

+   const lastListener = useRef<{
+     element: HTMLInputElement;
+     onChange: () => void;
+   } | null>(null);
+   const connectInput = useCallback(
+     (element: HTMLInputElement | null) => {
+       // Detach the previously registered mirror listener before (re)attaching,
+       // so a re-run after a dep change never stacks a second one.
+       if (lastListener.current) {
+         lastListener.current.element.removeEventListener(
+           "change",
+           lastListener.current.onChange,
+         );
+         lastListener.current = null;
+       }
+       hiddenInput.current = element;
+       if (element && id) {
+         element.id = id;
+       }
+       if (element && ariaLabel) {
+         element.setAttribute("aria-label", ariaLabel);
+       }
+       if (typeof inputRef === "function") inputRef(element);
+       else if (inputRef) inputRef.current = element;
        if (element) {
-         element.addEventListener("change", () => {
+         const onChange = () => {
            element.setAttribute("aria-checked", String(element.checked));
            element.toggleAttribute("data-checked", element.checked);
-         });
+         };
+         element.addEventListener("change", onChange);
+         lastListener.current = { element, onChange };
        }
+     },
+     [ariaLabel, id, inputRef],
+   );


─── docs/verification/workspace-redesign/final-closure-r7/ocr-repair/POST/app_src_components_ui_field.tsx:277-280 ───
[bug · low] 自定义 `id` 会制造悬空引用：`Field` 的 `aria-describedby` 始终追加内部生成的 `field.errorId`，而 `FieldError`
渲染 `id={id ?? field?.errorId}`——一旦调用方传入自定义 `id`，描述引用仍指向不存在于 DOM 的 `errorId`，恰好是该机制注释（"naming an
absent id hands assistive technology a dangling reference it silently drops"）声称要避免的情况。当前代码库无调用方传
`id`，属潜在 API 不一致；建议注册机制上报实际渲染的 id（如把 `setPresent` 换成 `setRegisteredId(id ??
field.errorId)`），或在类型/文档上禁止与 Field 内部引用同时使用自定义 id。注意：该问题同样存在于被记录的真实源码
app/src/components/ui/field.tsx 中。



─── docs/verification/workspace-redesign/current-authorized-r6/browser-final-check/route-smoke-1440x900.json:48-55 ───
[test · low] P02（/channel/new）是本批改动唯一涉及的产品页面，但在这份 browser-final-check 工件中 bodyText 为空、main 为
false、lang 为 "en"，与其余正常渲染 zh-CN 内容的页面明显不一致。结合 consoleAndPageErrors 中大量
500/ERR_CONNECTION_REFUSED，页面很可能停在组件的 `if (profiles === undefined && !rosterError) return null`
加载门控上，即最终浏览器检查并未实际渲染并验证到该改动页面，工件作为最终验证证据存在缺口。建议在环境恢复后重跑该路由的捕获（或以截图/e2e 结果补充），确认 P02 有实质渲染内容后再作为
final-check 证据归档。



LLM retry report summary: 4 of 147 requests affected -- 1 request cancelled, 3 requests recovered after retry

Core review (3 requests):
- app/src/components/computer/demonstration-recorder.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r6-t07/POST/files/app/src/components/computer/demonstration-recorder.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r6-t07/PRE/files/app/src/components/computer/demonstration-recorder.tsx: rate limited (HTTP 429) -> succeeded
- docs/verification/workspace-redesign/execution/checkpoints/ocr-r3-t02/PRE/files/app/src/components/ui/field.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3-t02/PRE/files/app/src/components/ui/input.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3-t02/PRE/files/app/src/components/ui/item.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3-t02/PRE/files/app/src/components/ui/questionnaire.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3b-item-class-test/POST/files/app/src/components/ui/field.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3b-item-class-test/POST/files/app/src/components/ui/input.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3b-item-class-test/POST/files/app/src/components/ui/item.tsx,docs/verification/workspace-redesign/execution/checkpoints/ocr-r3b-item-class-test/POST/files/app/src/components/ui/questionnaire.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded
- docs/verification/workspace-redesign/final-closure-r7/ocr-repair/POST/scripts_iso-login.html,docs/verification/workspace-redesign/final-closure-r7/ocr-repair/PRE/app_public___iso-login.html,scripts/iso-login.html: rate limited (HTTP 429) -> rate limited (HTTP 429) -> succeeded

Context compaction (1 request):
- docs/verification/e2e-bun-suites.json,docs/verification/workspace-redesign/execution/checkpoints/ocr-r2-runner-r1/POST/files/docs/verification/e2e-bun-suites.json,docs/verification/workspace-redesign/execution/checkpoints/ocr-r2-runner-r1/PRE/files/docs/verification/e2e-bun-suites.json,docs/verification/workspace-redesign/execution/checkpoints/ocr-r2-runner-r1/PRE/files/e2e-file-audit-R2A-PRE.json,docs/verification/workspace-redesign/execution/checkpoints/ocr-r2-runner/PRE/files/docs/verification/e2e-bun-suites.json: cancelled

Per-attempt detail: --format json (retry_report).
