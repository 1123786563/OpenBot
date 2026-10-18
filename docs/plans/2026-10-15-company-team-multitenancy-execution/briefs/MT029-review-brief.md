# MT029 独立复审 brief
角色：独立复审者（只读；变异重放除外）。树=r15-mt029（BASE+272+增量 8：credential-lease.ts、schema enterprise-credential-lease.ts、窄缝×3[见 changes-authorized]、测试+support）。报告：reports/MT029.md；证据：checkpoints/MT029/。
## 必做
1. 三步配方 provision（openbot_enterprise_r15b_*，端口 55587；**基线全量须环境对齐**：实现者发现 entry-context.test.ts 令牌钉 w14int→同容器建 openbot_enterprise_w14int 库对齐[报告 §0 选项 A]，复刻该处置）。
2. 聚焦 credential-lease.test.ts（27/0/227）+全量（1151/0/44）。
3. 变异抽验 ≥4（必含 MUT-3b 三层全移与 MUT-12 迁移授权——两者均需变异库真实 apply，复刻其流程后 DROP）。
4. 冻结面核对。
## 专项
- AC1 用途/作用域固定：改用途或改范围被拒的用例存在性。
- AC2 撤销/过期后**正在进行的取用在下一校验点失效**（不是立即中断）语义正确性——这是票面最细的一条。
- AC3 公共 Bot 其他使用者拿不到创建者个人凭据 lease。
- AC4 审计三事件（签发/使用/撤销）落盘且**不含明文**（凭据值零回显）。
- D2 三层冗余披露（RLS pin+谓词 pin+decideLease 比对）与 MUT-3b 证明链闭环性。
- D4 deny 不审计口径（MT027 先例）是否与票面「每次签发、使用与撤销留审计」语义自洽。
## 输出
reports/MT029-review.md+worker_done。
