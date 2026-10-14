#!/usr/bin/env python3
"""Create the Orca Run and the frontier-wave task DAG.

5 implementers (independent) -> 5 reviewers (one per implementer) -> 1 final
whole-branch review at the strongest tier. Task specs are self-contained per the
orchestration task-spec contract: Target, Change, Constraints, Ownership,
Observable acceptance.
"""
import json, pathlib, subprocess, sys

ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
WT = pathlib.Path("/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration")
BASE = "1123786563/opik-integration"
REPO = "1123786563/OpenBot"
LEDGER = WT / "docs/plans/evidence/2026-10-14-opik/orca-frontier-wave.json"

manifest = json.loads((WT / "docs/tickets/opik-4/manifest.json").read_text())
by_id = {t["id"]: t for t in manifest["tickets"]}
FRONTIER = ["T01", "T02", "T03", "T05", "T06"]
WT_NAMES = {
    "T01": "opik-t01-module-seam",
    "T02": "opik-t02-ui-i18n",
    "T03": "opik-t03-deployment",
    "T05": "opik-t05-redaction",
    "T06": "opik-t06-scope-seam",
}

# Non-negotiables per ticket, beyond the plan's own Global Constraints.
HARD = {
    "T01": [
        "观测授权必须用 canManageAgent，绝不能用 canAccessAgent（后者对 visibility=public 放行，正是父 Spec 禁止的聊天权变观测权）",
        "server/src/app.ts 只允许加一个可选 deps 字段 + 一行 app.route；server/src/index.ts 只允许加构造与传参",
        "不引入任何租户表/租户头/企业 scope；不做任何 Opik 出站 HTTP 调用",
        "deps 缺省时路由不挂载，/api/ai-observability/* 返回 404 且既有接口零变化",
    ],
    "T02": [
        "四个子命名空间必须静态 import（index.ts 注释已说明 lazy loader 会输掉 changeLanguage 的 fallback 竞态），不得引入 lazy bundle",
        "不得编辑既有共享文案文件 agents.json / errors.json / admin.json / nav.json / common.json",
        "八类状态 disabled/empty/forbidden/basic/omitted/truncated/syncing/unavailable 在 en 与 zh-CN 都必须齐备且非空，key 集合逐字相同",
        "不建路由文件、不写组件、不实现 state→文案 映射函数（那是 #18 的）",
    ],
    "T03": [
        "禁止任何浮动 tag：versions.json 里出现 latest/stable/edge 即视为未完成",
        "Opik 的 OTLP 宿主端口必须是 5418/5417，不能是上游默认的 4318/4317（LGTM 栈的 Tempo 已在 loopback 占用）",
        "所有发布端口只绑 127.0.0.1 与 [::1]，不得出现 0.0.0.0 或裸 HOST:CONTAINER",
        "必须排除 demo-data-generator（写示例数据会污染 #43 真实验收）与 jaeger（已有 Tempo）",
        "compatibility.status 必须保持 unverified——只有 #10 拿到真实 ingest/query/delete 证据后才能翻成 verified",
        "不得把任何真实密码写进 compose、docs 或 .env.example",
    ],
    "T05": [
        "纯函数：不做 IO、不读环境变量、不打日志、不调上游",
        "fail closed：无法判定安全的内容一律 omitted（仅指标），不得先透传",
        "canary 断言必须写成『输出不含 canary』，不得写成『canary 被替换成 ***』（只重写被测字面量的脱敏器能过自己的测试却会漏下一种凭据形状）",
        "治理面必须覆盖正文、metadata、异常、名称、URL 五类",
        "projected / omitted / truncated 三态不得塌缩成空字符串",
    ],
    "T06": [
        "照 server/src/enterprise/tenancy/scope.ts 的 fail-closed 先例：唯一 resolve 函数、Object.freeze、模块私有 WeakSet、assertScope；序列化/展开/手搓的 scope 一律拒绝",
        "错误类照 EnterpriseError：code 即契约，message 就是 code",
        "未知企业 scope 必须拒绝且不回退工作台 scope；拒绝要发生在 ownership 判定之前",
        "禁止：租户表、伪造租户、读隐式租户头、租户角色层级、把 workspace/project 布局当授权、反推 scope 的函数",
        "不得导出任何 issueScopeUnsafe 式逃生舱",
        "scope 必须是显式参数，不得引入模块级 current scope 变量",
    ],
}


