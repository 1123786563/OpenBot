# MT011 独立复审报告 —— 集中式 not-found 不可见语义 + 列表/游标/批量面

- 角色：独立复审者（全新 Pi 会话，Orca task_8d6f90b51b33 / dispatch ctx_f19be14fe040；与实现者不同会话、不同工作树）
- 复审对象：工作树 `/Users/wuyongjun/orca/workspaces/OpenBot/i9-review-mt011`，HEAD `f0520524`（= prereq-manifest BASE，未变）；EXE 49 项前置 + 本票 5 交付
- 复审方式：**只读**被审文件；独立复算哈希、独立重建环境（专用容器 `mt011-review-pg` @ 127.0.0.1:**55497**）、独立复跑全部验证命令；复跑后容器已删除，工作树哈希复验未变
- 本文件为本复审唯一新建产物；无修复、无提交/推送/合并

---

## 1. 总裁决

**通过（PASS）**——四条验收在票面语义内全部成立；「集中」为真集中而非复制；三判定模块零改动经独立哈希复算证实；全部复跑数字与存档证据一致。以下 F1/F2 为低危发现，建议在下游接线票处理，不构成本票阻断。

## 2. 裁决 A —— 四条验收

### A① 无权 vs 不存在逐字节一致（含时延面）

**成立。** 行为面：三个冻结闭环（MT008 `decide` / MT009 `decideAction` / MT010 `decide`）的全部拒绝（缺失/无权/已删除/跨团队/跨公司/未发布/撤销后）由共享套件逐例断言 `{"outcome":"deny","code":"RESOURCE_NOT_FOUND"}` 单元素字节集合 + 集中 HTTP 面（404 + `{"error":"RESOURCE_NOT_FOUND"}`）。本票新面（批量）的 missing 与 forbidden 拒绝同样单元素集合，且逐 id 与单个 decide 一致。

**时延面如何测（brief 点名）**：实现采用**确定性语句计数代理**——`support/not-found-semantics.ts` 用 Proxy 包装真实 data 通道逐条计数 `tx.execute` 与 select 链起点（1:1 映射 SQL 语句），包装体本身经**真实 `verifyDataDatabase`** 验证（WeakSet 品牌冻结模块照常接受，非旁路角色）。测试断言 decide(缺失) 与 decide(无权) 语句数**相等且 >0**（>0 防 0=0 空洞），批量全缺 vs 全禁同理。复审认定：这是**结构性代理而非墙钟测量**（D7c 已诚实披露）——两条路径的 SQL 语句序列逐条相同、不存在按存在性分叉的语句路径，语句数相等是必然推论；残余风险（同语句不同参数的计划成本差）在该层可忽略，且 HTTP 尚未挂接，端到端墙钟本票不可测。**采信，方法学正确。**

### A② 列表/计数不含无权对象 + 游标不偏移

**成立。** 复核实现：候选行按 `(created_at, id)` 全序一次读取后逐行经注册表求值，仅 allow 进入流；计数只数可见。keyset 游标只钉在**最后一个可见项**的 (created_at::text, id) 上，第 limit+1 个可见项仅用于签发下一页；不可见项不消耗页位（7 可见 = 4 页精确断言）、键大于全部可见项的 i4 不制造末页游标、翻页中途软删后续页无移位无错误。`::text` 往返经 `$1::timestamptz` 解析回，偏移量在文本内、微秒无损、跨会话安全。PG 行比较 `(a,b) > (c,d)` 与排序键一致，同刻创建按 id 决胜。

### A③ 批量无部分成功差异推断

**成立。** 一次 in-list 受限读取 → byId 映射 → 逐 id 求值；缺失与一切拒绝输出同一 canonical 条目（`resourceId` 回显字段除外，verdict 字节单元素集合断言）；无聚合计数、无短路；重复 id 逐字段相同；面一致性（批量 deny ≡ 单个 decide）。锁序 = 基础键 → 去重字典序资源键，与 decide 同族同键序，**对不存在 id 照常取锁**（语句路径不按存在性分叉——这正是 A① 时延面在批量上的结构性保证）。

### A④ 语义集中 + 共享测试 + 三闭环复用（包装不重构）

**成立。** canonical 实例/严格守卫（恰两字段，多余字段拒绝）/确定性序列化/HTTP 面只在 `not-found-semantics.ts` §1 定义一处；三闭环代码零改动，共享不变量套件以**行为断言**（对三闭环真实服务输出跑 canonical 断言）证明 reuse-compatibility——是「包装/复用证明」而非重构。列表/批量逐行判定复用 MT008 注册表（见裁决 B）。

## 3. 裁决 B —— 集中语义与三模块关系

