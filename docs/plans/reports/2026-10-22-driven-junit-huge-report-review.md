# 独立只读审查：Driven Driver JUnit 巨型报告解析修复

日期：2026-10-22。审查者：bounded 只读 reviewer（本会话）。被审对象：`tests/bun-suites.test.ts` 单文件 delta。

## 判定

| 轴 | 判定 |
|---|---|
| **Spec 合同符合性** | **PASS** |
| **代码质量** | **PASS（附 3 条 findings，1 medium / 2 low，均不阻塞）** |

结论一句话：改动严格限定在声明的解析路径，语义与旧路径在所有已验证布局下等价，可安全执行；
`readHugeJunit` 存在两处真实但低概率的布局敏感缺陷（详见 findings），建议后续小补丁处理，不构成本次
bounded 修复的阻塞项。

## 范围与方法

- **事实源**：修复计划 `docs/plans/2026-10-22-driven-junit-huge-report.md`；PRE/POST 快照
  `docs/verification/workspace-redesign/current-session/driver-repair/{PRE,POST}/bun-suites.test.ts`；`docs/adr/0008-test-runner-tester-army-e2e.md`。
- **身份核验**：`shasum -a 256` 三份文件全部吻合（当前 = POST `a5876201…`，PRE `05ac8e01…`，与
  manifest.txt 一致）。
- **diff**：`diff -u PRE 当前`，逐 hunk 核对。
- **独立差分验证**（未复用修复者的 `~/.jcode/scratch/hugecheck/parity.ts` 结论；harness 位于
  `~/.jcode/scratch/junit-review/`，全部在仓库之外，不写仓库）：
  - 从**被审文件本身**按锚点提取 `readJunit`/`readHugeJunit`/`findClosingTagFrom` 生成被测库，避免手抄引入偏差；
  - 真实 `bun test --reporter=junit` 报告（bun 1.4.2，pass/fail/skip 各一，945 B）；
  - 合成 bun 形状报告（含 `<skipped><![CDATA[…]]></skipped>`、空 body failure、多行 dump、`<decor/>` 干扰、中文+emoji 名与正文）；
  - 真实常量（4 MiB chunk / 8192 carry）下：5 MB + 3 MB 双巨型 dump 报告全量 diff；
  - **布局扫描**（决定性测试）：`decisive.mjs` 在真实常量下用 0..6 字节前缀扫 7 种窗口相位，全部 parity；
    `root-probe.mjs` 让 `<testsuites>` 根标签横跨 4 MiB 边界（rootStart 4MiB-80 .. 4MiB+40，步进 8）扫描，无计数发散；
  - **缩小窗口变体**（chunkSize=64）：640 组 padding 扫描，用于穷举跨 chunk 边界行为（其 parity 断言按
    carryLimit=32 设计，与 readJunit 摘要语义本就不同，发散记录在 findings-2 的机制分析里，不作为缺陷证据）；
  - **截断报告**：dump 中途截断、文件中途截断，均不挂起、不抛错、按已读内容出摘要；
  - **平台探针**（Node v26.7.0）：稀疏文件在 2^31、2^31+5、2^32、2^32+7 偏移处 `readSync` 直接读与
    `findClosingTagFrom` 移植体均返回正确结果（>4 GB 无 32 位回绕）；`bun build` 整文件可转译（0.70 MB，未执行）。
- **合同轴对照**：计划 §"允许的改动" 1-4 逐条核对 diff。

## 逐项审查

### 1. Diff 范围（Spec 合同）

`diff -u PRE tests/bun-suites.test.ts` 仅 4 个区域，与声明完全一致：

1. imports：`node:fs` 增加 `closeSync/openSync/readSync/statSync`（仅为新解析路径服务）；
2. `HUGE_REPORT_BYTES` 常量 + `readHugeJunit`（L173-302，新增）；
3. `findClosingTagFrom`（L304-330，新增）;
4. `runBun` 读取分支（L387-392）：`statSync(report).size > 64MB ? readHugeJunit : readJunit(readFileSync…)`。

