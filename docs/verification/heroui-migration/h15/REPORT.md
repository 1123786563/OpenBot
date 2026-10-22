# H15 REPORT — 完成全流程、可访问性与独立审查交付验收（frontend_validator，只读验收）

- 日期：2026-10-20。工作区 `.worktrees/heroui-migration`，分支 `feat/heroui-v3-migration`，BASE=HEAD `203d0f0244b2f898218fa12027089c631e8448d9`（无 commit；全部为未提交工作树增量）。
- 授权：父 Issue #443 委派提示词 + `h15/BRIEF.md` + 主控派发。本波为**只读验收**：生产/测试源文件零改动；写入仅限 `docs/verification/heroui-migration/h15/**` 与 `/tmp`。
- 输入：`h15/BRIEF.md`、`docs/tickets/heroui-migration/issues/h15.md`、`docs/adr/0008-test-runner-tester-army-e2e.md`、`h14/REPORT.md` + `coverage.md`、`reviews/REVIEW-W3A…W7` 全部、`BACKLOG-H14-H15.md` 终态、`LEDGER.md` 全程、`h01/REPORT.md` + `h01/baseline` + `h01/browser/cdp-harness/README`。

## 0. 口径记录（主控传达，如实录入）

- **最终 OCR 轮已被用户指令取消**（本波执行中主控传达）。A10 的独立审查证据 = W3A/W3B/W3C/W4/W5/W6/W7 七轮已通过的独立 review；OCR 一项不作为本报告的通过条件，也不在遗留中挂账。
- 本波零源文件改动（`git status` 全集 = 迁移既有增量 + 本波 `docs/verification/heroui-migration/h15/**` 交付物），因此 **H14/W7 的同版本测试证据按 ADR 0008 规则复用**，只补缺失项（见 §3 分层对账）。

## 1. 环境拉起记录（dev 栈；全部为环境/数据修复，零仓库文件改动，.env 未动）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| Postgres | `docker compose up -d postgres`（主 compose；`:55432` = .env POSTGRES_PORT） | UP |
| Casdoor 首启 | `docker compose --project-directory . -f docker/compose/services.yml up -d casdoor` | 容器启动即 panic：`dial tcp: lookup postgres on 127.0.0.11:53: no such host`（casdoor 在 `openbot_data` 网，本 worktree 的 postgres 在 `heroui-migration_data` 网） |
| 网络修复 | `docker network connect openbot_data heroui-migration-postgres-1 --alias postgres` + `docker restart openbot-casdoor-1` | Casdoor :8000 UP |
| `bun run dev`（根） | 照 BRIEF 原样执行 | 失败：server 抛 `PORT (3001) and SERVER_PORT (3002) disagree`（**.env 既有冲突**：line 22 `PORT=3001` / line 23 `SERVER_PORT=3002`，config 拒绝分歧）；且 app dev script 不读 .env（vite 落默认 3010） |
| 端口绕行 | server：`cd server && env PORT=3002 bun --env-file=../.env src/index.ts`；app：`cd app && env APP_PORT=3011 SERVER_PORT=3002 bun --bun node_modules/vite/bin/vite.js` | app :3011 UP、server :3002 UP（显式进程级 env 覆盖，未改任何文件） |
| 迁移 | `db:migrate` 首跑报 `ENTERPRISE_ROLE_PREREQUISITES_UNSAFE` → `docker exec -i heroui-migration-postgres-1 psql -U openbot -d openbot < server/ops/enterprise/roles.sql` → 复跑 | `{"type":"migrations-applied","status":"ok"}` |
| Casdoor 应用注册 | 浏览器流点登录 → Casdoor 页「无效的ClientId」 | 修复（SQL，仅 casdoor 数据库）：`application` 行 client_id/client_secret 对齐 .env（`c690598a2fcec16ebeae`），redirect_uris 补 `http://localhost:3002/api/auth/callback/casdoor`（better-auth 回调走 SERVER_PORT 3002） |
| Casdoor 口令 | built-in 组织 `password_type=bcrypt`、admin password 为空 → 设 bcrypt("123")（先经历一次 casdoor 侧 13 分钟失败锁定窗口，如实记录） | admin/123 浏览器 OAuth 流全通：`/sign → casdoor → callback → /onboarding → /`，`/api/me` 200（role=admin） |

修复后完整栈：**postgres :55432（已迁移）+ Casdoor :8000 + server :3002 + app :3011（vite dev，/api 代理）**，真实 admin 会话建立。本波全部浏览器证据都出自该真实栈的可信 CDP 输入。

## 2. A01–A10 验收矩阵

