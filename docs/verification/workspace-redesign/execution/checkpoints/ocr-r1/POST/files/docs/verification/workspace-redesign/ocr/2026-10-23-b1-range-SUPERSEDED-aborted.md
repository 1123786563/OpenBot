Review partially complete: 36 finding(s); 77 of 150 selected item(s) failed.

─── app/src/components/bot-profile/bot-subpage.tsx:46-50 ───
[maintainability · low] 重构后同一段"无法访问"错误提示 JSX
在同文件中出现两次（无数据出错分支与有数据但刷新出错分支），后续修改文案或样式需要双处同步，建议提取为局部变量复用。另外提示一点行为变化：agentQueryOptions 使用默认
staleTime（0），子页面重新挂载即触发 refetch；refetch 失败时 TanStack Query 会保留 data 并设置
error，此时代码会同时渲染"botSubpage.unreachable"提示与陈旧内容 children，而旧逻辑在 error
存在时完全隐藏内容。展示陈旧数据+错误横幅本身是合理模式，但"unreachable"（无法访问）文案与下方完整内容同屏语义略矛盾，建议确认该状态为有意设计，或为 stale 场景使用不同文案。

-           {agent.error ? (
+   // 在 return 前提取一次，两个分支复用
+   const unreachableAlert = (
-             <p className="mt-6 text-destructive text-sm" role="alert">
+     <p className="mt-6 text-destructive text-sm" role="alert">
-               {t("botSubpage.unreachable")}
+       {t("botSubpage.unreachable")}
-             </p>
+     </p>
+   );
+   // ...
+   {!agentData && !agent.isPending ? unreachableAlert : null}
+   {agentData ? (
+     <>
+       {agent.error ? unreachableAlert : null}
+       {children(agentData)}
+     </>
-           ) : null}
+   ) : null}


