# 验证与证据计划

状态：待用户审阅；命令来自当前 package scripts、ADR0008、e2e.unit.config.ts、e2e-bun-suites.json，**本轮未运行生产测试/构建/浏览器验收**。文档检查结果另见 validation.json。

## 1. 每个 Task 使用的真实命令

以下命令在仓库根运行。执行前把 `t01/r01` 替换成当前 task/round 的字面值；每轮独立目录，禁止覆盖前轮 report。未来授权实施后可写 `.archive/runs/2026-10-20-workspace-redesign-b1/verification/`；本轮仅 refinement/ 可写。根 `build/typecheck` 会覆盖所有工作区，前端日常使用 app script。app 的 prebuild/pretypecheck 会执行 generate:app-config，因此检查点需要在命令后重新核对，任何生成文件变更都不能漏记。

**V-STATIC**

```bash
bun run --cwd app typecheck
bun run --cwd app build
```

来自 app/package.json 的 tsc --noEmit / Vite build。预期各 exit0；warning 必须记账，不隐藏 chunk 膨胀。对本 Task 实际改动的 `.ts/.tsx/.css/.json` 文件，使用参数数组逐项传给 `bunx biome check`（无 --write），禁止把所有脏基线自动当成本次文件；如 `bunx biome check app/src/components/ui/input.tsx app/src/styles/tokens.css`。Markdown 不强塞 Biome。既有噪声需用前快照复现，不能直接关闭规则。构建同环境对比首载JS/CSS gzip，增加>10%定位并审阅。

**V-NATIVE**

```bash
E2E_UNIT_SCOPE=app E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t01/r01/native bunx e2e run --config e2e.unit.config.ts
```

预期 exit0、非零用例，report.json 中 app 原生文件被收集。按 config，清单中的 driven 文件会被排除；此命令**不能**代替 driven 验证。需要缩小到现有原生文件时可在命令末追加该文件，先在清单确认其不是 driven，否则会收集0条。

**V-DRIVEN**

```bash
E2E_BUN_ONLY=app/tests E2E_UNIT_OUTPUT=.archive/runs/2026-10-20-workspace-redesign-b1/verification/t01/r01/driven bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts
```

该选择器按 group.name.includes 筛选，当前匹配 app/tests part1–4、app/tests/ai-observability、app/tests/multitenancy，共6组。预期6组实际执行、每组非零用例、exit0；driver 中存在超时/重试上限，不能把 skipped/no group 认作通过。`app/src` 组另用 `E2E_BUN_ONLY=app/src`，T16上传队列行为涉及它时追加独立输出目录。单个 driven 文件诊断可用 `bun test ./app/tests/button-native.test.tsx`，必须从根 cwd 读取 bunfig/preload；它是诊断，不替代 e2e 汇总入口。

根 `bun run test:ci` 留给 T21 全站收口（会触发audit/native/driven与全仓依赖），不能用前端绿掩盖全仓红。每轮保存真实日志、exit code、collected/pass/fail/skip、环境探测证据和 checkpoint hash。已知 H15 `test:ci` 194 红是历史记录，不能预先断言此次也红或已修好。

**V-BROWSER**

浏览器场景不是纯静态视觉索引。使用已配置工具/受控浏览器与真实 app 页面。`bun run test:ui` 的 e2e.config.ts 指向 `http://localhost:3010`、workers1、LLM engine；它需要相应服务、OAuth回调和模型/运行时。不能把3011的手工场景直接当成3010自动套件已通过。本稿不改该config。

本稿推荐沿 H15 已验证的端口组合搭建独立场景：app `http://localhost:3011`，API `http://localhost:3002`。以下只作后续启动命令，不在本轮执行、不自动改.env/数据库/容器：

```bash
# 终端A，工作目录 server/
env PORT=3002 bun --env-file=../.env src/index.ts
# 终端B，工作目录 app/
env APP_PORT=3011 SERVER_PORT=3002 bun --bun node_modules/vite/bin/vite.js --port 3011 --strictPort
```