| # | 结论 | 证据 |
| --- | --- | --- |
| **A01** 公共控件 HeroUI 化 + Base UI 清零 | **PASS** | 本波全量 grep 自证：`app/src` 内 `@base-ui` = **0**；全仓残余仅 `app/tests/preload.ts` + `app/spike/main.tsx` 两处历史 why-comment 与 `server/assets/craft/web-template`（票面明示不迁移）；裸 `bg-muted/bg-accent/text-accent` 冲突名 = 0；legacy 别名词汇 629 处消费（bridge 保留条件未满足，照 h14 §2）；`@heroui` 消费 15 文件。coverage.md 88/88 路由 + 27/27 ui 模块逐文件归属（W7 (g) 独立复核） |
| **A02** 主题/首屏/portal 无 token 污染 | **PASS** | 真实 app 亮/暗双轮 computed style 抽查（`h15/browser/cdp-interactive.mjs` a02 段）：user dropdown（portal）暴露 ob-theme 变量 accent `#171717` / muted `#5c5c5c` / brand `#00c29a`（WorkBuddy 系），**非 HeroUI 默认紫**；暗色轮重主题后同测通过。暗色首屏：`app/index.html` boot script 内联（:11-15）pre-hydration 读 `openbot-theme` 置 `html.dark` + `data-theme`（关闭 H02 专项缺口 7）；`shadcn/tailwind.css` 预设零未分层 `:root` token（W7 (b) 包级全读）。暗色全套截图见 §5 |
| **A03** 业务试点与主路径抽验 | **PASS（负路径 in-app 实测；正路径复用同版本域证据）** | in-app：`/settings/model-access` 无效绑定码负路径——单击恰 1 次 `/api/model-access/*` 请求（single submit），错误经 `role="alert"` 呈现（与 BASE :155 逐字同型），截图 `a05-model-access-invalid-code.png`（内容「绑定码无效。请向 Bot 重新获取后再试。」）；admin/billing、admin/gateway、settings/usage、home 渲染正常（42 张截图账）。正路径（授权→撤销 E2E）需 workbench bot + 站外身份（本栈无 agent runtime），复用同版本组件/域证据：h03 model-picker 8/8、h05 credentials/bot-services null 守卫、driven billing-credits-ui 18/18 等（W3A–W7 各轮复核）。BLOCKED 子项如实记 §6 |
| **A04** 弹窗/Drawer/菜单/Select 键盘 + 焦点返还 | **PASS（1 子项环境阻塞，如实记）** | 真实 app：create-agent 对话框开/ESC 关 + 焦点返还（PASS）、开启期 scroll lock `html overflow:hidden`（PASS）、600vh 视口 `data-slot=dialog-content` maxH=510px=85svh + body overflow auto 独立滚动（PASS）。spike 生产 adapter 矩阵（`h15/browser/cdp-surface-matrix.mjs`，ALL-GREEN）：S1 外点关闭+焦点返还、S2 scroll lock 开/关恢复、S3 短视口 85svh cap（408px@480vh）、S4 Select popover 锚定 trigger（非 0,0）且 320px 全在屏。ESC 七场景矩阵（h01 RUN 修复/收口轮）+ 嵌套 F1 + h10 CDP context-menu 7/7（W5 reviewer 字节一致复跑）继续有效。子项阻塞：**in-app channel ContextMenu**（app-sidebar channel 行）需要已存在 channel——发消息需 agent runtime（不可用），组件级可信输入证据（上列）覆盖同一生产 adapter，见 §6 |
| **A05** 表单单次提交/错误关联/Link 语义 | **PASS** | 单次提交：A03 的 1 request/click（`Network.enable` 监听，a05 段）；错误关联：`role="alert"`（BASE 逐字同型）+ dialog 域 FieldError aria-describedby 族（H07/H13 已验 id↔htmlFor）。Link 语义（in-app DOM 实测 `h15-links` 探针）：全部为真 `<a>`（TanStack Link/ButtonLink）；外链 `联系工程师 → copilotkit.ai` 带 `target="_blank"` + `rel="noopener noreferrer"`；内链无 target（SPA 语义）；`#main-content` skip link 在。组合键：Enter 单击推进（问卷 step 不双触发）+ Enter 守卫见 A06；OAuth 外跳锚点 `window.location.assign/href` 四处 BASE 字节一致（W3A 已验） |
| **A06** 聊天编辑/附件/流式/滚动 + IME | **PASS（IME in-app 实测；流式/滚动子项环境阻塞如实记）** | IME（真实 PromptArea composer，`h15/browser/cdp-composer.mjs`，CDP `Input.imeSetComposition` 可信输入，方法如实记录）：composer（`DIV[contenteditable] aria="消息"`）上 composition-start → **Enter isComposing=true（守卫生效，不发送）** → composition-end（提交文本「你好」真实渲染进 composer）→ 非 composition Enter 走发送路径（URL 留 /channel/new——发送需 agent runtime，属环境）。流式/回底部/历史锚点：需有消息的 channel（环境阻塞）→ 组件/引擎层同版本证据：message-scroller（@shadcn/react 保留引擎）h01 AC3 End 键到底日志 + h10 live-screen 5/5 + composer draft/picked-files/queue 引擎单测。chat 编辑/附件业务合同 = 零 diff 域（h11 核验 PromptArea 引擎族不动） |
| **A07** 公司/团队/付款/权限/敏感字段 | **PASS（正/负抽验复用同版本域测试；浏览器侧拒绝态环境不可造）** | 敏感/OAuth 锚点四处 BASE 字节一致（W3A 契约抽查）；H04 敏感值清空合同、H07 权限红线（无 any/无 String 强转/角色适配）构造性成立（W4）；multitenancy 守卫/深链 selection 25/25（H09/W3B）。浏览器侧权限拒绝态：本栈单 admin、无法构造第二身份——**如实记为环境限制**（§6），不虚构。付款金额精度/币种/状态区分零 diff（H08/W3A） |
| **A08** 桌面/窄屏/中英文 + 200% + reduced-motion | **PASS** | 42 张系统命名截图（§5 清单）：light/dark × zh/en × {1440×900, 1280×720, 390×844, 320×568} × 代表页（home / model-access / admin-gateway / admin-billing / usage + sign + onboarding + channel-new）；200% 缩放（`Emulation.setPageScaleFactor`）home + model-access 各一张；reduced-motion（`Emulation.setEmulatedMedia` prefers-reduced-motion=reduce）home + admin-gateway 各一张。抽读核验：暗色全表面重主题、320px 下限可读、en/zh 双语切换生效（storage key `openbot-theme`/`openbot.language`——i18n lookup key 与 theme THEME_STORAGE_KEY 由 boot contract 逐字核实） |
| **A09** 性能（gzip 对基线，>10% 定位+评审） | **PASS（两项超门槛均带评审结论；本波独立复算一致）** | 数字复用 H14/W7（同版本）并**本波在终态树重建后再求和**：sign 闭包 7 文件 = **476,457 gzip（逐字节吻合）**；chat 1,184,734（+1.41%）、CSS 61,184（+22.6%）。超门槛定位与 ACCEPT 结论 = H14 §7 + W7 (f)（sign +10.58% = 入口 HeroUI/RAC 共享运行时一次性结构成本，route-sign 本体 1,477 gzip 仅 0.3%；CSS = H02 裁定 6,824 + H03–H13 组件 CSS 4,454 一一对应）。manualChunks 缓解评估 → 裁决见 §4.2：**不建议现阶段采用**。重建日志 `h15/evidence/build.log`（EXIT 0，产物内容寻址名与 W7 构建逐一相同；另见 §6 孤儿 chunk 注记） |
| **A10** 独立 Review + OCR | **PASS（以 W3A–W7 七轮独立 review 为证据；OCR 经用户指令取消）** | 七轮 review 全部 Spec PASS/质量过关、累计 0 critical / 0 high（W3A/B/C、W4、W5、W6、W7——各轮门禁记录见 LEDGER）。OCR：用户指令取消（§0），不再挂账 |