─── app/src/routes/_authed/_app/channel/new.tsx:128-133 ───
[bug · high] onSelectedChange 用 roster.filter 合成 ordered，会丢弃不在 roster 中的已选收件人。深链场景
`?agent=<隐藏Bot>`（不在可见 roster、经 fetched 单独加载，正是 57-74 行专门支持的"profile 链接分享隐藏同事"机制）下
selected=[fetched]；用户在 To: 字段勾选任意 roster Bot 时，新 Combobox 的 commit 基于 selected prop 保序回传 ids（含
fetched.id），但此处 `next = roster.filter(...)` 只保留 roster 内的 profile，fetched 被静默移除，且 navigate 将 URL
agent 改写为新勾选的 Bot——用户想与隐藏 Bot 组群聊，结果隐藏 Bot 从收件人中消失。旧 Base UI 实现通过 isItemEqualToValue 按 id 匹配，next 保留
fetched。建议基于 selected（而非 roster）保序合成：先保留 selected 中仍在 ids 里的项，再从 roster 补充新增项，使深链收件人得以保留。

            onSelectedChange={(ids) => {
              const idSet = new Set(ids);
-             const next = roster.filter((profile) => idSet.has(profile.id));
-             const ordered = ids
-               .map((id) => next.find((profile) => profile.id === id))
-               .filter((profile): profile is AgentProfile => profile !== undefined);
+             // Keep the URL-deep-linked Bot (which may be absent from the roster) in its
+             // picked order; only look up newcomers from the roster.
+             const ordered = [
+               ...selected.filter((profile) => idSet.has(profile.id)),
+               ...ids
+                 .filter((id) => !selected.some((profile) => profile.id === id))
+                 .map((id) => roster.find((profile) => profile.id === id))
+                 .filter((profile): profile is AgentProfile => profile !== undefined),
+             ];


─── app/src/components/channels/recipient-field.tsx:85-85 ───
[maintainability · low] RecipientField 组件在整个 app/src 中已无任何引用（仅剩本文件第 25 行的定义处，channel/new.tsx 现自行内联
To: 字段），本次还在为该死组件迁移 ob-* token。它也是 channels 目录下唯一残留 max-w-2xl（672px）的文件（46、81
行）。若确认后续任务无复用计划，建议连同本文件一并删除，避免死代码继续参与 token 迁移造成维护成本与列宽混淆。



─── app/src/components/channels/chat-transcript.tsx:1635-1635 ───
[maintainability · low] 聊天列宽硬编码为 max-w-[720px]（同样出现在 conversation-view.tsx 与 group-chat.tsx
的本批改动中，共三处），而 tokens.css 已按布局合同定义 --ob-layout-chat: 720px（light/dark 双主题，对应合同"配置列
720px"）。合同数值已有单一来源却未复用，后续调整 token 时三处硬编码会产生漂移。Tailwind v4 支持 max-w-(--ob-layout-chat) 直接引用 CSS
变量，建议三处统一改为 token 引用。

-             className="mx-auto w-full max-w-[720px] px-4 py-6"
+             className="mx-auto w-full max-w-(--ob-layout-chat) px-4 py-6"


─── app/src/components/ai-observability/experiments-section.tsx:110-124 ───
[maintainability · medium] 同一故障会在本页渲染两份提示：evaluations-page.tsx 将 ObservationDatasetsBody
与本区块并列，且两者使用同一个 observationDatasetsQueryOptions(botId)（相同 queryKey、共享同一份查询状态）；datasets-list.tsx 的
body 在 fault 时同样渲染 StateNotice（ai-observability-datasets
措辞）。本改动后，数据集查询故障（disabled/forbidden/unavailable）会在同一页面出现两条措辞不同的故障文案，既造成重复告警，也使同一故障的句子在两个命名空间里各自维护、易分
叉。建议：本区块在 fault 时保留 PageSection 框架（让"为什么不能提交"可被看见）但不再重复完整的故障句，或由页面层对同一查询统一持有一份故障展示。



─── app/src/components/ai-observability/run-steps.tsx:258-265 ───
[style · low] 新增代码使用宽松相等 == null，违反项目强制的 ===/!== 规范。RunStep 的类型为 input?: SafeValue | null（可空且可选），语义是
null|undefined 判空，且与 experiment-results.tsx 中 sample.usage === null || === undefined
的严格写法不一致。建议改为显式严格判断。

              const inputText =
-               step.input == null
+               step.input === null || step.input === undefined
                  ? null
                  : projectedValueText(step.input, t("marker.truncated"));
              const outputText =
-               step.output == null
+               step.output === null || step.output === undefined
                  ? null
                  : projectedValueText(step.output, t("marker.truncated"));


─── app/src/components/ai-observability/run-steps.tsx:267-272 ───
[maintainability · low] 载荷折叠区把输入与输出仅用 "\n" 拼进同一个 <pre>，没有任何标签或分隔。展开后两段任意
JSON/文本相邻排布，读者无法区分哪段是输入、哪段是输出；当只有一侧存在时，也无法判断缺失的是哪一侧。建议为两段分别加标签（需同步在 en/zh-CN 的 ai-observability-runs
中补充 input/output 标签词条）或至少渲染为两个有边界的独立块。

              const payload = [inputText, outputText]
                .filter((value): value is string => value !== null)
                .map((value) =>
                  value.length === 0 ? t("detail.steps.emptyValue") : value,
                )
+               // 建议改为分别带标签的两段（新增 input/output 标签词条），例如：
+               // [label("input", inputText), label("output", outputText)].join("\n\n")
                .join("\n");


─── app/src/components/ai-observability/exports-status.tsx:204-206 ───
[maintainability · low] 跨命名空间取键与既定归属约定相悖：ai-observability-admin 的 meta.ownedBy 声明 "#42 (admin
summary, ingest faults, export status)"，且其 exports 区已完整持有 errorCodes/link/states 等全部导出状态文案（本文件其余
exports 文案均取自默认 admin 命名空间）；runs-list.tsx 的注释也明确"导出状态文案归 admin 命名空间"。而新键 exports.showError 却被放进
ai-observability-evaluations（ownedBy #36 #37，实验提交/结果/对比），迫使这里用 ns 覆盖跨包取词，导出文案被拆散到两个命名空间。建议将
showError 词条移入 admin 的 exports 区，去掉 ns 覆盖。

                <summary className="w-fit cursor-pointer text-primary underline underline-offset-4">
-                 {t("exports.showError", { ns: "ai-observability-evaluations" })}
+                 {t("exports.showError")}
                </summary>


─── app/src/components/ai-observability/experiment-results.tsx:383-383 ───
[other · low] 评分独立为常显行后，"Score unavailable" 会在同一行出现两次：当 reason 非 scored 且 sample.score === null
时（执行失败/仍在跑等类别的常态），reasonText 的推导本身就以 t("sample.scoreUnavailable") 开头（见上方非 scored
分支），折叠详情里会再次展示同一文案。建议让新增的评分行独占"无评分"这一事实，在 reasonText 的非 scored 分支去掉 scoreUnavailable 段，避免重复。



─── app/public/__iso-login.html:5-5 ───
[security · high] 明文测试凭据（workspace-test@local.test / [redacted exposed test credential]）硬编码并提交进仓库，且文件位于 public/ ——
Vite 构建会把 public/ 原样拷贝进 dist，任何生产部署都会随产物发布这个自动登录页和密码本身。虽然 ledger 记录该隔离环境（tmpfs DB）已销毁，但密码已随仓库固化，且
ledger 明言"后续隔离轮次可能复用"，一旦复用即为已泄露凭据。建议：将此辅助页移出 public/（放到不参与构建的本地目录或加入
.gitignore），至少从构建产物排除；该密码应视为已泄露，后续轮次复用前必须轮换。



─── app/public/__iso-login.html:6-7 ───
[security · low] 登录失败分支把服务端响应原文（await r.text()）直接拼进 innerHTML，catch 分支同样以 innerHTML 输出异常对象——若响应体包含
HTML（错误页、反代默认页）即构成标记注入（XSS 向量），也违反"动态内容禁用 innerHTML"约定。请改用 textContent 渲染纯文本。

- .then(async r=>{ if(!r.ok){document.body.innerHTML='<pre>登录失败: '+await r.text()+'</pre>';return;} location.href='http://127.0.0.1:3011/'; })
- .catch(e=>document.body.innerHTML='<pre>'+e+'</pre>');
+ .then(async r=>{ if(!r.ok){const t=await r.text();const pre=document.createElement('pre');pre.textContent='登录失败: '+t;document.body.replaceChildren(pre);return;} location.href='http://127.0.0.1:3011/'; })
+ .catch(e=>{const pre=document.createElement('pre');pre.textContent=String(e);document.body.replaceChildren(pre);});


─── app/spike/main.tsx:497-498 ───
[bug · medium] 渲染期间执行全局写入副作用（MultiSelectFixture 的 pickedOrder 与 DialogWithCombobox 的 dialogPicked
同一模式），违反 React 渲染纯函数约定，并发渲染下可能写入过期值导致夹具证据失真；且 pickedOrder 未在文件顶部 declare global 的 Window 接口中声明——目前只因
spike/ 不在 tsconfig include 内逃过了 tsc，一旦纳入类型检查即报错。建议改为 useEffect 同步，并在接口中补齐声明。

    const [picked, setPicked] = useState<typeof bots>([]);
+   useEffect(() => {
-   window.__spike.pickedOrder = picked.map((bot) => bot.id);
+     window.__spike.pickedOrder = picked.map((bot) => bot.id);
+   }, [picked]);
+ // 并在 declare global 的 __spike 接口中补: pickedOrder: string[] | null;


─── app/spike/main.tsx:402-404 ───
[bug · medium] 这段问卷事件桥接实际永远不会生效：dangerouslySetInnerHTML 底层走 innerHTML，而经 innerHTML 插入的内联 <script>
按规范不会执行，questionnaire-choice 事件将永远缺失，夹具静默失效。目标 data-slot="questionnaire-choice-input"
在生产组件中确实存在，问题只在注入方式。建议改用 useEffect + addEventListener 完成桥接。

-         dangerouslySetInnerHTML={{
-           __html: `document.querySelectorAll('[data-slot=questionnaire-choice-input]').forEach(function(i){i.addEventListener('change',function(e){window.__spike.event('questionnaire-choice',{value:e.target.value})});});`,
-         }}
+   useEffect(() => {
+     const inputs = document.querySelectorAll(
+       '[data-slot=questionnaire-choice-input]',
+     );
+     const onChange = (e: Event) =>
+       window.__spike.event("questionnaire-choice", {
+         value: (e.target as HTMLInputElement).value,
+       });
+     inputs.forEach((i) => i.addEventListener("change", onChange));
+     return () =>
+       inputs.forEach((i) => i.removeEventListener("change", onChange));
+   }, []);


─── app/spike/main.tsx:342-343 ───
[maintainability · low] 死代码/无效状态：scrollerRef 绑定后从未读取；_setAnswer 从未被调用，answer 恒为 null，导致 "Next" 按钮记录的
{answer: null} 与界面显示的 "none" 永远不变，夹具的答案观测语义与实际行为不符。请移除两者，或把 _setAnswer 真正接到 QuestionnaireChoice
的选择回调上。



─── app/spike/main.tsx:178-182 ───
[maintainability · low] props.onClick?.(undefined as never) 是确定的空操作且有误导性：dialog.tsx 中 DialogTrigger
的 render 回调收到的是 buttonProps（type/aria-haspopup/id 等），本身不含 onClick，弹窗打开由外层 Pressable
的按压响应器完成。这行代码让读者误以为需要手动触发打开，undefined as never 的强转也绕过了事件签名约束。建议直接删除该调用。

              onClick={() => {
                window.__spike.lastFocusBeforeMenu =
                  document.activeElement?.id ?? null;
-               props.onClick?.(undefined as never);
              }}


─── app/spike/main.tsx:267-270 ───
[bug · low] 同样的 undefined as never 调用在 SheetTrigger 处更危险：若 Drawer.Trigger 的 render props 携带按压
onClick（React Aria usePress 的 DOM props 包含 onClick，内部会读取事件属性），以 undefined 调用可能在运行时抛
TypeError；若不携带则为纯死代码。此外 Sheet 是受控组件（open={drawer}），触发器的按压响应器已经走 onOpenChange 打开抽屉，手动 setDrawer(true)
是冗余的第二条打开路径。建议两者都删除，交由触发器自身完成打开。

                      onClick={() => {
-                       props.onClick?.(undefined as never);
-                       setDrawer(true);
+                       // 受控 Sheet：按压响应器经 onOpenChange 已打开抽屉，无需手动翻转
                      }}


─── app/spike/heroui.html:9-10 ───
[maintainability · low] spike/heroui.html 与根目录 spike.html 内容完全一致（仅 title 文案不同），都加载同一个
/spike/main.tsx，属重复入口；且一个在项目根、一个嵌在 spike/ 目录内，层级不一致，后续维护（改入口、加
fixture）容易只改一处造成两个入口行为漂移。建议保留单一入口（例如仅保留根目录 spike.html），删除重复文件。



─── app/src/components/ui/field.tsx:107-110 ───
[bug · medium] `data-invalid={invalid || undefined}` 写在 `{...props}` 之前，会被 props
展开中的原始值覆盖，`isInvalid` 的归一化意图完全失效：调用方传 `data-invalid={false}`（如 model-catalog.tsx:255 的 `problem !==
undefined`、playground.tsx:510 的 `Boolean(error)`）时，React 会将 data-* 布尔值字符串化，DOM 上残留
`data-invalid="false"` 属性而非按预期移除；这行显式属性在任何传入 data-invalid 的场景下都是被覆盖的死代码。虽然当前 fieldVariants 用的是值匹配的
`data-[invalid=true]:` 尚无视觉回归，但残留属性对任何存在性匹配选择器（`data-invalid:`/`[data-invalid]`）都是隐患。建议将归一化属性移到
`{...props}` 之后（并在解构中摘除原始 `data-invalid`），与下方 `aria-describedby` 的处理方式保持一致。

          data-orientation={orientation}
-         data-invalid={invalid || undefined}
          className={cn(fieldVariants({ orientation }), className)}
          {...props}
+         data-invalid={invalid || undefined}


─── app/src/components/ui/field.tsx:252-252 ───
[bug · low] FieldError 支持通过 `id` 覆盖错误元素的 id，但 Field 生成 `aria-describedby` 时固定引用 FieldContext 中的
`errorId`，且 errorId 未对外暴露、无法被调用方覆盖。一旦调用方传入自定义 `id`，消息元素的实际 id 与 group 引用的 errorId 不一致，`role="alert"`
区域失去关联，读屏器将无法播报该错误——这与文件头注释声明的『no call site has to hand-wire the pair』契约自相矛盾。当前所有调用点均未传
id（分支不可达），建议要么去掉 id 覆盖支持（不解构 id，统一使用 field?.errorId），要么让 Field 同步感知并引用 FieldError 实际使用的 id。



─── app/src/components/ui/item.tsx:75-81 ───
[bug · medium] className 与 style 的合并方向与 JSDoc 声明的『the element's props win』相反：`cn` 基于
tailwind-merge（后传入的类在冲突时胜出），`cn(theirs, ours)` 让 Item 的变体类（ours）胜出、render 元素的类（theirs）被裁决掉；style 的
`{...theirs, ...ours}` 同理让 Item 一侧的同名键覆盖元素一侧。这与同函数中普通 props 的 spread 语义（`{...resolved,
...element}`，element 覆盖）也不一致。当调用点在 render 元素上携带与变体冲突的类（如 `px-*`、`py-*`、`gap-*`）或内联 style
时，行级定制会静默失效。应改为 `cn(ours, theirs)` 与 `{...ours, ...theirs}`，让元素侧后置胜出。

      if (key === "className") {
-       merged[key] = cn(theirs as string | undefined, ours as string | undefined);
+       merged[key] = cn(ours as string | undefined, theirs as string | undefined);
      } else if (key === "style") {
        merged[key] = {
-         ...(theirs as React.CSSProperties | undefined),
          ...(ours as React.CSSProperties | undefined),
+         ...(theirs as React.CSSProperties | undefined),
        };


─── app/src/components/ui/input.tsx:21-21 ───
[bug · medium] `pointer-coarse:!h-11 pointer-coarse:!min-h-11` 使用了 Tailwind v3 的前缀 important 语法；项目为
Tailwind v4（4.3.3），important 修饰符已改为后缀（`h-11!`），前缀形式不会被解析为有效候选类、不生成任何 CSS。结果是触屏设备上输入框高度回落到
h-9（36px），本次改造新增的 44px 触达目标静默失效且无任何报错。应改为后缀写法 `pointer-coarse:h-11!
pointer-coarse:min-h-11!`（若确认变体内媒体查询的输出顺序足以覆盖基础类，也可直接去掉 important）。

-         "h-9 min-h-9 w-full min-w-0 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 pointer-coarse:!h-11 pointer-coarse:!min-h-11 md:text-sm",
+         "h-9 min-h-9 w-full min-w-0 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-1 text-base transition-colors outline-none shadow-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 pointer-coarse:h-11! pointer-coarse:min-h-11! md:text-sm",


─── app/src/components/ui/questionnaire.tsx:170-170 ───
[bug · medium] `pointer-coarse:!h-11 pointer-coarse:!min-h-11` 使用了 Tailwind v3 的前缀 important
语法，v4（4.3.3）仅支持后缀 `h-11!`，前缀形式不生成 CSS。此处影响比 input.tsx 更明显：原类名是常驻的 `h-8 min-h-11`，本次改为 `h-8 min-h-8`
并把触屏 44px 目标寄托在失效的 `pointer-coarse:!h-11` 上——粗指针设备上输入高度实际从 44px 回落到 32px，构成可用性回归。应改为
`pointer-coarse:h-11! pointer-coarse:min-h-11!`。

-           "h-8 min-h-8 w-full min-w-0 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-1 text-base transition-[color,box-shadow,background-color] outline-none focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 pointer-coarse:!h-11 pointer-coarse:!min-h-11 md:text-sm",
+           "h-8 min-h-8 w-full min-w-0 rounded-lg border border-[var(--ob-control-border)] bg-[var(--ob-field-background)] px-2.5 py-1 text-base transition-[color,box-shadow,background-color] outline-none focus-visible:border-[var(--ob-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ob-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-[var(--ob-control-border)] disabled:bg-[var(--ob-disabled-background)] disabled:text-[var(--ob-disabled-foreground)] disabled:opacity-100 aria-invalid:border-[var(--ob-danger)] aria-invalid:bg-[var(--ob-field-background)] aria-invalid:ring-2 aria-invalid:ring-[var(--ob-danger)]/20 pointer-coarse:h-11! pointer-coarse:min-h-11! md:text-sm",


─── app/src/components/ui/router-link.tsx:23-34 ───
[maintainability · low] `to` 与 `href` 均为可选且未构成判别联合，类型层面允许两者都不传：此时组件落入 Link 分支以 `to={undefined}` 渲染
TanStack Link，运行期行为未定义（构建链接失败或渲染出错误目的地），且注释声明的『callers pass one destination』仅靠约定维持。同时两者同时传入时 href
分支静默优先，to 被丢弃也无任何提示。建议用判别联合在类型层面强制二选一，让漏传在编译期报错。

  export type ButtonLinkProps = AnchorProps & {
-   to?: LinkProps["to"];
    params?: LinkProps["params"];
    search?: LinkProps["search"];
    activeProps?: LinkProps["activeProps"];
    inactiveProps?: LinkProps["inactiveProps"];
-   href?: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
    children?: ReactNode;
- };
+ } & (
+   | { to: LinkProps["to"]; href?: undefined }
+   | { to?: undefined; href: string }
+ );


─── app/src/components/ui/router-link.tsx:55-59 ───
[security · low] 外部链接分支渲染原生 `<a>` 时未提供默认 `rel`。调用方在 `target="_blank"` 场景漏传 `rel` 时存在
tabnabbing/隐私（window.opener 引用）风险。作为统一的链接出口组件，建议在调用方未显式指定 rel 时兜底注入 `noopener noreferrer`（注意通过
`anchorProps.rel ?? ...` 读取而不是在 spread 后硬置，避免覆盖调用方自定义值）。

      return (
-       <a {...anchorProps} {...shared} href={href}>
+       <a
+         {...anchorProps}
+         {...shared}
+         href={href}
+         rel={anchorProps.rel ?? "noopener noreferrer"}
+       >
          {children}
        </a>
      );


─── app/src/components/bot-profile/setup.tsx:256-260 ───
[maintainability · low] 焦点恢复只覆盖了服务端保存失败分支：schema 校验失败时（`!parsed.success` 提前
return）弹窗同样保持打开并展示错误，但不会把焦点归还给输入框。若用户是用鼠标点击 Save 触发的校验失败，焦点会停留在 Save 按钮上，与保存失败分支（rAF
后聚焦回字段）的处理不一致。建议把焦点归还逻辑提到两条失败路径共用的位置，例如在 setError 的同时统一执行。

      const parsed = schema.safeParse(draft);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? t("editable.doesNotFit"));
