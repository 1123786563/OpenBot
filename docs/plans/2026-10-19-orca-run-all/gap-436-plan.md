# #436 迁移链修复 — Implementation Plan（gap 马拉松批 1）

票：#436（P0 fresh-DB 42703）｜ 证据：C1 worker 报告 + 2026-10-19 复测（fresh 库 5565）
现状：163 条迁移（0162 已修 skills.icon）；漂移 = **38 表/292 列**（37 整表 + enterprise_resources.visibility），反向 0；drizzle.config 缺 17 个含表 schema 文件（json.ts 无表不计）；最新 snapshot 0160，0161/0162 无配套 snapshot。

## Tasks

- **T1** drizzle.config.ts 补 17 文件（vendor-billing/enterprise-plugins/enterprise-oauth-state/enterprise-credential-lease/enterprise-sso-scim/job-ownership/enterprise-personal-bot/enterprise-shared-approvals/call-attributions/openmuse-task-tenancy/payer-accounts/personal-shares/company-finance/enterprise-governance-policy/enterprise-credentials/enterprise-runtime-config/enterprise-bot-ownership）
- **T2** `bun db:generate` → 0163 迁移；若报「journal 0162 无 snapshot」，补 0162_snapshot.json（0160 副本 + 0161 check/0162 icon 已内含）再生成
- **T3** 审阅 0163 SQL：只允许 CREATE TABLE / ADD COLUMN / CHECK；逐表核对 = 复测清单 38 表 292 列，无 DROP/ALTER 既有列
- **T4** fresh 库（5565 重建）验证：migrate ok → 漂移脚本 0 表 0 列 → 最小 env `bun src/index.ts` boot 无 42703（AC1+AC3）
- **T5** CI：`.github/workflows/ci.yml` 加 fresh-db boot job（起 pgvector → roles.sql → migrate → boot → 健康探针 → 停）；确认既有 drift probe（:594-624）因 T1 自动覆盖盲区（AC2+AC4）
- **T6** 汇总：drift 探针本地复跑（generate 后 git status 应仅 0163+snapshot+journal）；typecheck；票面 AC 逐条对账

## 风险

- 0163 应用到**既有共享开发库**会撞 duplicate column（那些库被带外补过）——票面只管 fresh；已有库需人工裁定（记入交付说明）
- snapshot 超前（skills.icon 在 0160）不影响 generate 产出（diff 只对 schema↔snapshot，icon 已两侧一致）
