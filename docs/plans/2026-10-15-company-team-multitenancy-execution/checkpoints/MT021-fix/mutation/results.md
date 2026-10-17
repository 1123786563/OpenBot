# MT021 fix-round 变异复验（门槛：MUT3 修复后仍被捕获）

- MUT3（游标钉 limit+1 行/跳行）：`at: rows[limit-1]…` → `rows[limit]…` 注入。
- 结果：聚焦套件 **6 fail / 23 pass**（实现轮 4 fail → 修复轮 6 fail，新增的
  两条 F1 微秒用例同样被捕获——游标机制改动后防线不弱化、反而增强）。
- 捕获面：验收 1 页并集、验收 4 三例（交错全链/中途改名/中途删除）、修复轮
  F1 两例（微秒全链 + at 微秒精度）。
- pristine 快照取在 biome 收尾之后（修复轮 F3 纪律）：pristine-sha256.txt ==
  还原后实测 == 交付终态 `a7d5820b…`；还原后聚焦复绿 29/0/0
  （RESTORE-verify.txt / RESTORE-green.txt）。
- 实现轮 checkpoints/MT021/mutation/pristine-sha256.txt 的 `5b6ed95f…`（早于
  biome 重排版的 pre-biome 变体）自本修复轮起被本目录记录取代。
