# 波次 15 批集成 brief（MT123/MT029/MT073/MT060/MT099 → EXE）

角色：集成实现者（本树=EXE，允许修改；零 git 提交）。

## 1. 输入（五棵实现树，交付以树内为准）
- MT123 …/w15-mt123（代码 4：startup-defaults.ts、index.ts、entry-context.test.ts[w15d 令牌]、startup-defaults.test.ts）
- MT029 …/w15-mt029（代码 8：credential-lease.ts、schema、窄缝×3、测试+support）
- MT073 …/w15-mt073（代码 8：company-finance-visibility.ts、schema、窄缝、测试+support、entry-context.test.ts[w15e]）
- MT060 …/w15-mt060（代码 8：openmuse-task-tenancy.ts、schema、窄缝、测试+support、entry-context.test.ts[w15b]）
- MT099 …/w15-mt099（代码 5：rust 三修改+credential_namespace.rs 新+entry-context.test.ts[令牌]）
- 五票 archive/plans/multitenancy-execution/checkpoints/MTXXX/ 与 archive/plans/multitenancy-execution/reports/MTXXX.md 全量 cp（-uall 语义：含 mutation/、verification/、migration/generated/ 全部嵌套文件）。

## 2. 共享文件合并（纯追加按票号升序）
- migrate-test.ts/migration-tool.test.ts：MT029+MT073+MT060 三票任务块/断言（穷举断言为权威）。
- schema/index.ts：barrel += enterprise-credential-lease、company-finance、openmuse-task-tenancy（排序位正确）。
- src/index.ts：MT123 startup-defaults 装配段+MT029 credentialLease 装配段并存。
- **entry-context.test.ts 令牌根治（授权整改，非追加）**：四票各自 RECTIFIED 为不同库名（w15d/w15e/w15b/w15?）——集成统一**改为从 TEST_DATABASE_URL 派生断言值**（读 env 解析库名再断言，语义不变、跨环境自适应），diff 落盘+双哈希披露；根治后聚焦 21/0 复跑。
- rust 面：lib.rs/organization_auth.rs/org_context.rs 三票中仅 MT099 修改（MT099 基线=272 清单 rust 哈希）→直接落位 MT099 版+credential_namespace.rs 新增。

## 3. 批终验（三步配方从零，修正链序）
- 库名 openbot_enterprise_w15int_*，端口 55591；链=base→19 前置→MT029→MT073→MT060（票号序，穷举断言权威）。
- bun 全量：预期 **1222 pass / 0 fail / 47 文件**（=1124+24+27+16+31）；偏差逐票归因。
- cargo 全量：**741 passed**（基线 719+MT099 22）。
- typecheck 0；biome 触及文件 0（migrate-test.ts 若再现排版残留即 --write 微修+digest 复验，wave14 F-2 先例）。

## 4. 产出
- archive/plans/multitenancy-execution/checkpoints/wave15-integration/{manifest,provision,apply-chain-journal,full-suite,cargo-suite,typecheck,biome,token-refactor-diff}.txt
- archive/plans/multitenancy-execution/reports/wave15-integration.md（合并明细+终态+对照表）
- archive/plans/multitenancy-execution/checkpoints/MT{123,029,073,060,099}-integration/integration.json
- dag.json 五票→verified；结束 docker rm+env 删+worker_done。禁止 git 提交/find /。