+       requestAnimationFrame(() => {
+         (inputRef.current ?? textareaRef.current)?.focus();
+       });
        return;
      }


─── app/src/components/channels/workshop-share.tsx:127-133 ───
[style · low] days 的回显使用了嵌套三元（days === 7 ? … : days === 30 ? … : …），违反嵌套三元禁用规则；且该 value→文案映射与下方
SelectItem 列表（第 136–138 行）重复，新增有效期档位时需要多处同步修改。建议在组件内定义查找表统一映射（也可顺带由同一数据源渲染 SelectItem）。

+               {/* dayLabels 定义在组件体内：const dayLabels: Record<number, string> = { 7: t("share.days.7"), 30: t("share.days.30"), 0: t("share.days.forever") }; */}
                <SelectValue>
-                 {days === 7
-                   ? t("share.days.7")
-                   : days === 30
-                     ? t("share.days.30")
-                     : t("share.days.forever")}
+                 {dayLabels[days] ?? t("share.days.forever")}
                </SelectValue>


─── app/src/components/routines/routines-list.tsx:432-438 ───
[maintainability · medium] 手写工具类复刻了 Button 的 ghost + 图标按钮样式，但这是全库唯一不走 `render={<Button …/>}` 组合的
DropdownMenuTrigger（skills.tsx、app-sidebar.tsx、voice-call-widget.tsx 均为组合模式）。手写版本丢失了 Button
基类保障：focus-visible 焦点环（`focus-visible:outline-2 … var(--ob-focus)`，键盘用户可能看不到焦点）、pointer-coarse
触控最小命中尺寸（min-h-11/min-w-11）、过渡与禁用态；圆角 `rounded-md` 也与 Button ghost/icon-sm 的圆角不一致。另外以字面字符 "⋯"
代替图标组件，与同文件 IconHistory/IconTrash 及 skills.tsx 已在用的
`IconDots`（@tabler/icons-react）体系不一致，跨平台字体渲染下宽度/基线不稳定。建议改用既有组合模式，并在现有 @tabler/icons-react 导入中补充
IconDots。

                          <DropdownMenuTrigger
