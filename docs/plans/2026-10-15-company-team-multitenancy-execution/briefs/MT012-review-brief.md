# MT012 / Issue #55 独立复审 Brief — coordinator 下发

你是 MT012 的独立复审者（全新 Pi 会话，与实现者无共享上下文）。只读被审文件；唯一允许新建文件 = archive/plans/multitenancy-execution/reports/MT012-review.md；不修复；无提交/推送/合并授权；skipped/blocked 不算通过。完成按 preamble worker_done --outcome succeeded|failed 附 --report-path。

## 审阅对象

工作树 = BASE f0520524 + 前置转移（prereq-manifest.txt 29 文件，领取时先逐项复算哈希）+ 本票交付：
1. `server/scripts/multitenancy/migrate-test.ts`（声称纯追加：MT012 注册 + 两步迁移——0001 九表 ENABLE+FORCE RLS 再断言、0002 ob_ent_reset_business_context() 清理函数 + REVOKE PUBLIC + 授予三业务角色）
2. `server/tests/multitenancy/migration-tool.test.ts`（窄例外第 3 次：仅 ALLOWED_TASK_IDS 断言 + 3 行注释，声称 pristine 重建核验）
3. `server/tests/multitenancy/rls-core.test.ts`（新 32 用例 310 断言）
- 检查点 `archive/plans/multitenancy-execution/checkpoints/MT012/`（before/after、changes.diff、migration-tool.test.diff、red-green/、mutation/、cli/、generated/、verification/）+ 报告 `archive/plans/multitenancy-execution/reports/MT012.md`。

## 验收（Issue #55 四条）+ 重点裁决项

1. 跨公司 SELECT/UPDATE/DELETE + FK 关联被 DB 拒绝（23503/42501、存在性不泄露）
2. DB 策略与应用规则两侧对照一致（团队公共/所有权/显式分享）
3. 事务后上下文清除 + 连接复用无残留 + 清理函数兜底
4. 无绕过角色；机器读角色单独登记零权限

重点裁决：
- **A. 纯追加与窄例外最小性**：migrate-test.ts 0 删除行、migration-tool.test.ts 唯一删除行=被替换断言行（对照 MT112/MT008 先例 §4 裁决注释形态）；pristine 重建哈希 vs prereq-manifest。
- **B. REVOKE PUBLIC 语义面**：0002 的 REVOKE 只收窄新函数自身默认执行权，不剥夺既有对象授权（expand-only 红线）——逐语句审。
- **C. 两侧对照真实性**：dbSideRead 谓词是否忠实映射应用规则语义（own grant ∨ workspace∧有效成员 ∧ 同团队 ∧ 活跃），是否「为绿而绿」（自证循环）；与 decide()/reader 的对照断言强度（9 例全等 vs 单向）。
- **D. FORCE 语义**：属主也被策略约束的实证（relforcerowsecurity + 属主无策略默认拒绝）。
- **E. 披露处置**：D1（GREEN-1 27/5 测试侧缺陷——无断言弱化？）、D3（catalog 快照经 setup 连接）、D4（停用 stand-in 仅翻转事实、判定侧全受限角色）、D5（403 语义）。
- **F. 变异真实性**：4/4（DB 直改实施不漂移 journal）+ RESTORE 复绿 + 展开核对存档失败用例名。
- **G. 策略模板章节**（报告 §7）供下游复用——模板与实现一致性抽查。

## 独立复跑（必须亲自执行并记录退出码）

1. 端口预检 `lsof -i :55474`；专用容器 mt012-review-pg（pgvector/pgvector:pg16，trust；**psql 探针就绪勿只用 pg_isready**）；五变量 URL 显式用户 + 三登录随机口令 0600 env 用后删不打印。
2. `bun scripts/enterprise-test-db.ts migrate` + `migrate-test.ts migrate MT004 --apply`（前置；MT012/MT008/MT112 由套件 beforeAll 真实 apply，journal 亲验留痕）。
3. `bun test tests/multitenancy/rls-core.test.ts --timeout 30000`（预期 32/0/0skip）
4. 全量 `MT003_ASSIGNED_TEST_DATABASE_URL=… bun test tests/multitenancy/ --timeout 30000`（预期 **264/0/0skip** = 232+32，10 文件）
5. CLI 链：dry-run → generate --out → --apply --manifest → 重复 apply up-to-date（四退出码）。
6. `cd server && bun run typecheck`；`bunx biome check` 三触及文件（预期 0——实现者声称 --write 后 clean）。
7. 抽查 DB 目录：九表 relrowsecurity/relforcerowsecurity、函数 EXECUTE 授权面、expand-only apply 前后 pg_policies 授权快照（报告声称逐字节相同）。
8. 清理容器与凭据。