**真集中，非复制粘贴。** 逐行比对 `rowToFacts` 与 MT008 `decide()` 的事实组装：tenantId 兜底、workspaceId/id 兜底 ""、visibility 解析、status/revision/aclEpoch 兜底 null、`grant.read = grantPrincipalId != null`、membershipStatus 同形——逐字段一致；版本解析 `policyVersion ?? facts.resource.policyRevision` 与 decide 逐字面一致；默认注册表同一 `createShippedResourcePolicyRegistry()`。**放行语义只存在于 resource-policy.ts 一处**（tenancyV1/workspaceV1 判定函数无第二副本）。三个判定模块（`resource-policy.ts` / `team-public-rules.ts` / `personal-share-rules.ts`）及其测试：

- **独立哈希复算：47/49 项前置逐字节不变**，唯二变化恰为本票两处授权编辑（`index.ts`、`scenarios.ts`）——三模块哈希与 prereq-manifest 完全一致，只读消费属实；
- 代码复核：MT011 仅 import 其导出（注册表工厂、parseResourceVisibility、类型），无任何 monkey-patch、无行为包装；两模块 deny 形状本就是 canonical 形状（源码 `DENY_VERDICT` 同形）。

## 4. 裁决 C —— 场景夹具增量与装配段

**成立。** 独立反向重建两文件的 before 态：

- `scenarios.ts`：剔除 MT011 块后 sha256 = `9348db3d…`，与 manifest 钉死值**逐字节一致**；增量为 4 行（3 行注释 + 1 行域枚举，按字母序插入），diff 最小性属实（夹具域注册表既有先例）。
- `index.ts`：剔除 import 块 + 尾部 22 行装配段后 sha256 = `614a0ed4…`，与 manifest 钉死值**逐字节一致**——changes.diff 即全部增量，装配段纯追加（能力通道缺失时 null，fail-closed，无宽松替身），与 MT009 装配同款。

## 5. 裁决 D —— TDD 链、变异计数、D1 采信度、其余披露

- **TDD 链**：RED-1 存档（`Cannot find module`，与 MT008/MT010 同形态）→ GREEN 19/0/204。链条完整可信。
- **变异计数**：MUT1–MUT6 存档日志尾部计数（17/2、16/3、17/2、17/2、17/2、18/1）与报告表**逐项一致**；MUT6 首轮存活→补「多余字段形状拒绝」用例→捕获，补的用例在最终套件中在位（离线第三例含 reason 字段拒绝）。RESTORE-green 19/0 存档。
- **D1（基线未落盘）等效证据链：采信。** ①477=458+19 算术成立（聚焦 19 例为全量 477 名单真子集，名单逐条 diff 一致）；②47/49 前置哈希不变 ⇒ 既有套件代码逐字节冻结；③复审在**全新容器、全新库、七任务依赖序重建**下全量 477/0/0 绿灯 ⇒ 既有用例在新代码下仍全部通过。三条独立链汇合，"458 基线真实且未被弱化" 高度可信；作为一次性的流程瑕疵（未及时重定向）接受披露，不升级。
- **D2**（GREEN 期测试侧修正、生产零回改）：生产文件哈希与实现后一致，修正叙述与夹具代码事实相符（provision 身份映射、setup 通道软删、i1 显式发布），采信。
- **D3**（biome 存量欠账零新增）：**独立 A/B 复算证实**——把 before 态重建文件放回 `server/src/**` 路径语境（noConsole override 仅对该路径生效；复审首测在 /tmp 外语境得出 2+1 属方法学假象，已纠正），pre = 6 errors + 1 warning（noNonNullAssertion + organizeImports + 4×noConsole，行号 817/842/863/1815），post = 6+1（同规则同行号偏移），**MT011 追加 22 行零新增违规**，与存档 04b 一致。
- **D4/D5/D6/D7/D8**：与代码及哈希证据逐条相符（离线替身仅限安排侧、判定侧全程受限角色 + 真实 RLS；列表不持逐资源锁、候选集一次扫过等边界均已在模块头如实披露）。D8 实现容器落 55482 与本复审无关（本复审按 brief 用 55497）。

## 6. 独立复跑结果（全新容器 mt011-review-pg，127.0.0.1:55497，trust，复跑后已删除）