+                           render={
+                             <Button
-                           aria-label={t("actions.moreActions")}
+                               aria-label={t("actions.moreActions")}
-                           className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-ob-hover hover:text-ob-hover-foreground"
-                           type="button"
+                               variant="ghost"
+                               size="icon-sm"
+                             />
+                           }
                          >
-                           <span aria-hidden="true">⋯</span>
+                           <IconDots />
                          </DropdownMenuTrigger>


─── app/src/components/routines/routines-list.tsx:440-458 ───
[other · medium] 菜单化后 History/Delete 菜单项不再携带 schedule 上下文（原 aria-label 通过 historyAria/deleteAria
点名目标，重构后丢失）。本仓库对破坏性菜单项有明确惯例：skills.tsx 的删除项使用 `t("deleteSlug", { slug })` 点名目标并加
`variant="destructive"`，其注释明确说明理由——"在错误的行上打开菜单是常见的出错方式"。建议菜单项标签带上 schedule（可直接复用现已无引用的
actions.historyAria / actions.deleteAria 键，或另立更简短的键），并为 Delete 项补 `variant="destructive"` 与
skills.tsx 保持一致。

                            <DropdownMenuItem
                              onClick={() =>
                                setHistoryId(
                                  historyId === routine.id ? null : routine.id,
                                )
                              }
                            >
                              <IconHistory />
