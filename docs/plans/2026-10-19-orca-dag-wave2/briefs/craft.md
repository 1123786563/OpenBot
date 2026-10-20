# [craft 流] 批次票（按序）：#437、#433、#408（Craft 域）

每张先核验 main（BASE c80927fa）已含等价实现；零改动 SATISFIED 是合法收尾。票面：
- #437 缺陷 B：新会话 start 脚本未注入 /<label> mount（~craft/preview-origin.ts、app/api/probe/route.ts 一带；spec 见 docs/specs/2026-10-15-craft-preview-origin-design.md）
- #433 [P0] sandbox 上游 /file/content absent→404 契约丢失（agent-sandbox/src/version.ts、sandbox-gateway.ts 一带）
- #408 [P0] 生产空模板/缺 preview 域名显式关闭 AC6（server/src/craft/config.ts、preview-origin.ts、server/src/index.ts）

注意 #436 修复（38 张迁移表恢复）已并 main，fresh DB schema 相关断言以当前 main 为准。
DB：TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5564/craft2（容器 orca-w2-craft-pg，pgvector）。
每票：核验/实施 → 运行相关测试（从仓库根解析路径）→ 报告（含命令、退出码、改动清单+sha256）→ 不提交不推送。