已有服务时先确认占用者和版本，不杀未知进程。受控Browser必须能登录、Bot runtime能响应、权限身份可构造；没有则记录具体阻塞，继续组件/DOM和静态验证，生产流式/拒绝验收不签收。不得沿用H15会话级容器或凭据修复而声称环境一定可用；不把旧报告中的秘密复制到证据。

## 2. 首批 URL、fixture 与检查点

可直接访问的正式产品 URL：

- `http://localhost:3011/`（P01），`http://localhost:3011/bots`（P06），`http://localhost:3011/channel/new`（P02），`http://localhost:3011/bot`（P05）。
- P07–P23 使用实际已授权 Bot 的 ID：从产品 Bots 列表真实链接取得并在 evidence-index.json 固定最终URL，不猜测 agentId。P03/P04 从已有频道/群聊链接取得实际 channelId；无安全测试频道时需要受控测试部署，不能把虚构 ID 当运行成功证据。
- 模板仅供实例化：`http://localhost:3011/bots/$agentId`、`/bots/$agentId/setup`、`/bots/$agentId/runs/$bindingId`、`/channel/$channelId?settings=true`、`?watch=true`、`?workshop=true`、`/group/$channelId`。所有 `$...` 必须在验收清单替换为服务真实返回值；未替换的行状态=blocked，截图不得签收。
- 后续参照页：`http://localhost:3011/settings`（P29）、`/craft`（P26）、`/admin/knowledge`（P58）；P27/P59 的 sessionId/kbId 同样从现有授权产品链接取得。B1只做这些受共享样式影响页面的冒烟，不签收B2/B3/B5专项。

当前缺口精确为：未读取运行中的租户/身份/频道/数据集/运行ID，未探测3011/3002服务、Bot/沙箱/预览服务就绪；本轮权限为文档细化，因此不启动/写入测试数据。T08的真实数据场景依赖未来取得安全测试fixture，不是靠浏览器地址模板就已可执行成功。最少人工输入是“可用测试部署/身份与数据入口（或允许在隔离测试部署准备fixture）”；不索取凭据明文。

fixture 需求：一个管理员、本人可管理Bot、他人共享只读Bot、不可访问Bot；有待办/置顶/自己/共享/隐藏的名册；单聊/群聊各一、已存在的只读运行/数据集/导出；受控失败响应；两主题两语言长内容。先确认是否能利用已有数据，禁止在真实公司触发付款、清理、授权、删除或外发消息来凑截图。需要发送/停止时使用测试Bot与测试频道，显式标注数据来源。

每个场景绑定同一后检查点；跨场景代码变化后只复用受影响范围之外且hash一致的证据。文件名 `P03-dark-zh-390-normal.png`，目录含task/round/checkpoint；索引字段如下：

```json
{
  "page_id": "P03", "task": "T07", "checkpoint_sha256": "实际哈希",
  "url": "实际URL，不含占位符", "role": "测试成员", "tenant_scope": "脱敏测试范围",
  "fixture_source": "受控测试部署/fixture版本", "state": "workshop-open",
  "theme": "dark", "locale": "zh", "viewport": {"width": 390, "height": 844},
  "dpr": 1, "zoom": 1, "screenshot": "相对路径", "trace": "相对路径",
  "result": "pass/fail/blocked", "environment_evidence": "服务探测记录路径"
}
```

索引不是生成304张结构草图：仅实际发生的截图/操作trace有证据资格。主题图说明视觉方向、visual-atlas说明结构、产品截图证明最终DOM，三类不能相互替代。

## 3. B1 浏览器检查表

每个P01–P23：正常态在390×844/768×1024/1280×800/1440×900 × light/dark × zh/en（共16基础组合）；异常/权限/长内容按route-acceptance至少在390与1440两端、两主题检查；所有状态组合不必笛卡尔积，但缺项需说明。P06/P07/P03另外1280×800下200% zoom、reduced-motion。所有图附操作结果，不能只拍首屏。

