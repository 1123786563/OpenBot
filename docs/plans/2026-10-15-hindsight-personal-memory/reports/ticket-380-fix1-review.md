# Ticket #380 fix1 复审 — diff-of-diffs 核验(F1/F3 处置)

- **复审人**:独立只读 Review Agent(Orca 派发,task_4e7af9986454)
- **复审时间**:2026-10-16T03:07+08:00
- **复审对象**:工作区 `/Users/wuyongjun/orca/workspaces/OpenBot/hs03-selfhost-service`(HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`,与审阅基线 HEAD 一致;tracked diff 为空)
- **审阅基线**:`reports/ticket-380-review.md`(2026-10-15T17:0x–17:2xZ)+ `reports/ticket-380.md` 交付物哈希表(12 文件)+ fix1 附录(task_93e8db38f181,2026-10-16T02:07–02:12 CST)给出的改前/改后哈希对
- **预期变更集**:恰好 F1(`backup.sh` `-mtime +30`→`+29` 即 `RETENTION_DAYS-1` + 语义注释)+ F3(`hindsight.env.example` 网关 URL 默认 `host.docker.internal:9100/v1` + 容器/宿主注释,README 同步一句);其余 9 个交付文件与基线逐字节一致
- **纪律遵守**:只读;未修改工作区任何文件;未 commit/push;边界复现在 /tmp 临时目录完成,未触仓库

## 一、变化清单(哈希重算,本复审亲自执行)

12 个交付文件 sha256 逐一重算(2026-10-16T03:0x+08:00),与审阅基线哈希表及 fix1 附录对照:

| # | 文件 | 审阅基线 sha256 | 当前实测 sha256 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | deploy/hindsight/backup.sh | 7ea2fc56…72ba67 | **99564e0d…c123b1** | **变化**(= fix1 附录改后值,与任务给定前缀一致) |
| 2 | deploy/hindsight/hindsight.env.example | 02c9e996…7ebce68 | **d109e9f7…0597735** | **变化**(= fix1 附录改后值,与任务给定前缀一致) |
| 3 | deploy/hindsight/README.md | bbe84881…8be3c046 | **62ede825…3b42ef0bc** | **变化**(= fix1 附录改后值,与任务给定前缀一致) |
| 4 | deploy/hindsight/docker-compose.yml | 20e53cbf…4dc813 | 20e53cbf…4dc813 | 逐字节一致 |
| 5 | deploy/hindsight/hindsight.env(git-ignored 实值) | 4eab36c5…d803afb | 4eab36c5…d803afb | 逐字节一致 |
| 6 | deploy/hindsight/.gitignore | ad5f630d…5d2f5c572 | ad5f630d…5d2f5c572 | 逐字节一致 |
| 7 | deploy/hindsight/test/gateway-standin.mjs | 9fd4baed…37c413cd | 9fd4baed…37c413cd | 逐字节一致 |
| 8 | deploy/hindsight/test/verify-health.ts | dff17709…e7b069a2 | dff17709…e7b069a2 | 逐字节一致 |
| 9 | server/src/hindsight/config.ts | d10aa347…3bc3bfab | d10aa347…3bc3bfab | 逐字节一致 |
| 10 | server/src/hindsight/health.ts | 4ca854ce…2626ea07 | 4ca854ce…2626ea07 | 逐字节一致 |
| 11 | server/tests/hindsight-config.test.ts | 52700e33…f2356d37 | 52700e33…f2356d37 | 逐字节一致 |
| 12 | server/tests/hindsight-health.test.ts | a84921aa…535ad4ebb | a84921aa…535ad4ebb | 逐字节一致 |

**结论:变化面恰好 = {backup.sh, hindsight.env.example, README.md} 3 个文件,与 fix1 声明范围完全一致;其余 9 个交付文件与审阅基线逐字节一致。** 三个改动文件的新哈希与任务给定的 worker_done 前缀(99564e0d…/d109e9f7…/62ede825…)及 fix1 附录表格全长吻合。

**Git 面貌无扩张**:`git status -uall` = 基线 11 个未跟踪交付文件 + `reports/ticket-380.md`(报告本体);`git diff HEAD` 为空;`hindsight.env` 与 `backups/`(含 fix1 复跑产生的 `hindsight-20261015T180936Z.sql.gz`)均被 `deploy/hindsight/.gitignore` 覆盖,非交付物。

### 方法说明(诚实披露)

基线字节未在盘上留存(全盘搜索未见 7ea2fc56…/02c9e996…/bbe84881… 的副本),故本复审的 diff-of-diffs 采用**哈希锚定 + 内容范围核验**:(a) 9 个文件以 sha256 全等证明逐字节一致;(b) 3 个改动文件全文精读,逐一确认当前内容中每一处语义要素要么属于基线已有内容(与审阅报告对基线行为的描述吻合:0–30 校验 exit 1、instance.json 动态解析、change-me 占位符、隐私块等),要么属于 F1/F3 声明的增量(见下);(c) 与 fix1 附录改前/改后哈希对闭环。三点一致,未发现声明范围之外的任何改动。

## 二、逐文件 diff-of-diffs 内容核验

### backup.sh(F1)

| 增量 | 内容 | 归属 |
| --- | --- | --- |
| 头注新增段 | "deleted at the first run once it has existed for HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS whole days (default 30)",并声明该值与 `hindsight.env`、`server/src/hindsight/config.ts` 校验同步 | F1 语义说明 |
| sweep 表达式 | `find "$BACKUP_DIR" -name 'hindsight-*.sql.gz' -type f -mtime "+$((RETENTION_DAYS - 1))" -delete`(基线为 `+$RETENTION_DAYS`,见 fix1 附录改前/改后哈希对与本文件其余逻辑未动) | F1 核心修复 |
| sweep 前新增注释块 | `find -mtime +N` = 按整 24h 周期计龄(去小数)严格大于 N;`+30` 只删满 31 整天(30.5 天龄存活,尾巴 ~31 天/日 cron 最坏 ~32 天);传 N−1 后满 `RETENTION_DAYS` 整天即在下一次运行删除,两次运行间最多多存一个调度间隔(默认 30 天窗口 + 日 cron ⇒ 最坏 ~31 天);附 2026-10-15 边界实测记录 | F1 语义说明 |

其余全部保留:usage/cron 示例、`set -euo pipefail`、`RETENTION_DAYS="${HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS:-30}"` 定义、非数字或 >30 即 exit 1 的 guard、instance.json 动态解析 pg 路径/凭据、pg_dump|gzip 管道、输出行。

### hindsight.env.example(F3)

| 增量 | 内容 | 归属 |
| --- | --- | --- |
| `HINDSIGHT_API_LLM_BASE_URL` 默认值 | `http://127.0.0.1:9100/v1` → `http://host.docker.internal:9100/v1` | F3 |
| `HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL` 默认值 | 同上 | F3 |
| 新增 NOTE 注释 | 容器内 `127.0.0.1` 指容器自身;宿主网关须经 `host.docker.internal`;仅非容器直跑宿主机时用 `127.0.0.1:9100` | F3 注释 |
| embeddings 段注释 | 补 "same host.docker.internal rule as the LLM URL above" 一句 | F3 注释 |

其余保留:API key 占位符(change-me-*)、隐私块(TRACE=false、RETENTION=1、CLEANUP=900、`HINDSIGHT_PRIVACY_*` 镜像块含 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=30`)。

### README.md(F1 语义同步 + F3 同步)

| 增量 | 内容 | 归属 |
| --- | --- | --- |
| Privacy posture 表 "Controlled backups" 行 | 改为 "deleted at the first run once they reach 30 whole days of age; between runs up to one schedule interval more (daily cron worst case ~31 days)" | F1 |
| Layout 节 `hindsight.env.example` 条目 | 新增 host-gateway 一句:容器内 127.0.0.1 指容器自身,非容器宿主直跑才用 `127.0.0.1:9100` | F3 |
| Layout 节 `backup.sh` 条目 | 写明满 `RETENTION_DAYS` 整天在首次运行删除、`find -mtime +N` 只在 N+1 整天匹配故传 N−1、实测边界(29.0d/29.5d 保留,精确 30.0d 删除) | F1 |

规范值未变(仍为 30 天窗口),仅语义表述精确化,与实现一致。

## 三、新边界语义正确性核验(+29 与 RETENTION_DAYS)

- **定义**:`RETENTION_DAYS="${HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS:-30}"`,默认 30;guard 拒绝非数字与 >30(exit 1)。与 `hindsight.env.example` 声明值 30、`config.ts` 的 `MAX_BACKUP_RETENTION_DAYS = 30`(违反即报 `backup_retention_days`)三者一致。
- **实现**:`-mtime "+$((RETENTION_DAYS - 1))"` ⇒ 默认 `-mtime +29`。
- **语义**:`find -mtime +N` 匹配 floor(以整 24h 计的龄) > N 的文件;`+29` 即 floor(龄) ≥ 30 天第一次运行时删除。**sweep 不变式成立:每次 sweep 结束后,不存在 ≥ RETENTION_DAYS(30) 整天龄的存活副本**;两次运行之间最多多存活一个调度间隔(日 cron 最坏 ~31 天,改前 ~32 天)。脚本头注、sweep 注释、README 三处表述与实现完全一致,且诚实披露了调度间隔尾巴,无夸大。
- **本复审独立边界复测**(/tmp 临时目录,BSD find,POSIX `+n` 语义,2026-10-16T03:05+08:00;精确按 mtime 定龄 29.0d/29.5d/30.0d/31.0d,实测龄 696h/708h/720h/744h):
  - 改前表达式 `-mtime +30` ⇒ 仅删 31.0d,**30.0d 存活**(缺陷精确复现);
  - 改后表达式 `-mtime +29` ⇒ 删 30.0d 与 31.0d,**29.0d 与 29.5d 保留**;
  - `-mtime +29 -delete` 执行后仅余 29.0d/29.5d 两个副本。
  与 fix1 附录的五点边界表完全一致。

## 四、Findings 解决判定

| Finding | 判定 | 依据 |
| --- | --- | --- |
| F1(备份边界语义,LOW) | **RESOLVED** | sweep 改传 N−1(+29);头注/sweep 注释/README 三处语义同步;本复审 /tmp 独立复现 30.0d 边界从"存活"变"删除";与 RETENTION_DAYS 定义及 config.ts 上限三角一致。注:F1 建议中"补一条 shell 边界测试"以**文档化的手动边界实测**(脚本注释 + fix1 附录 + 本复审独立复测)满足,未新增自动化 shell 测试——不阻塞(F1 为 LOW,边界已三方可复现),留作后续票据可选小项 |
| F3(example 网关 URL 容器内不可达,LOW) | **RESOLVED** | 两条默认 URL 改 `host.docker.internal:9100/v1` 并加容器/宿主 NOTE;README Layout 节同步一句;与运行态 git-ignored `hindsight.env`(哈希未动,审阅实证其可用值即 host.docker.internal)一致 |
| F2(合规判断基于声明,LOW) | 范围外(按审阅建议留 Wave 2) | `config.ts`/`health.ts` 哈希未变,确认 fix1 未越范围改动 |
| F4–F7(INFO) | 范围外 | 相关文件哈希均未变 |

## 五、复审复跑证据(本复审亲自执行)

1. `bun test server/tests/hindsight-config.test.ts server/tests/hindsight-health.test.ts` → **21 pass / 0 fail / 50 expect()**(Ran 21 tests across 2 files)——与 fix1 声明的 21-pass 基线一致,无回退。
2. `cd server && bunx tsc --noEmit` → **exit 0**。
3. `bash -n deploy/hindsight/backup.sh` → 语法通过。
4. /tmp 边界复测见第三节(未触仓库)。
5. Git 面貌:HEAD `f0520524` 未动;tracked diff 空;无新增交付文件;无 commit/push。

## 六、最终判定(两维度)

| 维度 | 结论 |
| --- | --- |
| Spec 合规(修复范围与边界语义) | **PASS** — 变化面恰好为 fix1 声明的 3 文件(F1+F3),其余 9 文件逐字节一致;+29 边界语义正确,注释/README/config 交叉引用一致;未触碰 F2 等留待 Wave 2 的范围 |
| 代码质量(fix1 增量) | **PASS** — 修复是最小、精确的表达式与文档改动;语义注释诚实披露调度间隔尾巴;实测边界可独立复现(本复审已复现);无新增缺陷 |

**无阻塞 finding。** 观察(非阻塞):F1 的自动化 shell 边界测试未随 fix1 落地,以手动实测 + 三处文档替代,可在后续删除链票据(#381+ 波次)顺带补一条 `find` 边界用例。
