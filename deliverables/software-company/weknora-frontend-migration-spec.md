# WeKnora 前端 → OpenBot 迁移规格（Migration Spec）

> 主理人：齐活林 ｜ 2026-10-11 ｜ 事实来源：research-weknora-fe + research-openbot-fe 两份研究报告
> 性质：实施规格（工程师直接以此为蓝本实现）

---

## 0. 关键裁断（先读）

**C1 范围分期（最重要）**：WeKnora 前端调 40+ 端点，但上游 KB-Service（今日的 Go 版与明日 kb-mastra 版）对外契约只有 **10 条路由**。逐字段对照后，WeKnora 页面能力中大量依赖的端点（chunk 编辑/文件夹/标签/批量下载/Wiki/FAQ/时间线/跨库移动/KB 更新）**上游不存在**。强行 1:1 移植 = 死 UI。
→ **本期（F 系列）只实现上游可支撑的能力**；其余进 §3 二阶段清单（上游解锁后按同一映射规则平移）。

**C2 样式体系**：WeKnora 用 TDesign 卡片网格 + t-组件体系；OpenBot 是 Base UI + PageShell/PageRows/Item 的「仪器级控制台」设计语言，且**无 toast/table/tabs/popover/progress 现成组件**。按用户要求「按 OpenBot 技术栈适配重构 + 尽量复用已有组件」优先于「样式逐像素不变」——**视觉骨架采用 OpenBot 设计系统，保真对象是：信息密度、交互行为、功能覆盖**（见 §6 替代方案说明）。

**C3 纯逻辑直移植**：WeKnora 的框架无关 TS（带上游单测）几乎免费——上传队列三件套、排序/合并/停顿判定等直接平移（axios→fetch），这是「一对一移植」精神最忠实的部分。

---

## 1. 技术栈映射规则（写代码前必读）

| WeKnora（Vue 3 + TDesign） | OpenBot（React 19 + Base UI） 替代 |
|---|---|
| `t-dialog` / DialogPlugin 命令式 | `components/ui/dialog`（确认流照抄 `components/bot-profile/profile.tsx:110-200` 危险操作模式） |
| MessagePlugin（toast） | **app 无 toast**（channel.tsx 注释明示）。用内联 `<p role="alert" className="text-destructive">` + 成功态文案切换（知识库页现状同款） |
| `t-table` 文档列表 | 裸 table 惯例（`routes/_authed/admin/audit.tsx:121` / `components/billing/consumption-table.tsx:65` 先例）：`w-full text-left text-sm` + thead `text-xs uppercase muted` |
| `t-popup`（more 菜单/行内弹出） | `components/ui/dropdown-menu`；简单悬浮信息用 `tooltip` |
| `t-select` / 原生 select | 优先 `components/ui/select`；临时同款原生 select 样式串仅限沿用现状 |
| `t-loading` / ProgressRing | 无 progress 组件：解析状态用状态徽标（`rounded-full bg-primary px-1.5 text-[11px]`，bots.index.tsx:73 先例）+ task progress 文本 `N/M chunks` |
| Pinia store（服务端状态） | TanStack Query（queryOptions 工厂 + invalidate 惯例，照 lib/knowledge.ts 现状） |
| Pinia store（上传队列，跨页存活） | 模块级单例 + `useSyncExternalStore` 订阅 hook（uploadQueue 纯逻辑平移后包一层） |
| deep watch cardList → 轮询 | `useQuery refetchInterval` 回调式条件轮询（现状 2s 模式保留，升级见 F3） |
| `provide/inject`、v-model、Teleport | props 回调 / 受控 state / Dialog+Sheet（既有组件） |
| axios request.ts 封装 | `lib/client.ts` getJSON（credentials include + 错误信封）；文件上传走独立 XHR（见 C4） |
| vue-i18n 扁平大包 | i18next ns="knowledge"，**en/zh-CN 双语同步新增**（t() 强类型，缺 key 编译失败） |
| `directives/stableHtml`（v-html 消毒） | DOMPurify + dangerouslySetInnerHTML（仅检索结果展示如需；优先纯文本渲染） |

**C4 上传进度**：fetch 无上传进度事件 → `uploadDocumentFile` 重写为 **XMLHttpRequest** 封装（`xhr.upload.onprogress` → progress 回调），保持同一函数签名 + credentials。WeKnora 的 ProgressRing 视觉降级为进度条形（`bg-primary` 宽度百分比 div）+ 百分比文本。

---

## 2. 差距矩阵与本期动作（F 系列）

上游 10 路由（全部已代理在 `/api/knowledge/*`，**代理层零改动**）：kb CRUD×4、documents 列表/创建/单查/删除、tasks 单查、retrieve。

### F1 lib 层扩展（`app/src/lib/knowledge.ts` + 新 utils）
- `documentQueryOptions(kbId, docId)`：封装 GET documents/:docId（后端已有、前端未接）
- **接线 taskQueryOptions**（已定义未用）：上传/解析进度改用 task 级轮询
- XHR 版 `uploadDocumentFile(kb, file, {onProgress, signal})`（C4）
- 新 `app/src/lib/knowledge-format.ts`：`formatFileSize`（B/KB/MB，WeKnora utils/files.ts 直译）、`formatStringDate`
- 新 `app/src/lib/knowledge-sorting.ts`：`documentSorting` 六组合（updated_at/created_at/title × asc/desc）直译 + 单测（bun test，放 `app/src/lib/knowledge-sorting.test.ts`）
- 类型补充：`KnowledgeDocumentFilter`（keyword/status/type 本地筛选用）