def orca(args):
    r = subprocess.run([ORCA] + args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(f"FAILED: orca {' '.join(args[:3])}\n{r.stderr.strip()[:800]}\n")
        raise SystemExit(1)
    return json.loads(r.stdout)


def impl_spec(tid):
    t = by_id[tid]
    n = t["github_issue"]
    owned = t["handoff"]["owned_scope"]
    ver = "\n".join(f"   - `{c}`" for c in t["handoff"]["verification"])
    hard = "\n".join(f"   - {h}" for h in HARD[tid])
    return f"""【角色】实现者 implementer。你是 Orca 编排派发的 supervised worker，必须遵守注入 preamble 的 ask / heartbeat / worker_done 规则。

【TARGET】
- 仓库 {REPO}，你的 worktree 基于分支 `{BASE}`
- Ticket：https://github.com/{REPO}/issues/{n} — {tid} {t['title']}
- 实施计划（必读，按它逐步执行）：`{t['plan_file']}`
- 交接契约：`docs/tickets/opik-4/manifest.json` 的 `{tid}` 条目（consumes / produces / owned_scope / verification）
- 基线与已知红（必读，先读再动手）：`docs/plans/evidence/2026-10-14-opik/baseline-gates-2026-10-15.md`

【CHANGE】
按计划的 Task 1..N 顺序执行。每个 Step 严格照 RED → 运行确认失败 → 最小实现 → 运行确认通过 → commit。
不要跳步、不要合并步骤、不要先写实现再补测试、不要在测试还没红之前就写实现。
计划里每个 Task 的 Interfaces 块声明了 Consumes/Produces：Produces 的函数名与类型签名必须逐字照做，下游 Ticket 只靠它对接。

【CONSTRAINTS】
- 只允许改 owned_scope 内的文件：{owned}
- 计划的 Global Constraints 全部生效。其中不可协商的：
{hard}
- 不得 merge / rebase main，不得 push，不得改父 Spec #{4}，不得改 `docs/tickets/opik-4/manifest.json`（协调者的文件）
- `server/tests/ready.test.ts` 在基线就是红的（TypeError in createApp，属既有问题，不在本 Ticket 范围）：不要修它。只有当它因你的改动而以**不同方式**失败时才算你的回归
- 缺 `TEST_DATABASE_URL` 时集成测试会 skip；**skipped 不等于 passed**，必须记为未验证
- 不要把 `.env` 复制进 worktree（含真实凭据，且全部门禁都不需要它——已实测）
- 若 `bun test` 无法解析模块，先在 worktree 根跑 `bun install` 并在 checkpoint 里记录
- 依赖缺失、环境缺失、上游不可达：记录精确阻塞，不要造假桩冒充已集成，不要把 skip 当通过

【OWNERSHIP】
你独占上面 owned_scope 列出的文件。另有 4 个 frontier Ticket 正在兄弟 worktree 并发执行，
不要碰它们的文件，也不要碰任何未列在你 owned_scope 内的共享文件
（`server/src/index.ts`、`server/src/app.ts`、`server/src/copilot.ts`、drizzle 迁移、`app/src/locales` 既有文件）。
需要改 owned_scope 之外的东西 = 契约冲突，走下面的失败即弃流程，不要自行扩权。

【OBSERVABLE ACCEPTANCE】
1. 计划的 verification 命令全部真实跑过并粘贴输出：
{ver}
2. `git diff --name-only {BASE}..HEAD` 的结果必须是 owned_scope 的子集；越界即不合格
3. 计划每个 Task 末尾的 commit 都存在（`git log --oneline {BASE}..HEAD`）
4. 写 `docs/tickets/opik-4/checkpoints/{tid}.md`，内容包含：
   - 你的分支名与 worktree 路径
   - 每个 commit 的 hash 与 message
   - `git diff --name-only {BASE}..HEAD` 的完整输出
   - 每条验证命令 + **真实输出粘贴**（不要转述、不要只写 PASS）
   - produces 的最终签名（下游要照它对接）
   - 遇到的阻塞、做出的现场决策、与计划的任何偏差及理由
5. `worker_done` 恰好一次，带 `--outcome succeeded` 或 `--outcome failed`（失败不得只写在散文里）、
   `--files-modified` 真实清单、`--report-path docs/tickets/opik-4/checkpoints/{tid}.md`，
   外加三句话执行摘要

【失败即弃】
无法在 owned_scope 内完成、或发现计划与真实代码结构冲突（既有函数签名不同、文件已存在且语义不同等），
不要静默改别人的接口、不要扩大改动范围、不要为了让测试变绿而放宽断言。
用 preamble 的 ask 命令问协调者；问不到就 `worker_done --outcome failed` 并精确写明阻塞点与受影响能力。
本 Ticket 失败不得污染已验证的兄弟 Ticket。"""


def review_spec(tid):
    t = by_id[tid]
    n = t["github_issue"]
    hard = "\n".join(f"   - {h}" for h in HARD[tid])
    return f"""【角色】审阅者 reviewer，**只读**。你是 Orca 编排派发的 supervised worker，遵守 preamble 的 ask / heartbeat / worker_done 规则。

【TARGET】
- 被审对象：实现者刚交付的 {tid} 分支（协调者在派发后立刻用消息告诉你确切分支名与 worktree 路径；没收到就用 ask 问，不要自己猜）
- Ticket：https://github.com/{REPO}/issues/{n} — {tid} {t['title']}
- 判据来源：该 Ticket 的验收标准（Issue 正文）、`{t['plan_file']}`（含 Global Constraints 与 Self-Review 声明）、
  `docs/tickets/opik-4/manifest.json` 的 `{tid}` 条目、`docs/plans/evidence/2026-10-14-opik/baseline-gates-2026-10-15.md`

【CHANGE】
不改任何源码、不改任何测试、不修任何 bug、不 commit 源码改动、不 push、不 merge。
你唯一允许写入的文件是审阅报告：`docs/plans/evidence/2026-10-14-opik/reviews/{tid}-review.md`
发现问题只记录，由协调者裁决后另行派发修复。

【CONSTRAINTS】
- 只读审阅。即使你一眼看出怎么修，也不要修——审阅者的 worker_done 只授权协调者综合结论，不授权改文件
- 所有结论必须基于你**实际跑过**的命令与实际读到的代码，不得凭计划文本或实现者的自述下判断
- `server/tests/ready.test.ts` 基线即红，不是实现者的问题；但若它以**不同方式**失败，那是回归
- skipped 不等于 passed；实现者把 skip 记成通过，本身就是一条 finding

【OWNERSHIP】
只有 `docs/plans/evidence/2026-10-14-opik/reviews/{tid}-review.md` 这一个文件。

【OBSERVABLE ACCEPTANCE】报告必须逐条给出：
1. **验收标准逐条核验**：Issue #{n} 的每条 acceptance criterion → verdict(pass/fail/unverifiable) + 你跑的确切命令 + 真实输出摘录
2. **计划 Self-Review 声明核验**：计划末尾 Self-Review 声称覆盖了哪几条，逐条判断是否属实（这是最容易虚报的地方）
3. **改动范围核对**：`git diff --name-only {BASE}..HEAD` 是否 ⊆ owned_scope（{t['handoff']['owned_scope']}）；越界文件逐个列出
4. **不可协商约束专项核对**：
{hard}
5. **测试质量**：是否真的断言了拒绝路径而不只测成功路径；有没有为让测试变绿而放宽/删弱断言；
   有没有 TODO、被 skip 的测试、只测 mock 不测公开边界的测试
6. **接口契约**：实现者产出的签名是否与计划 Interfaces 块的 Produces 逐字一致（下游 Ticket 要照它对接，漂移会连锁失败）
7. **门禁真实结果**：typecheck / lint / build / 目标测试，你自己重跑一遍，不要抄实现者的输出
8. **findings 分级**：critical / high / medium / low，每条给出文件路径与行号、为什么是问题、建议方向（不是补丁）
9. **结论**：approve / request-changes / blocked，一句话理由

`worker_done` 恰好一次，`--outcome succeeded`（审阅**完成**即成功，与结论是否 approve 无关；
只有你自己没能完成审阅才用 failed），`--report-path docs/plans/evidence/2026-10-14-opik/reviews/{tid}-review.md`，
三句话执行摘要里必须直接说出结论是 approve 还是 request-changes。"""


FINAL_SPEC = f"""【角色】全分支终审 final whole-branch reviewer，**只读**，最高档模型。你是 Orca 编排派发的 supervised worker。

【TARGET】
- 被审对象：协调者把 5 个 frontier 分支集成之后的**单一分支**。确切 ref 由协调者在派发后用消息给你；
  没收到就用 ask 问，不要自己猜、不要审 5 个分散分支。
- 范围：{', '.join(f"#{by_id[t]['github_issue']} {t}" for t in FRONTIER)} 五张 Ticket 集成后的整体，
  以及它们与父 Spec https://github.com/{REPO}/issues/4 的一致性。

【CHANGE】
不改任何文件，除了终审报告 `docs/plans/evidence/2026-10-14-opik/final/frontier-wave-review.md`。
不修 bug、不 commit 源码、不 push、不 merge。

【CONSTRAINTS】
- 只读。发现问题只记录，由协调者（人类）裁决
- 结论必须基于你实际跑过的命令与实际读到的代码
- 基线与已知红见 `docs/plans/evidence/2026-10-14-opik/baseline-gates-2026-10-15.md`；
  `server/tests/ready.test.ts` 基线即红，不是本波次的问题
- 5 份单 Ticket 审阅报告在 `docs/plans/evidence/2026-10-14-opik/reviews/`，
  以及实现者 checkpoint 在 `docs/tickets/opik-4/checkpoints/`——**参考但不采信**，你要独立复核

【OWNERSHIP】
只有 `docs/plans/evidence/2026-10-14-opik/final/frontier-wave-review.md`。

【OBSERVABLE ACCEPTANCE】报告必须逐条给出：
1. **集成正确性**：5 个分支合并后有没有语义冲突（不是文本冲突）——重复定义、签名漂移、
   同名不同义的类型、两个 Ticket 各自发明了本应共享的概念。重点查 T01 的路由 seam 与 T02 的 i18n seam
   是否真的被其余三个 Ticket 用上，还是各绕各的
2. **跨 Ticket 契约一致性**：T06 的 ObservationScope / scopeKey 与 T05 的投影是否被按声明消费；
   Produces 的签名与下游实际调用是否逐字一致
3. **全量门禁**：`cd server && bun run typecheck`、`cd app && bun run typecheck`、`cd app && bun run build`、
   `bunx biome lint --error-on-warnings .`、`bunx biome format .`，以及 5 个新测试文件全部一起跑
   （`bun test server/tests/opik-module-skeleton.test.ts server/tests/opik-deployment.test.ts
   server/tests/opik-redaction.test.ts server/tests/opik-scope.test.ts app/src/lib/i18n/ai-observability.test.ts`）。
   单独跑各自绿、一起跑红是集成缺陷，必须抓出来
4. **父 Spec 一致性**：A1/A4/A5/A12 四条在本波次是否真的被推进；有没有任何 Ticket 悄悄扩大了父 Spec 的
   Out of Scope（企业租户、把 Opik workspace 当 ACL、第二套账号系统、替代既有 LGTM 栈）
5. **不可协商约束的全局复核**：canManageAgent 而非 canAccessAgent；无浮动 tag；OTLP 端口不是 4317/4318；
   端口只绑 loopback；无租户表/租户头；无 issueScopeUnsafe 逃生舱；无 lazy i18n loader；
   未编辑 agents.json/errors.json 等共享文案文件；未编辑 owned_scope 之外的文件
6. **证据真实性抽查**：随机抽 3 条 checkpoint 里声称的验证输出，自己重跑对比。
   声称与实际不符本身就是 critical finding
7. **skipped 与未验证清单**：哪些验收标准因缺 Docker / 缺 TEST_DATABASE_URL / 缺真实 Opik 实例而未被验证，
   逐条列出并说明还差什么才能验证
8. **findings 分级**：critical / high / medium / low，每条给文件与行号
9. **结论**：本波次可否进入下一波（T04/T07/T08 等依赖它们的 Ticket），一句话理由；
   若不可，列出必须先解决的最小集合

`worker_done` 恰好一次，`--outcome succeeded`（审阅完成即成功），
`--report-path docs/plans/evidence/2026-10-14-opik/final/frontier-wave-review.md`，
三句话摘要里必须直接说出可否进入下一波。"""


# Created separately so the JSON shape could be confirmed before building 11 tasks on it.
RUN_ID = "run_5f5dfacf3715"


def task_id(result):
    r = result["result"]
    if "task" in r:
        return r["task"]["id"]
    return r["id"]


def main():
    run_id = RUN_ID
    print(f"run_id = {run_id} (reusing the already-created Run)")

    tasks = {}
    for tid in FRONTIER:
        r = orca(["orchestration", "task-create", "--json", "--run", run_id,
                  "--task-title", f"{tid} 实现 #{by_id[tid]['github_issue']} {by_id[tid]['title']}",
                  "--display-name", f"impl {tid}",
                  "--spec", impl_spec(tid)])
        tasks[tid] = task_id(r)
        print(f"impl  {tid} -> {tasks[tid]}")

    reviews = {}
    for tid in FRONTIER:
        r = orca(["orchestration", "task-create", "--json", "--run", run_id,
                  "--deps", json.dumps([tasks[tid]]),
                  "--task-title", f"{tid} 审阅（只读） #{by_id[tid]['github_issue']}",
                  "--display-name", f"review {tid}",
                  "--spec", review_spec(tid)])
        reviews[tid] = task_id(r)
        print(f"review {tid} -> {reviews[tid]}")

    r = orca(["orchestration", "task-create", "--json", "--run", run_id,
              "--deps", json.dumps([reviews[t] for t in FRONTIER]),
              "--task-title", "全分支终审（最高档，只读）",
              "--display-name", "final branch review",
              "--spec", FINAL_SPEC])
    final_id = task_id(r)
    print(f"final -> {final_id}")

    ledger = {
        "created_at": "2026-10-15",
        "run_id": run_id,
        "repository": REPO,
        "base_branch": BASE,
        "repo_id": "d6edf033-748a-4549-ae5a-e9efd34cef91",
        "coordinator_worktree": str(WT),
        "agent": "claude",
        "model_policy": {
            "implementers": "omit --model so each worker inherits the user's configured claude default (user did not name a model)",
            "reviewers": "omit --model, same reason",
            "final_review": "strongest tier per the user's instruction; set --model/--effort at dispatch and verify launch.effective, never claim from launch.requested",
        },
        "placement": {
            "worktree": "new-child",
            "parent_worktree": "opik-integration",
            "base_branch": BASE,
            "setup": "run (repo hookSettings is null, so no hook runs; workers must bun install if modules are missing)",
        },
        "tasks": {
            "implementers": {t: {"task_id": tasks[t], "issue": by_id[t]["github_issue"],
                                  "worktree_name": WT_NAMES[t], "plan": by_id[t]["plan_file"]}
                             for t in FRONTIER},
            "reviewers": {t: {"task_id": reviews[t], "depends_on": tasks[t]} for t in FRONTIER},
            "final_review": {"task_id": final_id, "depends_on": [reviews[t] for t in FRONTIER]},
        },
        "dispatches": {},
        "baseline_evidence": "docs/plans/evidence/2026-10-14-opik/baseline-gates-2026-10-15.md",
        "checkpoint_convention": "docs/tickets/opik-4/checkpoints/<TID>.md written by each implementer; coordinator folds into manifest.json after review",
    }
    LEDGER.write_text(json.dumps(ledger, ensure_ascii=False, indent=1))
    print(f"\nledger -> {LEDGER.relative_to(WT)}")


if __name__ == "__main__":
    main()