| 场景 | 操作与断言 | owner |
| --- | --- | --- |
| B1-A theme/portal | 两主题首绘无错色；原生HeroUI+wrapper computed background/foreground/accent/muted/field border；创建Bot Dialog中Select/Menu主题一致，ESC先关popup再关Dialog、焦点返回 | T01/T02 |
| B1-B shell preference | 各壳展开→折叠→刷新；resize不变更SIDEBAR_STORAGE_KEY；显式toggle才存；快捷键/skip-link/Drawer可达 | T03 |
| B1-C detail | C=879/880（400右栏）与959/960（480右栏），记录容器rect与sheet/inline DOM；跨断点不改search、不丢打开表单draft；关闭仍按原逻辑卸载 | T03/T07 |
| B1-D Bots | 需要你/置顶/自己/共享/隐藏顺序，隐藏默认折叠且可展开；失败与空分开；长名称操作不被推出 | T04 |
| B1-E profile/config | P07待办/活动优先、配置管理全部展开；P08–15各打开实际弹窗/菜单，保存失败保留输入；只读成员无敏感值或假管理入口 | T04/T05 |
| B1-F observation | P16→17父Outlet直达/Back；P18–23加载/同步/未配置/无数据/上游失败分别；非canManage直达拒绝；比较单位方向与缺失可辨 | T06 |
| B1-G conversation | 首页/新对话选择Bot；IME组合Enter不发送、确认后发送一次；首条失败保留文字/附件；stop/retry/流式滚动与100条历史；群聊身份顺序 | T07 |
| B1-H context | settings/watch/workshop互斥、Back关闭、自动watch按原行为；电脑控制释放、长文件/工作坊区不另造任务状态 | T07 |
| B1-I overflow | 所有页检查document.scrollWidth≤clientWidth；允许的代码/表格/预览具名容器滚动；键盘Tab顺序、触控44px、200%下提交可达 | 各Task |

主题控制的几何断言：expanded宽280/256、rail总宽64；prose672/wide1024/message720均是max-width，不要求小视口溢出达到固定宽。对比度基于computed颜色+实际底面（含soft混色），普通文本≥4.5、必要边界/焦点≥3。色值方案静态测量见 contrast-check.json，不代替DOM测量。

T03改动影响全站共享骨架，B1中补测P24/P28编辑Sheet、P29设置、P59知识库、P27 Craft现有布局、P71登录的基础可达/主题；这些只证明未回退，不能宣称未来专项已完成。

## 4. 检查点、Review 与 OCR

未来启动先冻结PRE：HEAD、完整status、tracked staged/unstaged二进制diff、每个范围内untracked完整内容与哈希；既有脏基线单独存储。POST与PRE比较得到真实task增量package，包含新增/删除文件；验证索引绑定POST SHA256。文件变化后受影响证据重做。

独立frontend_validator不改源码/测试；reviewer只读，分别出Spec compliance与quality。有效critical/high/medium修复后补验证和复审，不能由实现者批准自己。T08只覆盖B1，T21覆盖全站。未来实施按届时授权使用SDD；本轮不派Agent。

OCR由未来主控先读open-code-review skill，始终 `--audience agent`。当前无提交授权，使用该CLI实际支持的workspace模式审查暂存/未暂存/untracked完整交付；不要杜撰未核验的workspace旗标。原BASE=当前HEAD时空BASE..HEAD无意义。若后来出现已提交交付，额外按记录的真实BASE/HEAD范围review；不能用workspace代替已提交范围。既有脏迁移仍保留：完整workspace报告中的finding需按PRE归因，真实新增增量和完整交付范围都须覆盖，不能把旧问题自动算新增或凭“旧代码”忽略本次改动造成的回退。每轮保存scope/exit/coverage/skipped/warnings/provider，凭据或覆盖失败=阻塞。