逐条核对计划承诺：① 阈值 64 MB、超限走流式 ✅；② 计数取 `<testsuites>` 根属性、failed 摘要 300 字符截断、
failingFiles 取 failure testcase 的 file 属性、4 MB 块扫描 ✅；③ 分组/env/超时/alone-re-run/blocked 判定
（L426-523 与 PRE 逐字节相同，`only`/`groups`/`bunEnv`/`databaseUnreachable` 全部未动）✅；④ 小报告路径
表达式原样保留（`readJunit(readFileSync(report, "utf8"))`，仅被三元表达式包裹）✅。无生产代码触碰。**合同轴 PASS。**

### 2. readHugeJunit / findClosingTagFrom 逐行审查

**返回结构（L184, L294-301）**：`ReturnType<typeof readJunit>` 复用同一类型，六个字段同序同义。✅

**窗口/carry 逻辑**：
- `<testsuites>` 根属性：单窗正则（L240-247）。真实报告头部远小于 4 MiB，一次读全；实测根标签整窗或跨 4 MiB
  边界都能正确计数（root-probe 扫描无发散）。理论缺口：根标签整体滑出 carry（>8 KB 头注释）时计数为 0，见 findings-3。
- 不完整开标签（L259-262）：`tagEnd === -1` 时 `carry = window.slice(open)` 保留从 `<testcase` 起的完整尾巴，
  与下一 chunk 拼接。正确；无丢弃。开标签 >4 MiB（>100M 属性字符）在实际 bun 报告中不可能。
- 闭标签跨 chunk：carry 尾部 8192 字符覆盖 `</testcase>`（11 字节），next-window `indexOf` 能命中。
- **巨型正文 seek（L280-287）**：`close === -1` 时先取 head excerpt（`bodyEnd = min(window.length, tagEnd+8192)`），
  再 `findClosingTagFrom(fd, position, "</testcase>")` 从当前 chunk 末尾起找闭标签字节偏移，`position = skip`、
  `carry = ""`、`continue outer`。语义：跳过整个 dump、下一个 testcase 从新窗口重新扫。正确且内存有界。
- **seek 与常规路径的行为不对称**（窗口内 vs 窗口外找到闭标签）：见 findings-1。
- 主循环 `position`（字节）与 `window.indexOf`（字符）混合：安全。所有 seek/position 更新都用
  `Buffer.byteLength` 结算（L322-324），needle 均为 ASCII（`</testcase>` 11 字节 = 11 字符），
  `position += readBytes`（字节）与 chunk 解码长度解耦但从不混用；carry 是字符串但从不参与字节运算。✅

**findClosingTagFrom 的 overlap 回退（L314）**：`position = max(0, from - (needle.length-1))`。
调用点唯一（L282），`from = position`（当前 chunk 末尾，即已消费到但未解析的字节）。回退 10 字节重读是刻意的：
`</testcase>` 可能恰好跨在上一 chunk 末尾。**是否会匹配"已处理过的闭标签"导致重复计数/跳错位置？**
不会，机制上三层保证：
1. `readHugeJunit` 只在 `close === -1`（当前窗口不含任何 `</testcase>`）时才 seek，而 `from` 指向窗口末尾，
   回退 10 字节最多回到"窗口已消费但正文未消费"的字节，不回退到已处理的 testcase；
2. `handleTestcase` 已在 seek 之前对当前 testcase 完成登记（L276-279），seek 结果只用于推进 `position`，
   `findClosingTagFrom` 自身不产生任何计数，重复匹配同一闭标签无副作用面；
3. `consumed` 结算（L322-324）用 `Buffer.byteLength(chunk.slice(0, index+len)) - Buffer.byteLength(overlap)`
   把字符串索引换算回"本 chunk 新消费的字节数"，返回 `position + consumed` = 闭标签结束后的第一个字节。
   实测（含 2^31/2^32 偏移）返回值精确等于 `闭标签起始偏移 + 11`。
   `position += readBytes`（L327，按本轮实际读取的字节推进）与 overlap 字符串衔接自洽：overlap 部分不会被重复
   匹配计数（每个 chunk 的 `indexOf` 从 chunk 头开始但 overlap ≤ needle-1 字节，且找到即返回）。
   唯一理论缺口（needle 内部又含 needle 前缀）对本 needle 不成立。✅

**readSync 返回值（L235, L316）**：`as number` 断言正确。Node `fs.readSync` 返回 bytesRead:number；Bun 的
`node:fs` 兼容层同样返回 number（修复者 probe-nan/probe2 亦验证；本会话 bun harness 全程跑通）。不存在
`{bytesRead}` 包装解构陷阱。`readBytes === 0` 判 EOF 正确（带 position 的 readSync 到 EOF 返回 0）。✅

