# #376 终审后修复波方案（FR-1..5，2026-10-25）

依据：`reviews/final-review.md`（三结论 FAIL；FR-1 HIGH、FR-2/3/4/5 MEDIUM，全部有代码位与探针证据）。终审通过的处置：五项全有效，建四任务；完成后**重做完整终审（r2）与 OCR**。

| 任务 | 范围 | 要点 |
| --- | --- | --- |
| FIX-F1（HIGH） | 旧生产记忆路径公司隔离：`memory/store.ts` eligibleRows/list、`memory/routes.ts` GET /api/memory、`ingestion.ts` contextFor、`tools.ts` recall/personal tool 目录、`index.ts` 生产接线 | 归属不可证的历史行按 `legacy-migration` 0209 先例入隔离（不猜公司）；企业部署下旧工具/列表/写入解析 trusted scope 并按 (tenant, principal) 过滤或拒服务；新增「同一全局用户×两公司×生产 route/tool 越权」断言 |
| FIX-F23 | FR-2 eager retain 绕预算（preference 确认/编辑/更正、source-bound 确认/编辑五入口统一过 admit/settle/release 或入队）+ FR-3 reservation 检查与插入同事务（查重/锁 cap/读 usage/插入一体化，同键唯一冲突返回既有预留） | cap=0 零远端调用且 work pending；成功恰一次计量；真实多连接并发探针 cap=1 两任务至多一项准入 |
| FIX-F4 | 依据展开/判断审核/更正/清理进度的**用户界面**（app）：判断候选列表+确认/编辑/拒绝、回答依据展开与更正/遗忘入口、清理进度状态 | 遵守 screen-layout/data-access/copy 三技能；正向+失权 unavailable+状态区分用例 |
| FIX-F5 | 降级与 query-less context 的二次授权读（行读取后 re-read，前后约束同时满足）+ 误导注释修正 + loadRecallEligible 挂起期撤权的确定性交错测试（覆盖 degraded 与生产 context） | 与 indexed 路径同撤权规则 |

顺序：四任务并行（K=4）→ 各自独立审核 → 串行合入 → 组合树验证 → **终审 r2（全范围重做）** → OCR → 交付报告。