| # | 步骤 | 结果 | 判定 |
|---|---|---|---|
| 1 | 端口预检 55497 空闲；容器/双库创建 | PostgreSQL 16.15 (aarch64)；`openbot_enterprise_mt011rev` + `_assigned` | OK |
| 2 | base migrate + 七任务依赖序 apply（MT004→008→112→012→014→010→009，dry-run+manifest+apply） | `{"type":"migrations-applied","status":"ok"}`；7/7 applied | OK |
| 3 | 聚焦 `bun test tests/multitenancy/not-found-semantics.test.ts --timeout 30000` | **19 pass / 0 fail / 0 skip，204 expect()，exit 0** | 与 brief 预期一致 |
| 4 | 全量 `bun test tests/multitenancy/ --timeout 30000`（六变量 env） | **477 pass / 0 fail / 0 skip，17 文件**，9270 expect()，exit 0；477 测试名与存档 02 逐条一致（sorted diff 为空） | 与 brief 预期一致（=458+19） |
| 5 | `bun run typecheck` | exit 0（server/app/worker） | OK |
| 6 | biome 触及 5 文件 | 自有 4 文件 **clean（exit 0）**；`index.ts` 6 errors + 1 warning = A/B 证实的存量欠账，零新增 | OK |
| 7 | 清理 | `docker rm -f mt011-review-pg`；工作树哈希复验未变（index `bac27c45…`、scenarios `1ac205ba…`、nfs `80a832ec…`） | OK |

复跑注记：首轮全量曾报 9273 expect()（+3），复跑两次均 9270 且测试名单零差异——判定为既有计时敏感用例（MT005/006/007 锁序列化类）内部条件 expect 的非确定性计数抖动，非本票产物（本票聚焦套件 204 expect 三次运行全部稳定）。

## 7. 发现（不阻断）

- **F1（Low，声明准确性）**：`notFoundErrorBody()` 的代码注释与报告 §1.1 称错误体「与既有路由错误体形状逐字节一致（`{ error: code }`）」。复审全面检索：**没有任何既有路由发出扁平 `{"error":"RESOURCE_NOT_FOUND"}`**——企业会话路由（`server/src/enterprise/conversations/routes.ts`）的 404 体为嵌套 `{ error: { code, message } }`，workspace-scope-routes 同为嵌套形状。票面验收 ① 只要求「无权 ≡ 不存在」相互一致（已满足），故不构成验收失败；但下游接线票若据此假定与既有企业路由体形状兼容会被误导。建议在接线票修正注释/声明或显式决定映射。
- **F2（Low，输入校验边缘）**：`decodeCursor` 校验 JSON 形状但不校验 `at` 可解析为时间戳——形如 `{"v":1,"at":"garbage","id":"x"}` 的令牌通过解码后在 SQL 的 `::timestamptz` 处抛 Postgres 原生错误，而非模块自订的 `INVENTORY_CURSOR_INVALID`。失败仍然响亮且无存在性泄露，但与「无效令牌响亮拒绝（INVENTORY_CURSOR_INVALID）」的契约不一致，且该边缘无用例（现测例仅非 base64）。建议后续补解码端试验解析 + 用例。
- **F3（Info，测试气味）**：混合批量用例中 `entries[0].resource.displayName` 的三元断言 else 分支为 `x === x` 恒真（夹具方差防御），属空洞期望；实际运行恒走真分支，无遮蔽危害。
- **F4（Info）**：cursor 载荷不拒绝多余键（与 verdict 守卫的严格形状不一致）；令牌为服务端自发 opaque，无安全影响。
- **F5（Info，证据）**：MUT6「首轮存活」无独立存档日志（仅有补强后的 18/1）；D1 基线仅终端证据（已披露并以 §5 三链采信）。两者均为证据完备性小疵，非实现缺陷。

## 8. 验收逐条映射（复审独立确认）

| 票面验收 | 复审证据 | 裁决 |
|---|---|---|
| ① 无权 ≡ 不存在（状态码/错误体/时延不可区分） | 共享套件单元素字节集合（MT008 五类 + MT009 未发布/缺失 read/run + MT010 无分享/缺失/撤销后）+ 离线 canonical 面；语句数对等测试（>0 且相等）×2；结构性无分叉（批量对缺失 id 照常取锁） | 成立（时延面=结构性代理，D7c 披露采信） |
| ② 列表/计数不含无权 + 游标不偏移 | 计数=7 精确断言；limit=2 全链 4 页恰 7 可见项；i4 不产末页游标；中途软删无移位；workspace-v1 门 3→1→3；policy_revision 翻转 5→6→5 | 成立 |
| ③ 批量无部分成功差异 | 混合批量输入序 + 拒绝单元素集合；批量 ≡ 单 decide；全缺 vs 全禁语句数相等；空批/超限/非串响亮拒绝；重复 id 全等 | 成立 |
| ④ 集中实现 + 闭环复用共享测试 | canonical 只定义一处；三闭环零改动（47/49 哈希独立复算）+ 行为复用证明；列表/批量经同一注册表；装配段纯追加进程内可达 | 成立 |

## 9. 复审者声明

本复审未修改任何被审文件；唯一新建为本报告；复跑环境（容器/库/角色）为独立搭建并在结束后删除；全部结论基于上述可复现命令与哈希证据。**Evidence over claims：关键数字（19/0/204、477/0/9270/17 文件、47/49、614a0ed4/9348db3d 重建、6+1 A/B、6/6 变异捕获）均经独立复算，与实现者存档一致。**