**readSync position > 2 GB（类型角度）**：JS number 到 2^53 精确，Node/Bun 运行时把 position 传给 pread，
macOS/Linux 用 64 位 off_t，无 signed 32 位截断路径。Node 的 `.d.ts` 声明 position 为 `number | null`，
非"signed int32 专用"；实测（Node v26.7.0）：2^31、2^31+5、2^32、2^32+7 偏移的稀疏读取与移植体 seek 全部
精确返回，与修复者"6 GB 文件已实测通过"一致。driver 上限由 e2e `timeout: 900_000` 与 bun 子进程
`--timeout=120000` + 840 s kill 兜底，出现 >8 EiB position 在物理上不可能。✅

**根属性计数与逐条 failed 计数不一致时 driver 用哪个**：
- `tests`：`expect(started.tests).toBeGreaterThan(0)`（L436-439）——用根属性；
- `failures+errors === 0` 早退（L440）——用根属性；
- failingFiles 超 8 个 fail-fast（L482-486）——用逐条 file 属性；
- alone-re-run 判 `realRed`（L502-504）——用根属性；
- `started.failed`（逐条摘要）只进拒绝信息与 blocked 证据启发（L450-465）。
两套来源各司其职；不一致时**判定走根属性，逐条文本只影响可读性与 ECONNREFUSED 启发式**。根属性是 bun reporter
写的权威总数；截断报告下根属性为 0 → `tests > 0` 失败，不会假绿。✅

**截断报告行为**：dump 中途截断（`skip === -1` → `break outer`）与文件中途截断均不挂起、不抛错、按已读内容
输出。语义合理（截断本身意味着 bun 被杀，exitCode/timeout 路径另行兜底）。✅

### 3. readJunit 与 readHugeJunit 小报告等价性

对 945 B 真实 bun 报告与全部合成小报告，两路径输出**逐字段一致**（JSON 序列化后全等）。逻辑上支持该结论的依据：

- 计数：根属性来源相同（readJunit 的 `\bname="(\d+)"` 首次匹配 vs readHugeJunit 限定在 root 标签内匹配，
  对 bun 实际输出（根标签先出现、属性唯一）等价）；
- 逐条：同一 tag 切片 + 同一 `<failure|error` 谓词 + 同一 tag-strip/300 截断/fallback 正则（逐字符相同的代码块）；
- **不完整开标签 carry**：`carry = window.slice(open)` 保留完整尾巴，拼接后 tag 完整，与 readJunit 一致；
  已由布局扫描（7 相位、root 跨界扫描、640 组 64B 边界扫描中"开标签完整"的子集）覆盖；
- **skipped 标签**：`<skipped>…</skipped>` body 不含 `<failure|error`，两条路径都跳过；实测 skipped 用例
  不进 failed、不进 failingFiles，`skipped` 计数来自根属性，一致；
- 首个 `</testcase>` 停止语义：两路径都在第一个闭标签处终止 body（dump 内嵌字面 `</testcase>` 时同读
  "prefix"，行为相同——同源的字符串级解析）。

修复者"真实+合成 same:true"的结论被独立复现并加强（7 种窗口相位 + 根标签跨界扫描在真实常量下全 parity）。

## Findings

### F-1 [medium] head excerpt 截断点落在 `<failure …>` 开标签内部时，摘要退化为原始属性文本

- **位置**：`tests/bun-suites.test.ts` L268-279（`close === -1` 时 `bodyEnd = window.length` 或
  `tagEnd + carryLimit`）+ L202-206（`<[^>]+>` 剥离）。
- **机制**（本会话手工追踪 + chunk64 变体复现确认）：当窗口截点落在 `<failure message="…" type="…">` 开标签
  内部时，excerpt 以未闭合标签残片开头，`/<[^>]+>/` 剥离失配，`.trim()` 后的 detail 变成
  `<failure message="expect(receiv` 这类原始属性文本。两种触发形态：
  (a) 窗口剩余 < 8192 且截点在 failure 开标签内（`bodyEnd = window.length`）；(b) 超大窗口
  `tagEnd + 8192` 恰落在 failure 开标签内（需要 failure 开标签本身跨过 8192 边界，即 message 属性 >8 KB）。
