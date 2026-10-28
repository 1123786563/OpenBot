# #376 修复波方案（r1 审计后，2026-10-24）

依据：`verification/g1-report.md`（F-G1-1..7）、`g3-report.md`（F2/F3）、`g2-report.md`（F1–F5）及对应 r1 独立审核（全部 CONFIRM）。动态状态见 `dag.json`；本文件只写方案。

## 修复任务分解

| 任务 | 范围 | 来源 finding | 验收要点 |
| --- | --- | --- | --- |
| FIX-3（已派发） | 两测试文件 fixture 短化 | F-G1-6 | 两文件全绿 + memory 回归绿；本地提交 |
| FIX-W1 | #392 生产接线：①两开关本人作用域服务端入口（读/写）；②usage 门覆盖 legacy 召回面（`contextFor`/`recall`）；③learning 门覆盖 `formMemory` 与连接器 `completeSync`；④派生判断候选 30 天过期挂入既有 sweep | F-G1-1(HIGH)/2/3/5 | 每项集成测试：入口鉴权与作用域、暂停后 legacy 注入/工具召回为空、暂停后候选不产生、过期任务清派生候选；恢复语义不变 |
| FIX-W2 | 生产同步/确认接线：sync-queue 实例化+排空调度；确认/编辑/遗忘生产写路径（记录 sync work + revocation）；敏感性门复用 `classifyMemorySensitivity`（凭据拒收/敏感二次确认）；`syncStatus` 状态出口 | G3-F2、F-G1-4 | 端到端集成测试：确认→work 行→排空 retain→状态 indexed；敏感性拒收；遗忘→阻断+撤销记录；宕机排空重试 |
| FIX-W3 | App 面：记忆设置页两暂停开关（screen-layout settings-row 模式）+ 同步状态展示 + （若 #396 场景要求）通用偏好确认入口 | F-G1-1 的用户面、#382 确认 UX | openbot-data-access（queries/mutations 经 client）+ screen-layout 规范；e2e 或组件测试 |
| FIX-4 | 卫生批：19 孤儿 SQL 删除（先核与 journal 对应文件等价）、compose 内联 digest、README 保留窗口表述、`hindsight-sync.ts` CHECK 声明同步、G1 时间线措辞 | G3-F4/F3、G2-F1/F2/F3、RG1-1 | 迁移 fresh 库复跑全绿 + diff 审阅 |

## 顺序与再审计

- FIX-W1/W2 合入集成分支后，#392、#384/#385 的审计结论需**补充再审计**（r2，针对性验证新增量），通过后才进 N-A。
- FIX-W3 依赖 FIX-W1/W2 的路由契约；FIX-4 随时可跑。
- 全部修复集成后重跑受影响回归，再进 N-A 聚合验收 → Codex 终审 → OCR。

## 设计约束（FIX-W1/W2 共同）

- 身份：一律复用 `resolveHindsightBankScope(scope)` 可信派生；legacy 面调用点（copilot 中间件、memory 工具、headless sweep）按各自已有的会话/任务 scope 解析 (tenant, principal)，不得接受客户端提交的 bank/principal。
- 语义：暂停=停新增/停召回，不删记录（`pause-controls.ts` 既有语义）；候选过期只清未处理候选。
- 敏感性：链侧 confirm/retain 复用 `server/src/memory/sensitivity.ts` 分类器；凭据拒收；医疗/财务/客户资料走「本人明示+二次确认」。
- 接口：经既有 `/api/memory` 路由族扩展，遵守 openbot-data-access（app 侧全部经 `client.ts`）。
