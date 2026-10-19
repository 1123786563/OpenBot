# Dry-run 报告：全家族编排（R0–R4）

运行目录：`docs/plans/2026-10-19-orca-run-all/`
生成：2026-10-19 · 主协调器手工执行（Orca DAG 工具未实施，按 `2026-10-18-orca-dag-orchestration.md` R0–R7 流程只读演练）
BASE：main @ `2b41017c` · scope_revision 1 · 指纹 `5987aaf2c419166e`
前序：承接 run_7176face537b（A 类 106/106 已收尾）；本轮 = 范围扩展（+Craft +Hindsight）+ 全域 rescan。

## 1. 范围（R1）

根 Issue：**#5 Bifrost 严格积分计费** + **#6 多租户整改**（沿用前轮）＋ **#358 Craft 预览独立 Origin** + **#376 Hindsight 个人记忆**（本轮新增）。

| 项 | 值 |
| --- | --- |
| 节点总数 | 378（4 根 + 21 聚合 + 353 叶：open 229 + closed 124） |
| MT 树 | #6 → 20 聚合（#187–#206）→ MT001–MT143（143 叶） |
| Bifrost 树 | #5 → 100 张原生 sub（#207–#306）+ 51 张 body-link（#307–#357，Parent 段含 issues/5 逐张核验）= 151 叶 |
| BP 树 | #368 → BP01–BP07（#369–#375），跨 MT/Bifrost 依赖 |
| Craft 树 | #358 → 32 叶（P0/P1/P2 缺陷票 + R06/R08 + 缺陷 A/B；10 张已关） |
| Hindsight 树 | #376 → 19 原生 + 1 body-link（#398 尾款，Parent 声明核验）= 20 叶 |

**树外 open（不自动纳入，待裁决）**：#4 + #7–#43 共 37 张 Opik T 系列旧票（无父树；本轮只读登记为 external pool）。
**完整性建议（非阻塞）**：52 张 body-link 票（#307–#357、#398）建议补挂原生 sub-issue 使树自洽。

## 2. closed 核验（R2）

closed 124 张分三类（明细 `scope.json#closed_classification`）：

| 分类 | 数量 | 证据 |
| --- | --- | --- |
| **satisfied** | 121 | A 类 106（run_7176face537b verify-wave 回执+main 提交）+ 前轮 5（#44/#72/#141/#142/#269）+ Craft 10（#403/#420–#430；craft-preview-* 测试套件在 main，PR #435/#441 线，本轮逐票声明文件核验） |
| **unverified_closed** | 3 | #106/#133/#162 —— 沿前轮结论查无实施证据，**待用户裁决**（补实施 / wontfix） |
| **delivered_but_open** | 3 | #48/#214（上轮 pilot 零改动收尾）、#371（BP03 已并 main `3ca32d49`）—— 已交付但票面 open，start 后应走"复验+R7 贴标"而非重新派发实施 |

## 3. DAG 结构（R3）

- 依赖仅取结构化声明（`## Blocked by` / `## Blocks` / Craft `## Dependencies` + 聚合表格）：**0 环、0 未解析引用、0 声明不一致、0 树外引用**。
- open 叶 229 张拓扑分 **20 波**：W1=67（mt 24 / bf 17 / bp 1 / craft 22 / hs 3）→ W2=23 → … → W17–W20 为 Bifrost 编号线长尾（1–2 张/波）。完整波表 `analysis.json#waves`、逐票节点 `dag.json`。
- 前轮 bc-wave-plan（mt/bf/bp 子集 W1=42）被本表取代；其"有效 W1=40"（剔 #107/#163）与本轮保守就绪一致。

## 4. 就绪集合与并行约束（R4 dry-run）

保守就绪 **65 张**（乐观 67 − #107/#163，二者依赖 unverified_closed #106/#162）：

| 域 | 张数 | 票号 |
| --- | --- | --- |
| craft | 22 | 404–419、425、427、431、433、436、437（P0×7：404/408/409/410/411/412 + 433） |
| mt | 22 | 48、54、62、63、66–69、75、76、78、82、83、85、111、115、117、121、143、146、155、167（B/C 类） |
| bf | 17 | 214、221、227、232、240、242、251、264、270、272、273、278、279、287、295、325、341（B 类为主） |
| hs | 3 | 377（HS01 候选审核，链头）、380（HS03 自托管）、398（尾款 medium×4） |
| bp | 1 | 371（已交付待收尾，见 §2） |

**文件冲突（就绪集内，按票面声明范围）**：

- `craft/preview-origin.ts` + `docs/craft-preview-origin.md` + `server/src/index.ts`：#404 ↔ #408
- `craft/webapp-proxy.ts`：#405 ↔ #408 ↔ #409（三方互斥）

→ craft 域 W1 同批最大 20/22（冲突组 {404,405,408,409} 内最多取 2，如 {404,405}）；其余域无声明级冲突。

**并行判定（域流模型）**：mt / bf / bp / craft / hs 五条域流，域内串行（共享 fixture、迁移表、回归资源），域间并行；每流独立 worktree + 独立 PostgreSQL 测试库（沿用 openbot_<domain> 命名）。名义并行宽 5，实际预算待授权（建议试点期 3，稳定后 4–5）。

**B/C 类纪律（沿 run_7176face537b 实证教训）**：mt/bf/bp 的 40 张就绪票票面声明路径不可靠，Brief 统一为"先核验 main 是否已含等价实现 → 已含且 AC 全实证则零改动复验收尾，有缺口才补实现"。craft/hs 为新实施票。

## 5. start 前置条件（未满足，等待授权）

1. 3 张 unverified_closed（#106/#133/#162）处置裁决。
2. Opik 树外 37 张是否纳入（默认不动）。
3. 52 张 body-link 是否补挂 sub-issue（非阻塞）。
4. **真实 start 授权**：范围（试点先行 vs 65 张全量）、并发预算（建议 3 起步）、Worker 后端核验（Orca Pi）。
5. 试点建议（每域 1 张跑通 implement→validate→review→integrate）：
   - craft #410（P0 写接口 Origin 拒绝；注意 main 已有 `82676669` 相关纵深提交，先核验）
   - hs #377（HS01 链头，无前置）
   - bf #221（B 类先核验样板）
   - mt #54（B 类先核验样板）；bp #371 直接走复验+R7 收尾。
6. 每张就绪票的 Brief 由主协调器按 `writing-plans` 生成后再派发；票号从 `dag.json` 机械导出，验证命令一律仓库根 cwd（retro 纪律）。

**本轮零副作用**：未派发 Worker、未写 GitHub、未改业务代码；全部产物在本目录（未跟踪）。
