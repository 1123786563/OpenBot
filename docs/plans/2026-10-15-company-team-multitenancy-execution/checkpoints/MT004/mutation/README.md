# MT004 变异检查（mutation checks）——诚实披露

目的：验收 (1)（唯一约束）与 (3)（status/epoch CHECK）的用例在 GREEN 首轮即为绿，
按 brief「首跑即绿的项按诚实披露处理（变异检查或说明）」执行真实变异检查。

## 变异 → 检测（全部存档于本目录）

| 变异（已提交到专用库） | 过滤运行的期望 | 实测 | 存档 |
| --- | --- | --- | --- |
| MUT1：DROP PK + DROP UNIQUE INDEX | duplicate 用例必须失败 | **exit 1，0 pass / 1 fail**（"expected the statement to be rejected, but it succeeded"） | MUT1-drop-pk-unique-DUPLICATE-TEST-FAILS.txt |
| MUT2a：DROP enterprise_workspace_member_status | status 用例必须失败 | **exit 1** | MUT2-drop-status-check-STATUS-TEST-FAILS.txt |
| MUT2b：DROP enterprise_workspace_member_epoch | epoch 用例必须失败 | **exit 1** | MUT2b-drop-epoch-check-EPOCH-TEST-FAILS.txt |
| MUT3：DROP 两条复合外键 | criterion 2 两条用例必须失败 | **exit 1，两条 23503 用例全失败** | MUT3-drop-composite-fks-CRITERION2-FAILS.txt |

criterion 2（复合关联）与 criterion 4（迁移 dry-run/apply/expand-only）用例在 GREEN
第一轮曾真实失败并被抓住（见 ../red-green/GREEN-1-first-run.txt），本身就是网有效性证据。

## 还原与终态

- 约束/索引/FK 全部按迁移原文重建；psql \d 终态核验：PK、唯一索引、两个 CHECK、
  两条复合 FK、5 条 RLS 策略俱在。
- **还原的权威证据 = 全量未过滤套件**：RESTORE-full-suite-green.txt
  **15 pass / 0 fail，exit 0**。
- 披露（非缺陷）：还原阶段的**过滤**复跑（`bun test -t <name>`）出现失败，原因是
  `-t` 跳过了产生前置行的用例（如 criterion 1 首个用例创建 (T_A,A1,P_A)、criterion 2
  第三用例创建 (T_A,A2,P_A)），被过滤运行的用例依赖这些前置行。这是测试用例间的
  顺序耦合，在全量运行下不存在（全量套件自 MT004 GREEN 起始终 15/0）。过滤运行
  仅用于变异检测（其失败判断只针对目标用例本身），未作为任何「通过」依据。