- **实际暴露面**：形态 (a) 需要某 testcase 的正文起点在 4 MiB 窗口边界前 <8 KB 且截点恰好落在 failure 开标签
  内——每窗口每 testcase 约 8 KB/(4 MiB) ≈ 0.2% 的字节相位敏感事件，且只影响**一条摘要文本的可读性**；
  计数（根属性）、failingFiles、alone-re-run 判定均不受影响。形态 (b) 需 message 属性 >8 KB，bun 不产。
- **建议**（非阻塞，后续小补丁）：excerpt 起点跳过首个完整的 failure/error 开标签（例如先
  `/<(?:failure|error)\b[^>]*>/` 定位再取其后正文），或在 strip 前补全残片右尖括号。
- **为何不阻塞**：本修复的验收标准是"巨型报告下 driver 不崩、ADR0008 兜底可达、判定字段正确"，F-1 只影响
  拒绝信息里一条文本的形态，三个判定字段（tests/failures/failingFiles）在全部验证布局下正确。

### F-2 [low] 注释块提及 `pendingStart` 但代码无此变量

- **位置**：L218-223 块注释 "`pendingStart` is the offset in `window`…"。实现里没有 `pendingStart`（开标签由
  `cursor`/`carry` 隐式跟踪）。注释是从早期实现遗留下来的，误导读者。建议改写为描述 carry/cursor 实际语义。

### F-3 [low] >8 KB 头部注释可使根属性计数滑出 carry 而归零

- **位置**：L239-247（`rootSeen` 只在 carry+chunk 拼出的 window 里找根标签）+ L252-255（无 testcase 时 carry
  只保留尾部 8192 字符）。若报告在 `<testsuites>` 之前有 >8 KB 的注释/PAD，根标签整体滑出 carry，计数为 0。
  bun junit reporter 实际输出以 `<?xml …?><testsuites …>` 开头（几十字节），不存在此形态；属理论边界。
  后果受限：`tests === 0` → `expect(tests).toBeGreaterThan(0)` 失败，fail-closed，不会假绿。

## 其他观察（不计入 findings）

- `readHugeJunit` 在 fd 打开失败时会抛（openSync 异常向上传播），与 runBun 其余错误处理风格一致
  （mis-spawn/report 缺失均抛带上下文的 Error）；这里缺 report 上下文，但 openSync 失败紧跟 existsSync 检查之后，窗口极小。
- 两份解析器的 300 字符截断语义：readJunit 截的是 strip 之后的字符，readHugeJunit 同序同实现，一致；
  唯一差异来源即 F-1。
- `HUGE_REPORT_BYTES = 64 MiB` 阈值：6 GB 实测报告 ≫ 阈值，正常报告 ≪ 阈值，带宽合理；小报告路径零行为差异已由
  945 B 真实报告 parity 证实。

## 实际执行的验证命令（均在 scratch/只读下）

```
shasum -a 256 tests/bun-suites.test.ts …/PRE/bun-suites.test.ts …/POST/bun-suites.test.ts
diff -u …/PRE/bun-suites.test.ts tests/bun-suites.test.ts
sed -n '1,120p' docs/adr/0008-test-runner-tester-army-e2e.md
bun ~/.jcode/scratch/junit-review/harness.mjs          # bun 1.4.2：真实报告 parity、5MB+3MB 双 dump、6.5GiB 稀疏、截断、640 组边界
node ~/.jcode/scratch/junit-review/node-probe.mjs      # Node v26.7.0：2^31/2^32 偏移 readSync + seek 移植体
bun ~/.jcode/scratch/junit-review/rootcause.mjs        # 真实常量最小复现（F-1 机制确认）
bun ~/.jcode/scratch/junit-review/root-probe.mjs       # 根标签跨 4MiB 边界扫描，无发散
bun ~/.jcode/scratch/junit-review/decisive.mjs         # 真实常量 7 相位布局 parity：全过
bun build tests/bun-suites.test.ts --target=bun --outfile=/dev/null   # 转译检查（未执行测试）
```

审查者声明：本会话未运行任何 git 命令、未修改仓库任何文件（本报告除外）；全部实验在
`~/.jcode/scratch/junit-review/`（仓库外）进行。期间按协调者要求两次如实申报了全部执行过的命令。

## 复审（R2 增量：F-1/F-2 处理，2026-10-22 11:05）

