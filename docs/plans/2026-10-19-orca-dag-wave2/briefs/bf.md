# [bf 流] 批次票（按序）：#251、#287（Bifrost 域）

每张先核验 main 已含等价实现；Bifrost 线已多轮交付，零改动 SATISFIED 预期主流；票面无 Verification 段的按语义找等价测试。
- #251 Bifrost 05.10 用户侧 Key 状态展示与全版本撤销
- #287 Bifrost 09.2 公司 payer 贯穿全链路

DB：TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5561/bf2（容器 orca-w2-bf-pg，pgvector）。
每票：核验/实施 → 运行相关测试（从仓库根解析路径；go 测试用缓存 toolchain 二进制，见 bifrost go.mod 1.27 坑）→ 报告（含命令、退出码、改动清单+sha256）→ 不提交不推送。