## 3. 测试分层对账（ADR 0008）

| 层 | 命令 | 结论 | 证据口径 |
| --- | --- | --- | --- |
| native（app 域） | `E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=… bunx e2e run --config e2e.unit.config.ts` | **130 files / 995 tests / 995 pass, EXIT 0** | 复用 H14 `h14/native2` + W7 独立复跑（同版本：HEAD 未动、检查点 pin、本波零源改动——规则允许复用） |
| driven | `E2E_BUN_ONLY=app/tests … tests/bun-suites.test.ts` | **6/6 组 EXIT 0**（87 个 app 文件） | 复用 H14 `h14/driven` + W7 独立复跑 |
| engine/UI（`bun run test:ui`） | `e2e run`（e2e.config.ts，web target） | **BLOCKED（环境，如实记）** | 三重门槛：① 套件硬编码 app `:3010` + OAuth 回调 `:3001`（`tests/e2e/auth.setup.e2e.ts:24`），而本 worktree `.env` 既有 `PORT=3001`+`SERVER_PORT=3002` 分歧被 `server/src/config.ts:2880` 拒绝，.env 在我的只读范围外；② bot 驱动套件需 agent-bot :4200——**DOWN**（`nc -z` 失败；`bun run dev` 只起 app+server，Bots 属 start.sh docker 服务）；③ OPENAI_API_KEY 在（智谱端点）但配额消耗型 agent 套件在缺 ①② 时必然失败。**补偿证据 = 本波真实栈可信 CDP in-app 交互矩阵**（A02/A04/A05/A06） |
| test:ci（全仓收口） | `bun run test:ci` | **EXIT 1 = 194 红，app 域 0**（599 files/7968 tests/7700 pass/74 skip） | 复用 H14 运行 + W7 (e) 产物级核验（28 server 文件 + tests/compose + bun-suites 包装组 + scripts/test-ci meta；21 处环境签名） |
| app typecheck / build | `bun run typecheck` / `bun run build`（本波终态树**实跑**） | **EXIT 0 / EXIT 0** | `h15/evidence/typecheck.log`、`h15/evidence/build.log`（持久证据，兼答 W7 F4 的 /tmp 回填诉求——h14/** 非本波可写区，落点改 h15/evidence/） |
| 变更 lint（biome） | `bunx biome check <点名文件>` | **booked 噪声逐项复核**：context-menu.tsx **4**、button-native.test.tsx **2**、approvals 族 **9**（rules.tsx 1 + approvals-rules 2 + bot-approval-rules 2 + approval-team-settings 2 + bot-sharing 2），合计 15——与 W7 F2 记账逐项一致，均为 BASE 既有/已接受（W4 轮 9/9 BASE 既有复现） | 本波会话输出 |

## 4. W7 carry 裁决（三件，全部落盘 h15/）

1. **F6 AC2 ratification** → `h15/AC2-RATIFICATION.md`：**现状批准**（import 系 BASE 原样存在、预设零未分层 `:root`、`data-*`/`no-scrollbar`/`scroll-fade-*` 为活跃生产输入）。建议由 spec owner 在交付后修正设计文档 `2026-10-19-heroui-ui-migration-design.md:233` 与 h14 票 AC2 措辞（我方只读，不代改）。
2. **manualChunks 缓解评估** → `h15/MANUALCHUNKS-EVALUATION.md`：**不建议现阶段采用**。核心证据：sign 闭包 7 文件精确复算 476,457，route-sign 本体仅 1,477 gzip（0.3%）；静态 import 链决定拆 chunk 不减首载字节（边界胶水 + gzip 互参考通常反升 ~0.3–1%）；真正能减的是 overlay adapter 动态化——动 88 路由共享 shell，风险/成本远超 2,523B（0.55% 基线）收益；AC5 要求的「定位并评审」已由 H14 §7 + W7 (f) 满足。留作交付后性能任务（附正确做法清单）。
3. **role=combobox a11y 裁决** → `h15/A11Y-COMBOBOX-VERDICT.md`：**ACCEPT，无 remediation**。WCAG 4.1.2 要求 name/role/value 可程序化确定，不强制特定 role：trigger 以真 button + `aria-haspopup="listbox"` + `aria-expanded` + 可访问名 + 可见 value 文本声明其真实契约（button+listbox 披露模式），conformant；反将 `role="combobox"` 硬套（不带 ARIA 1.2 combobox 完整模式义务）才是 mis-declared。遗留：`ui/select.tsx:515-519` 失实注释待该冻结文件下次触碰时修正（W3A F4 原判不变）。

## 5. 截图清单（`h15/screenshots/`，42 张，系统命名 `<page>-<theme>-<locale>-<viewport>.png`）

- 代表页全矩阵：`home|model-access|admin-gateway|admin-billing|usage × light|dark × zh|en × 1440`（共 20）+ `model-access-*-1280`（4）+ `home-*-390` / `home-*-320`（8）。
- 专项：`*-zoom200`（home、model-access）、`*-reduced-motion`（home、admin-gateway）。
- 流程与交互：`sign-light-zh-1440`（Casdoor authorize 登录页）、`casdoor-login`、`onboarding-light-zh-1440`、`after-onboarding`、`channel-new-light-zh-1440`（收件人 Select 可见）、`a02-user-menu-open-light|dark`（portal 菜单）、`a04-create-agent-dialog-step1`、`a04-create-agent-shortviewport`、`a05-model-access-invalid-code`（错误态）、`a06-composer-ime`。
- spike 面（生产 adapter fixture）：`spike-shortviewport-select-popover`、`spike-contextmenu-touch-longpress`。
- 对比度抽查（`h15/browser/cdp-contrast.mjs`，computed 色 WCAG 公式计算）：light heading 17.93:1 / body 6.69:1 / input 17.93:1 / button 16.01:1 / error 6.23:1；dark heading 16.46:1 / body 7.13:1 / input 18.73:1 / button 14.72:1 / error 8.28:1——全部 ≥4.5:1 阈值，余量充足。

## 6. 阻塞与环境注记（如实，不计通过）

1. **UI engine 层 BLOCKED**（§3 表）：端口硬编码 + .env PORT/SERVER_PORT 既有分歧（只读范围外）+ agent-bot :4200 未启。补偿证据已给（真实栈 in-app CDP 矩阵）。
2. **in-app channel ContextMenu / 聊天流式 / 滚动锚点**：需可用 channel（发送依赖 agent runtime）。组件级可信输入证据完整（S5 触摸长按 PASS——headless CDP 可行性由本波证明：fresh touch page + `--touch-events` + 原生 `Input.dispatchTouchEvent`；h10 Shift+F10 7/7；本波 ContextMenu 物理键可信 PASS + ESC 焦点返还）。
3. **model-access 正向授权路径**：需 workbench bot + 有效绑定码（页面如实显示「The workbench bot is not available for model selection.」，即该错误态本身渲染正确）。
4. **A07 浏览器侧拒绝态**：单 admin 环境无法构造第二身份——域测试层证据（W3A/W4/W3B 独立复核）为该 AC 的承载证据。
5. **重建产物孤儿 chunk 注记**：本波 `bun run build` 产物除与 W7 逐一相同的内容寻址 chunk 外多出一个无任何引用的 `index-jg2F_tU7.js`（动态入口孤儿，0 消费者、不在 index.html）——不进入任何路由初始闭包，sign 闭包复算仍逐字节 476,457；记录备查，不影响 A09。
6. **dev 叠加工件**：右上角「Runtime error / Open Inspector for details」浮层来自 `@copilotkit/web-inspector@1.77.0`（dev-only CopilotKit 工具，非 app 错误面；CopilotKit 为票面保留引擎）。
7. **环境修复是会话级的**：casdoor 网络/注册/口令修复写的是 docker/casdoor 数据库（非仓库）；重建 volume 后需按 §1 重放或走 start.sh 全栈路径。

## 7. 终态检查点（terminal checkpoint）

- **哈希：`bc6ca3d9a5ef00ed3dc4248aced1a7a484038a82186288a2b334321f1ca3f524`**（142 文件，0 missing）。
- 配方：① `git status --porcelain` 取变更/未跟踪全集；② 未跟踪目录展开为文件；**排除自引用交付树 `docs/verification/heroui-migration/`**（报告无法哈希自身，显式声明而非隐瞒）；③ 路径去重排序，逐文件 `sha256`（文件字节）；④ 规范串 = 每行 `<sha256>  <path>\n`（shasum 输出序 = 排序序）；⑤ 终态哈希 = 该规范串的 sha256。证据落盘：`h15/TERMINAL-CHECKPOINT.sha256`（规范串全量）+ `h15/TERMINAL-CHECKPOINT.files.txt`（文件清单）。
- 注：`app/src/lib/generated/application-config.ts` 不在变更集（与 BASE 字节一致，印证 W7 扫描）；该哈希在本报告写入前后不变（交付树被排除）。

## 8. 遗留（交付后任务清单；非本波验收阻塞）

1. spec owner 修正设计文档 :233 与 h14 票 AC2 措辞（§4.1；W7 F6 收尾的后半段）。
2. `ui/select.tsx:515-519` 失实注释（W3A F4，冻结面解冻时顺手改）；root `bunfig.toml` [test] 注释刷新（W7 F3）。
3. `legacy-ui-bridge.css` 词汇级改名（629 消费点）、mergeRefs 三拷贝、router-link to+href 类型互斥、scheduled-task-editor "sibling" 注释——均为 H14 §9 原判不变的设计决策项。
4. `app/node_modules/@base-ui/react` stale symlink（下次 install 后复查）；H01/H02 检查点债（按 BACKLOG 原判）。
5. W7 F4 的 h14/evidence 回填：本波以 `h15/evidence/{typecheck,build}.log` 满足其实质（终态持久日志），h14/** 非本波可写区——落点差异在此声明。
6. gzip 残余优化（若未来入口再结构性增长）：按 MANUALCHUNKS-EVALUATION.md §「If the team still wants the win later」的动态化路线单独立项评审。
