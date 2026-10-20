# [mt 流] 批次票（按序）：#62、#63、#66、#67、#68、#75、#76、#78、#82、#83、#111、#121、#143、#167（MT 域，14 张）

**#62 MT019 特殊路径**：远程分支 1123786563/mt-w1 @ b7832879 已有实现（server/tests/multitenancy/bot-lifecycle.test.ts +841、support/bot-lifecycle.ts +679 等 4 文件）。先 checkout 核验该分支、跑测试、对照 #62 AC 出结论；不重实施。其余 13 张每张先核验 main 已含等价实现（MT 线 A 类 106 张已批量验收，零改动 SATISFIED 预期主流），无等价实现才实施。

DB：TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5562/mt2（容器 orca-w2-mt-pg，pgvector；roles.sql→migrate 顺序见 server/.env.test 配方）。
MT 票正文短（ADR-0004 风格验收），验收对照 docs/adr/0004-company-team-tenancy.md 与 CONTEXT.md。
每票：核验/实施 → 运行相关测试（bun test ./<file> 与 E2E_UNIT_SCOPE 两层制，从仓库根解析路径）→ 报告（含命令、退出码、改动清单+sha256）→ 不提交不推送。