-                             {t("actions.history")}
+                             {t("actions.historyAria", {
+                               schedule: routine.schedule,
+                             })}
                            </DropdownMenuItem>
                            <DropdownMenuItem
+                             variant="destructive"
                              onClick={() => {
                                deleteRoutine.reset();
                                setConfirmingId(routine.id);
                              }}
                            >
                              <IconTrash />
-                             {t("actions.delete")}
+                             {t("actions.deleteAria", {
+                               schedule: routine.schedule,
+                             })}
                            </DropdownMenuItem>


─── app/src/locales/en/routines.json:47-47 ───
[maintainability · low] 本次改动将 History/Delete 移入下拉菜单后，`actions.historyAria` 与 `actions.deleteAria`
在全库已无任何代码引用（检索仅剩本文件定义；`runNowAria` 仍在 routines-list.tsx 中使用），成为死键。建议删除，或按 routines-list.tsx
评论所述将其复用为带 schedule 上下文的菜单项标签。



─── app/src/locales/zh-CN/routines.json:47-47 ───
[maintainability · low] 本次改动将 History/Delete 移入下拉菜单后，`actions.historyAria` 与 `actions.deleteAria`
在全库已无任何代码引用（检索仅剩本文件定义；`runNowAria` 仍在 routines-list.tsx 中使用），成为死键。建议删除，或按 routines-list.tsx
评论所述将其复用为带 schedule 上下文的菜单项标签。