**对象**：`tests/bun-suites.test.ts`，SHA-256 `ce54c804a519dd3a003e143d0c25627b40d61b9ccbf489a3bb571a3df86bdeb4`，
与 `driver-repair/POST-R2/bun-suites.test.ts` 逐字节一致（shasum 核验）。R1→R2 diff 仅两处：
① `handleTestcase` 内新增残片处理（L202-214）；② L231-237 注释改写（F-2，描述 carry/cursor 实际语义，准确）。
其余全部未动。F-3 维持不改（同意：bun 不产 >8 KB 头注释且 fail-closed）。

**R2 逻辑审查**：

- 残片判定分支（L209-211）：仅当 body 里**不存在任何完整的** `<(?:failure|error)…>`（`failureTag === null`）
  且 body 匹配 `/\s*<(?:failure|error)\b[^>]*$/`（允许前导空白、无 `>`、到串尾）时置 `text = ""`。空摘要随后落入
  L220 fallback；由于 body 无完整标签，fallback 的 `failureTag` 为空串 → `detail` 为空 → 输出 `name: `，
  不再泄漏原始属性文本。与修复者描述一致。
- 完整标签在头部（L212-213）：`body.slice(0, indexOf(failureTag)).trim() === ""` 保证仅当标签前只有空白时，
  才从标签之后取正文——这与 readJunit 的 strip 语义等价（readJunit 靠 `<[^>]+>` 剥掉头部标签，此处显式跳过）。
- 误伤面分析（重点 1）：(a) body 以完整标签开头 → 走 L212 分支，不进残片置空分支；实测 parity。
  (b) 标签前有其他内容（`<skipped>` 等）→ `slice(0, idx).trim() !== ""` → text 保持全 body，
  与 readJunit 同样靠 strip 处理，行为不变。(c) 正文里合法出现 `<failure` 字样：只要存在任一完整
  failure/error 标签，`failureTag !== null`，残片置空分支不可达；若 dump 中的 `<failure` 片段无 `>`，
  strip 会把它连同到下一个 `>` 的内容一起剥掉——与 readJunit 的 strip 行为完全同源（同一正则），无新差异。
  (d) `<failureless` 这类词：`\b` 边界不匹配，不误伤。
- 空摘要与 fallback 一致性（重点 2）：空 body（超时型）用例在 huge 路径下走 L212（完整标签、其后无正文）
  → text 空 → fallback 从完整标签取 type/message → 与 readJunit 输出**逐字符一致**（实测 parity）。
  残片型空摘要是窗口截断的固有信息丢失（readJunit 读全文能出正文），非语义回归；此时仅输出 `name: `，
  判定字段不受影响——与 F-1 的验收口径一致。

**复审验证**（`~/.jcode/scratch/junit-review/re-review.mjs`，同样从被审文件本体提取解析器；11/11 全过）：

- A. 真实常量 7 相位布局 parity（含 skipped/CDATA/多行 dump/timeout fallback）；
- B. 真实 `bun test --reporter=junit` 报告 parity（bun 1.4.2）；
- C. chunk64 切割电池：6 插入点 × pad 0..64 共 390 种布局，**零**原始属性文本泄漏
  （`message="`/`type="`/`expect(recei` 均未出现），且所有与 readJunit 的分歧均为空摘要形态（`name: `），
  符合残片契约；计数与 failingFiles 在全部布局下与 readJunit 一致；
- D. 误伤场景全 parity：完整标签在头部、空白前缀标签、标签不在头部（skipped 在前）、正文含字面
  `&lt;failure&gt;`/`<b>` 标签、正文含无 `>` 的 `<failure` 片段、空 body（fallback 路径）；
- E. 真实常量 5 MB + 3 MB 双巨型 dump parity。

修复者提供的证据（真实小报告 parity true、合成残片 t2 空摘要、跨 chunk 大报告不变、
`driven-app-tests-r3` 6/6 通过）与上述独立验证相互印证。

**复审判定：F-1 已修复（残片不再泄漏，误伤面为零，fallback 语义与 readJunit 一致）；F-2 已修复。**
R2 增量不引入新发散；维持双轴 **PASS**。剩余已知限制仅 F-3（low，理论边界，fail-closed，双方同意不处理）。

复审期间同样未执行任何 git 命令、未写仓库文件（本报告追加除外）。