### F2 上传队列移植（WeKnora 直复用资产，`app/src/lib/upload-queue/`）
- 平移 WeKnora `stores/uploadQueue.ts + uploadTasksCore + uploadTasksState`（369 行核心）：有界并发（默认 3）、dedupKey=`kbId:fileSize`、AbortController 取消（body 发完的 saving 阶段禁取消）、失败重试（1 次）、settled 合并通知
- 包 `useSyncExternalStore` hook：`useUploadTasks(kbId)` → {active, settled, enqueue, cancel}
- UI：`components/knowledge/upload-tasks-panel.tsx`——详情页固定区（非全局浮层，OpenBot 无全局浮层惯例）：活动任务行（文件名 + 进度条 + 取消按钮）+ 失败重试行
- FormData 字段对齐上游：`file` + `title`（文件名）

### F3 KB 详情页升级（`knowledge.$kbId.tsx` 重构）
- **筛选工具栏**（客户端过滤，数据源 documents 列表）：类型（file/url/text）、解析状态（pending/processing/completed/failed）、关键字（debounce 300ms）——WeKnora 17 类文件类型/15 来源裁剪为上游存在的 3 类型（矩阵二阶段项）
- **排序**：F1 sorting 接入（表头点击切换，asc/desc 箭头）
- **解析进度**：上传返回 {task_id, doc_id} → `taskQueryOptions` 2s 条件轮询（status∈pending/processing 时），行内显示 `progress% · chunks_done/chunks_total`；task completed 后 invalidate documents。**替换**现有整表 2s 轮询为：仅当存在活动 task 或文档 status 非终态时轮询 documents（降频 5s），否则停
- **删除确认**：文档删除与 KB 删除补 Dialog 确认（bot-profile 模式，含标题红色强调）
- **批量删除**：checkbox 多选（shift 范围选，WeKnora DocumentListView 交互直译）+ 批量栏（选中 N 项 · 删除按钮）→ 循环单删 + 完成后 invalidate（客户端编排，N≤50）
- **检索测试增强**：暴露 top_k（number input 1..10）与 score_threshold（0-1 step 0.05）+ hybrid switch；结果卡补 metadata.title 显示
- **文档行信息密度对齐**：file_type 图标/文本、file_size（F1 formatFileSize）、created_at（`lib/relative-time.ts`）、chunk_count

### F4 KB 列表页升级（`knowledge.index.tsx`）
- 建库表单升级为 **Dialog**：name（必填）+ description + **高级折叠区**（embedder/chunk_size 默认512/chunk_overlap 默认80/rerank_model）——对齐上游 POST /kb 全字段（CreateKnowledgeBaseInput 已有类型）
- 列表项增强：doc_count 徽标化、description 截断、删除确认 Dialog（替换现状直接删）
- 空态/加载态维持 Empty/文案现状

### F5 i18n + 校验收尾
- `locales/{en,zh-CN}/knowledge.json` 同步补全 F2-F4 全部新 key（双语文案从 WeKnora zh-CN.ts/en-US.ts knowledgeList/uploadConfirm/uploadTasks 段意译迁移）
- 通过：`cd app && bun run typecheck`、`bunx biome check app/src/lib/knowledge*.ts app/src/routes/_authed/_app/knowledge.*.tsx app/src/components/knowledge/`、`bun test app/src/lib/`、`bun run build`（root）

## 3. 二阶段清单（上游解锁后平移，本期不做）

| WeKnora 能力 | 阻塞端点 | 迁移评级（源研究） |
|---|---|---|
| chunk 查看/行内编辑/修订回滚 | GET/PUT chunks/* | 重写级（doc-content.vue 3328 行） |
| 文档夹树/移动 | folders/* | 中等（KbFolderTree 507 行，folderTree.ts 纯逻辑可直移） |
| 标签管理 | tags/* | 中等 |
| 批量下载/文档预览 | download/preview | 中等（blob 处理直译） |
| 重解析/取消 | reparse/cancel-parse | 直译级 |
| KB 设置编辑（14 分区模态） | PUT /kb | 重写级（EditorModal 2321 行） |
| 全局拖拽上传（webkitGetAsEntry 目录递归） | — | 中等（platform/index.vue 逻辑直译） |
| 跨库移动 | move/* | 中等 |
| Wiki/Gallery/FAQ/时间线/上传确认高级配置 | wiki/faq/spans/overrides | 重写级 |

## 4. 替代实现方案与理由（用户要求第 5 条）

1. **样式**：采用 OpenBot 设计系统而非复刻 TDesign——宿主一致性是硬约束（同一侧边栏/主题/明暗模式）；保真度转移到信息密度与交互行为层。
2. **上传进度**：XHR 替代 fetch——浏览器 fetch 上传进度事件不可用；XHR 是唯一稳定通道，签名不变可回退。
3. **toast 全部改内联**——app 明确无 toast 体系，引入新依赖违反「复用工程配置」。
4. **批量删除客户端编排**——上游无 batch-delete；循环单删在小 N 下可接受，语义与 WeKnora 收敛轮询一致（invalidate 即时反馈）。
5. **Pinia→模块单例**——上传队列是纯客户端状态，React Query 不适合；useSyncExternalStore 是 React 官方外部存储桥，零依赖。

## 5. 验收标准（QA 蓝本）

- typecheck/biome/build/test 四绿（F5 清单）
- 行为对照：上传多文件（并发/取消/失败重试）、task 进度轮询起停、筛选排序组合、批量删除、删除确认、检索参数透传
- 契约：所有请求仍走 10 条既有路由；无新增代理
- i18n：en/zh-CN key 齐全（typecheck 强制）