─── app/src/components/computer/demonstration-recorder.tsx:133-135 ───
[bug · high] cron 调度选择器缺少 `items` 标签映射：新版 Select wrapper 的闭合触发器标签由 SelectValue →
resolveSelectedLabel(value, items, itemToStringLabel) 渲染，未传 `items` 且未传 `itemToStringLabel` 时会回落到
serializeValue(value)，即原始值。因此收起状态下触发器将显示 `"0 9 * * 1-5"`、`"0 * * * *"` 或字面量 `"custom"`，而不是迁移前原生
<select> 展示的本地化标签（"每个工作日 9 点"/"自定义 cron"）。本批其余迁移调用点（如 bot-profile/profile.tsx:161，注释原话 "The label
map, so the closed trigger says 'Everything' rather than the raw
value"、responsibilities/triggers.tsx:623）均遵循「裸 <SelectValue /> 必须在根上传 items 记录」的约定，此处遗漏了。

+         <Select
+           items={{
+             ...Object.fromEntries(
+               SCHEDULES.map((option) => [option.cron, t(option.label)]),
+             ),
+             custom: t("demonstration.customCron"),
+           }}
+           onValueChange={(value) => {
+             if (value !== null) setCron(value);
+           }}
+           value={cron}
+         >
            <SelectTrigger className="w-full" id={`${id}-when`}>
              <SelectValue />
            </SelectTrigger>


