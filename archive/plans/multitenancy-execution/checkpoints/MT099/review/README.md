# MT099 独立复审证据（review 增量，2026-10-18）

复审者工作树零改动收尾（entry/exit 哈希逐位一致）；零 git 提交。

- bun-runA-r15e.txt — Run A：复审 brief 配方（openbot_enterprise_r15e_* @ 127.0.0.1:55590，
  容器 mt099-review-pg，自建迁移链 19 任务/36 步）。1123 pass / 1 fail，唯一 fail =
  entry-context 环境令牌钉死（w15c_test）——证明已披露整改是承重墙。
- bun-runB-w15c.txt — Run B：实现者口径库名（openbot_enterprise_w15c_* @ 同容器同端口）。
  1124 pass / 0 fail / 43 文件 / 12799 expect() —— 票面基线数字独立复现。
- cargo-full.txt — 全量 cargo：lib 592 passed + bin 149 passed = 741 passed / 0 failed。
  （票面过滤 21/0/579 filtered 见会话记录，与实现者 01-ticket-verification.txt 逐字一致。）
- pre-mutation-hashes.txt — 变异前源文件哈希（= 实现者 after-hashes 值）。
- exact-diff-*.patch — 三修改文件 vs MT098 基线的精确 diff。基线内容取自本仓库 git 检查点
  提交 d5c169e3（其四文件哈希 = MT098 报告值 b75f3e6f/f515e24a/25042fca/8ec7e2cd，
  逐位核验一致）——diff 范围核对（无夹带）以此为准，非重建猜测。
- typecheck.txt / biome.txt — bunx tsc --noEmit exit 0；biome 检查触及文件 exit 0。

变异抽验（3/3 KILLED，全部字节复原 + 聚焦复绿 21/0）：
- MUT-5 store_session 不落指针 → credential_namespace_a_stored_session_makes_its_authority_
  the_installations_current FAILED（20/1）。
- MUT-4 recall_session legacy 恢复不核对 authority → credential_namespace_a_legacy_session_
  of_another_authority_is_never_adopted FAILED（与实现者所指 killer 完全一致）。
- MUT-2 namespace_hash 常量化 → ns2/ns4 等 6 例 FAILED。
