# review.md — Ticket #207 run 2 执行者复审（worktree issue5-207-2）

复审人：本次派发的执行 worker（task_7f4a637f3052 / ctx_15a6323054f7）。
实现本体已由前次派发的独立 reviewer 终审（PASS/APPROVE，含 F1 修复验证）；本次复审聚焦
转移完整性、票面验收逐条、父 Spec 全局约束与检查点形态。

## 1. 验收标准逐条（以本工作树复跑的测试为证据）

| AC | 结论 | 证据 |
|---|---|---|
| 管理员保存合法网关地址后，进程重启读取到的地址与 configVersion 一致 | PASS | 集成测试 "a reconstructed store (restart) reads the same endpoint and version"：新建连接重建 store，读取与重启前逐字段相等 |
| 空值、非 http(s)、带凭据或带 path 的地址被拒绝，并返回可解释原因 | PASS | 单测逐条断言 GATEWAY_ENDPOINT_ERRORS 文案（missing/protocol/credentials/path）；HTTP PUT 非法地址 → 400 + 原因且库内不变；env 启动路径同句子拒绝 |
| 只读查询响应中不存在任何凭据或 Secret 字段 | PASS | 读取形状恰为三字段；GET/PUT 响应与表列名均不匹配 /secret\|token\|password\|credential\|api[-_]?key/i；本表不存任何 secret（凭据归 01.2） |
| 连续两次成功保存使 configVersion 严格递增，且旧版本不可再被写回 | PASS | 三次保存 1→2→3 严格递增；输入不携带版本字段（parse 层即无此字段），upsert 内 `config_version = config_version + 1`，结构性保证只能前进 |

## 2. 票面 Tests to write 逐条

- 保存 → 重新构造 store → 读取一致（专用 TEST_DATABASE_URL 库）：集成测试第 2 组 ✓
- 非法地址逐条拒绝并断言错误信息：单测 parse 组 + HTTP 400 组 ✓
- 非管理员写入被拒绝：单测（403 且 Proxy 不可触库证明零 DB 访问）+ 集成（403 且版本不变）✓

## 3. 父 Spec 全局约束核对

- **固定付款账户语义 / 准入先于供应商 / 未知结果保留预留**：本票为网关配置持久化切片，
  未触及任何计费/预留/供应商调用路径；grep 证实无任何代码消费该配置转发模型流量（网关未启用）。
- **不顺便实施其他 Ticket**：diff 仅 12 个实现文件 + 本票计划/ledger；无 01.2+ 的凭据、
  探测、门禁代码混入。
- **provider fake 不进生产**：无任何 fake/降级路径；测试内 Proxy/专用库均为测试代码。
- **功能准入**：本票交付的配置面未挂载、未启用（app.ts 越界未动），不存在半启用旁路。
- **不 commit/push/deploy、不改父 Issue**：`git diff --cached` 为空，无新提交，未推送。

## 4. 转移完整性

- 12 个实现文件 SHA-256 与前次 f1-repair 终稿清单 12/12 相等（file-hashes.txt）。
- BASE 兼容：本工作树 BASE（bab7c0b9）与前次 BASE（f0520524）在 4 个受修改文件上零差异。
- 迁移在本工作树全新库 openbot_207_2 应用成功且表结构与 schema 一致。

## 5. 质量/风险备注（不阻塞，供下游知悉）

1. `_journal.json` 末尾无换行（drizzle journal 原生形态，前次已审）。
2. 手工构造迁移 0122：受 BASE 既有 drizzle-kit 快照链冲突限制（非本票引入），已用全新库
   全量应用 + 表结构比对替代 generate 复核。
3. `GATEWAY_BASE_URL=""` 按 optional() 语义视为未设置（与 LAGO_* 一致）；管理员保存路径对
   空串有专门拒绝用例。
4. routes/config 未挂载 app.ts：越出本票 write scope，集成点留给 01.7/01.8（挂载代码一行，
   见 checkpoint-report.md）。

## 6. 结论

**APPROVE（交付）**：四条验收全部有测试证据且本工作树复跑通过；typecheck/lint 干净；
唯一回归失败为 BASE 既有且已在本工作树独立归因；检查点未提交、可回退、可续做。