─── app/src/components/computer/demonstration-recorder.tsx:180-182 ───
[bug · medium] 渠道选择器以 "" 作为实选项值（ONLY_CONVERSATION）与 wrapper 的 placeholder 判定冲突：Select 内部
hasSelectedValue 经 serializeValue("") 得 ""，故 channelId 为 "" 时 isPlaceholder 恒为 true，SelectValue 走
placeholder 分支渲染、触发器被标 data-placeholder 并应用
data-placeholder:text-muted-foreground。结果是从具体渠道切回"仅本会话"后，触发器文本以占位符的弱化色显示（文本本身恰好与 placeholder
相同而被掩盖），与迁移前原生 <select> 中该项作为正常选中项呈现不一致，也与代码注释""" is not that — it is a real item" 的主张相悖。可在调用点通过
itemToStringValue 让 "" 序列化为非空串，使其被判定为真实选中，此时标签会经 items 记录正确解析为 items[""]。

-           <SelectTrigger className="w-full" id={`${id}-channel`}>
-             <SelectValue placeholder={t("demonstration.onlyConversation")} />
-           </SelectTrigger>
+         <Select
+           items={{
+             [ONLY_CONVERSATION]: t("demonstration.onlyConversation"),
+             ...Object.fromEntries(
+               botChannels.map((channel) => [channel.id, channel.name]),
+             ),
+           }}
+           itemToStringValue={(value) =>
+             value === ONLY_CONVERSATION ? "only-conversation" : value
+           }
+           onValueChange={(value) => {
+             if (value === null) return;
+             setChannelId(value);
+           }}
+           value={channelId}
+         >


─── app/src/routes/_authed/admin/knowledge.$kbId.tsx:207-207 ───
[bug · high] AddDocument 的 SelectTrigger 缺少 <SelectValue/> 子元素。共享 Select
包装器（ui/select.tsx:527-530）只渲染 children + 选择图标，不会自动注入选中值文案——本文件 :476、:510 两处筛选器及全仓库其余 30+ 个调用点（如
approvals/rules.tsx:111、bot-profile/setup.tsx:205）均在 Trigger 内放置 SelectValue，此处是唯一遗漏（SelectValue 已
import 却未使用于此）。结果：闭合态触发器只显示一个图标，用户看不到当前选中的来源类型（文本/URL/文件），相对被替换的原生 <select> 构成功能回退。修复：放入裸
<SelectValue/>，它会通过已传入的 items 解析当前 value 的文案。

-             <SelectTrigger className="w-full" id={typeId} />
+             <SelectTrigger className="w-full" id={typeId}>
+               <SelectValue />
+             </SelectTrigger>


─── app/src/routes/_authed/admin/knowledge.$kbId.tsx:195-199 ───
[maintainability · low] 同一选项的文案在此处（items 映射，供闭合态触发器解析）与 SelectContent 渲染处（经 ADD_TYPE_LABEL 再次调
t()）双份维护；两处筛选器的 items 同理。若日后调整某个 i18n key 只改一处，同一选项在触发器与下拉列表中将显示不一致文案。建议 items 由 ADD_TYPE_LABEL
派生，保持单一来源（键序仅是查找表、不影响渲染顺序，SelectContent 顺序仍由 Object.keys(ADD_TYPE_LABEL) 决定）。

-             items={{
-               file: t("add.typeFile"),
-               text: t("add.typeText"),
-               url: t("add.typeUrl"),
-             }}
+             items={Object.fromEntries(
+               (
+                 Object.keys(ADD_TYPE_LABEL) as Array<keyof typeof ADD_TYPE_LABEL>
+               ).map((key) => [key, t(ADD_TYPE_LABEL[key])]),
+             )}


─── app/src/components/routines/routines-list.tsx:440-449 ───
[bug · low] 重构进菜单后，原 History 按钮携带的 `aria-expanded={historyId === routine.id}` 被整体丢弃（全文件已无
aria-expanded）：屏幕阅读器用户在该菜单项上无法得知运行历史当前是展开还是收起，点击是切换语义却没有任何状态披露。建议在 DropdownMenuItem 上透传
`aria-expanded={historyId === routine.id}`（ARIA 允许 menuitem 携带 aria-expanded），或改用本组件库已有的
DropdownMenuCheckboxItem + `closeOnClick` 以 aria-checked 表达开关态。注意这是与“菜单项缺少 schedule 上下文”独立的状态披露问题。



─── app/src/components/routines/routines-list.tsx:437-437 ───
[style · low] 触发器用文本字符 "⋯" 而非图标库的 `IconDots`：全库其余下拉触发器（skills.tsx 等）均使用 Tabler
图标，文本字形在不同平台/字体下的大小与基线会漂移，且与菜单触发器 `[&_svg]:size-4` 的 16px 图标体系不一致。若按既有惯例改为 `render={<Button
variant="ghost" size="icon-sm"><IconDots /></Button>}` 组合（同时解决该触发器手写样式的问题），此处应一并换成 IconDots。



LLM retry report summary: 48 of 304 requests affected -- 25 requests failed, 23 requests recovered after retry

Review planning (10 requests):
- app/src/components/delivery/reaching-you.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/components/gallery/decisions.tsx,app/src/components/gallery/form.tsx,app/src/components/gallery/table.tsx,app/src/routes/_authed/settings/components-gallery/$name.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/components/skills/edit-skill.tsx,app/src/components/skills/new-skill.tsx,app/src/components/skills/proposed-skill.tsx,app/src/components/skills/skill-fields.tsx,app/src/routes/_authed/_app/skills.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/routes/_authed/admin/bot-services.tsx,app/src/routes/_authed/admin/components/$name.tsx,app/src/routes/_authed/admin/computers.tsx,app/src/routes/_authed/admin/credentials.tsx,app/src/routes/_authed/admin/gateway.tsx,app/src/routes/_authed/admin/learning.tsx,app/src/routes/_authed/admin/model-catalog.tsx,app/src/routes/_authed/admin/plugins/$key.tsx,app/src/routes/_authed/admin/route.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/tests/preload.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- ... and 5 more

Core review (38 requests):
- app/index.html,app/package.json,app/public/__iso-login.html,app/spike.html,app/spike/heroui.html,app/spike/main.tsx,app/spike/spike.css,app/vite.spike.config.ts: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/components/ai-observability/dataset-detail.tsx,app/src/components/ai-observability/evaluations-page.tsx,app/src/components/ai-observability/experiment-comparison.tsx,app/src/components/ai-observability/experiment-results.tsx,app/src/components/ai-observability/experiments-section.tsx,app/src/components/ai-observability/exports-status.tsx,app/src/components/ai-observability/run-detail.tsx,app/src/components/ai-observability/run-steps.tsx,app/src/components/ai-observability/runs-list.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/components/app-sidebar/app-sidebar.tsx,app/src/components/layout/detail-panel.tsx,app/src/components/layout/page-shell.tsx,app/src/components/layout/row-mark.tsx,app/src/components/layout/self-host-banner.tsx,app/src/components/layout/sidebar-shell.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/components/approvals/rules.tsx,app/src/components/approvals/waiting.tsx,app/src/components/plugins/shared-approval-fields.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- app/src/components/channels/chat-transcript.tsx,app/src/components/channels/composer/attachment-strip.tsx,app/src/components/channels/conversation-view.tsx,app/src/components/channels/group-chat.tsx,app/src/components/channels/recipient-field.tsx,app/src/components/channels/voice-call-widget.tsx,app/src/components/channels/voice-chat-card.tsx,app/src/routes/_authed/_app/channel/new.tsx: rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> rate limited (HTTP 429) -> failed
- ... and 33 more

Per-attempt detail: --format json (retry_report).
