#!/usr/bin/env python3
"""Build docs/tickets/opik-4/manifest.json following the bifrost-5 convention.

verification commands are derived from each ticket's owned_scope so they are
real repository commands (bun test / tsc --noEmit / biome / vite build /
docker compose config), not invented ones.
"""
import json, pathlib, re, subprocess

HERE = pathlib.Path(__file__).resolve().parent          # .../github evidence dir
WT = HERE.parents[4]                                     # worktree root
REPO_ROOT = WT
OUT = WT / "docs/tickets/opik-4/manifest.json"

proposal = json.loads((HERE / "ticket-proposal-v2.json").read_text())
pub = json.loads((HERE / "publication-v2.json").read_text())
ver = json.loads((HERE / "publication-verification-v2.json").read_text())
md = (HERE / "ticket-breakdown-v2.md").read_text()

num = {t: v["number"] for t, v in pub["issues"].items()}
url = {t: v["url"] for t, v in pub["issues"].items()}

# owned_scope per ticket, parsed back out of the approved breakdown doc.
# The doc wraps paths in backticks and sometimes uses a shorthand that drops the
# directory of the previous entry (`evaluation/datasets.ts`). Both are normalized
# here so the derived verification commands are real.
ANCHORS = ("server/", "app/", "shared/", "agent-langgraph/", "supervisor/",
           "docker/", "tests/", "docs/", "scripts/", "worker/", "runtime-go/")
EXACT = {"bun.lock", ".env.example", "package.json"}

def normalize_owned(raw):
    out, last_dir = [], None
    for item in raw:
        e = item.strip()
        if not e:
            continue
        # drop trailing prose annotations: `path`（入口） / path + snapshot/journal
        e = re.split(r"（|\(| \+ ", e)[0].strip().strip("`").strip()
        if not e:
            continue
        if e in EXACT or e.startswith(ANCHORS):
            last_dir = e.rsplit("/", 1)[0] if "/" in e else None
            out.append(e)
        elif re.fullmatch(r"[\w.$@\[\]-]+\.(tsx?|sql|json|md|yml|yaml)", e):
            # bare filename -> inherit the directory of the previous full path
            out.append(f"{last_dir}/{e}" if last_dir else e)
        elif "/" in e and not e.split("/")[0].startswith(("server", "app", "shared", "docker", "tests", "docs", "agent-", "supervisor")):
            out.append(f"{last_dir}/{e}" if last_dir else e)
        else:
            out.append(e)  # prose such as "locales 命名空间" or "i18n 注册处"
    return out

owned = {}
handoff_line = {}
for m in re.finditer(r"\*\*(T\d\d) ([^\n]+)\*\*\n(.*?)(?=\n\*\*T\d\d |\n## |\Z)", md, re.S):
    tid, title, body = m.group(1), m.group(2), m.group(3)
    o = re.search(r"- Owned: (.+)", body)
    h = re.search(r"- Handoff: (.+)", body)
    owned[tid] = normalize_owned(o.group(1).split("、")) if o else []
    handoff_line[tid] = h.group(1).strip() if h else ""

GROUPS = [
    ("00", "prefactor-seams", "Prefactor 与 seam", ["T01", "T02"]),
    ("01", "opik-foundation", "Opik 部署、契约与安全地基", ["T03", "T04", "T05", "T06", "T07", "T08", "T09"]),
    ("02", "safe-run-records", "安全运行记录", ["T10", "T11", "T12", "T13"]),
    ("03", "detailed-steps", "详细运行步骤", ["T14", "T15", "T16", "T17", "T18"]),
    ("04", "versioned-datasets", "版本化评测集", ["T19", "T20", "T21"]),
    ("05", "evaluation-and-scoring", "隔离评测、评分与对比", ["T22", "T23", "T24", "T25", "T26", "T27", "T28", "T29", "T30", "T31"]),
    ("06", "operations-lifecycle", "运维、导出与生命周期", ["T32", "T33", "T34", "T35", "T36", "T37"]),
]
group_of = {t: (g, gs, gt) for g, gs, gt, ts in GROUPS for t in ts}
assert sum(len(x[3]) for x in GROUPS) == 37

def verification(tid):
    files = owned.get(tid, [])
    joined = " ".join(files)
    cmds = []
    tests = [f for f in files if re.search(r"\.test\.tsx?$", f) and "+" not in f and "(" not in f and " " not in f]
    unit = [t for t in tests if ".integration.test." not in t]
    integ = [t for t in tests if ".integration.test." in t]

    if unit:
        cmds.append("bun test " + " ".join(unit))
    if "server/drizzle/" in joined:
        cmds.append("cd server && bun run db:generate   # 生成迁移后人工核对 SQL 与 snapshot")
    if integ:
        cmds.append("TEST_DATABASE_URL=<isolated-pg> bun test " + " ".join(integ)
                    + "   # 缺 TEST_DATABASE_URL 会 skip，不得记为通过")
    if "agent-langgraph/" in joined and not any(t.startswith("agent-langgraph") for t in tests):
        cmds.append("bun test agent-langgraph/tests/")
    if "supervisor/" in joined and not any(t.startswith("supervisor") for t in tests):
        cmds.append("bun test supervisor/tests/environment.test.ts")
    if "docker/compose/opik.yml" in joined:
        cmds.append("docker compose --project-directory . -f docker/compose/opik.yml config --quiet")
    if "server/scripts/opik-contract.ts" in joined:
        cmds.append("bun server/scripts/opik-contract.ts --target <opik-api> "
                    "--evidence docs/plans/evidence/2026-10-14-opik/%s" % tid.lower())
    if "server/scripts/opik-acceptance.ts" in joined:
        cmds.append("bun server/scripts/opik-acceptance.ts --target <opik-api> "
                    "--evidence docs/plans/evidence/2026-10-14-opik/final")
    if "tests/e2e/" in joined:
        cmds.append("bun run test:ui")
    if any(f.startswith("app/") for f in files):
        cmds.append("cd app && bun run typecheck")
        cmds.append("cd app && bun run build")
    if any(f.startswith(("server/", "shared/")) for f in files):
        cmds.append("cd server && bun run typecheck")
    if any(f.startswith("supervisor/") for f in files):
        cmds.append("cd supervisor && bun run typecheck")
    cmds.append("bunx biome lint --error-on-warnings . && bunx biome format .")

    seen, out = set(), []
    for c in cmds:
        if c not in seen:
            seen.add(c); out.append(c)
    return out

tickets = []
for t in proposal["tickets"]:
    tid = t["id"]
    g, gs, gt = group_of[tid]
    blockers = t["blocked_by"]
    consumes = [f"{b}(#{num[b]}) 的交付契约：{handoff_line.get(b,'')}" for b in blockers]
    scope = owned.get(tid, [])
    resume = (
        f"只需读三样东西：父 Spec #4 的 {', '.join(t['covers'])}；"
        + (f"前置 {', '.join('#%d' % num[b] for b in blockers)} 的 handoff.produces；" if blockers else "无前置；")
        + f"本 Ticket 的 owned_scope 与验收标准。不要读父会话或 v1/v2 全量计划。"
        f"中断后从 checkpoint 记录的最后一个 GREEN 命令继续；checkpoint 为空则从 RED 重新开始。"
        f"owned_scope 之外的文件不要改；需要改就说明契约冲突并按 failure_policy 记录阻塞。"
    )
    tickets.append({
        "id": tid,
        "group": g, "group_slug": gs, "group_title": gt,
        "title": t["title"],
        "github_issue": num[tid],
        "url": url[tid],
        "depends_on": blockers,
        "depends_on_issues": [num[b] for b in blockers],
        "acceptance_ids": t["covers"],
        "primary_repo": "openbot",
        "what": t["delivers"],
        "status": "published-ready-for-agent",
        "handoff": {
            "consumes": " | ".join(consumes) if consumes else "",
            "produces": t["handoff"],
            "owned_scope": ", ".join(scope),
            "verification": verification(tid),
            "resume_hint": resume,
            "checkpoint": "",
        },
    })

manifest = {
    "repository": "1123786563/OpenBot",
    "parent": "https://github.com/1123786563/OpenBot/issues/4",
    "source_read_date": "2026-10-15",
    "source_state": "OPEN",
    "source_comments": 0,
    "status": "published-37-tickets-native-relationships-verified",
    "issue_number_range": [min(num.values()), max(num.values())],
    "split_policy": [
        "O1 每张 Ticket 只引入一个可观察行为变化（一个新语义、一个新拒绝路径或一个新展示），owned files ≤ 8，验证命令可在单个 code agent 上下文内跑完。",
        "O2 单一 owner role：backend / frontend / infra / agent-runtime 不混在同一张 Ticket，便于按稳定接口并行分派。",
        "O3 成功路径与拒绝路径都在同一张 Ticket 的验收标准里写全，接手 agent 不会漏掉拒绝语义。",
        "O4 界面展示单独成张，但必须自带端到端可见验证（登录→看到→操作→状态变化）。",
        "O5 故障注入与恢复（上游超时/离线/漂移、重启、并发、取消、lease、时钟推进）写入对应 Ticket 的验收标准，不推给最后的验收张。",
        "O6 禁止无行为 Ticket：只有迁移、只有类型定义或只有配置项而无法在公开边界观察结果的，并回上一张。T01/T02 是显式记录的例外，见 documented_deviations。",
        "O7 每张 Ticket 必带 handoff 六件套：consumes / produces / owned_scope / verification / resume_hint / checkpoint；失败即弃，接手 agent 只读 handoff 与 checkpoint 即可续做。",
        "O8 上游 HTTP 序列化只由 T04(#10) 的 VerifiedOpikContract manifest 驱动，任何 Ticket 不得各自发明请求格式。",
        "O9 最后一张 T37(#43) 是全范围缝合与验收，保证结束时存在端到端可演示行为，防止细拆退化成水平切片。",
    ],
    "documented_deviations": [
        "T01(#7) 与 T02(#8) 是 prefactor，按 to-tickets「Make the change easy, then make the easy change」先行，其验证以结构性回归为主而非端到端业务行为：T01 的可观察面是未认证/无归属请求在进入业务逻辑前被拒绝、且模块未启用时现有接口与 tracing 零变化；T02 的可观察面是八类可用性状态的双语文案与命名空间隔离。",
        "T02(#8) 的验收标准第 3 条提到「直接输入路由时仍执行权限校验」，但对应路由要到 T12(#18) 才存在，因此该条在 T02 阶段只能验证路由约定本身，不能端到端验证；实施 T02 时不得把该条记为通过，应留到 T12(#18) 验证。",
        "T37(#43) 依赖全部 36 张，是协调与验收性质，不引入新功能；其 blocked_by 边在 GitHub 上为 36 条。",
        "T02(#8) owned files = 10，超过 O1 的 ≤8 上限：8 个是四个子命名空间 × 两种语言的极小 JSON stub，另 2 个是 i18n 注册文件，总内容量远小于一个 4 文件的逻辑 Ticket；拆成两张会人为割裂命名空间归属矩阵。这是记录在案的例外，不是遗漏。",
        "T11(#17) 增加 T01(#7) 为前置：原草案里 T01 没有任何后继，属于孤儿 prefactor，路由 seam 可能被跳过或与需要它的 Ticket 并行；补边后 T01 成为全部路由类 Ticket 的祖先。",
        "T02(#8) 由单一 ai-observability 命名空间改为 -runs/-datasets/-evaluations/-admin 四个子命名空间：图分析发现 6 个前端 Ticket 共享同两个 locale JSON，其中 10 对在依赖图上不可比较，并行派发必然冲突；拆分后四条前端链文件不相交。",
    ],
    "global_constraints": [
        "以父 Spec #4 为事实源：OpenBot 保留权威归属、存储定位、非敏感版本引用与持久任务状态；Opik 只保存脱敏后的追踪与评测内容，其 metadata 不能改变业务归属。",
        "本 Ticket 是业务完整切片，接口、数据库变更、授权、必要用户/管理状态与行为测试同时完成；只改 owned_scope，不顺便实施其他 Ticket。",
        "领取前核验 GitHub 原生 blocked_by 全部完成并已集成到当前工作区，读取其实际交付契约（handoff.produces）；依赖未完成不造假桩冒充已集成。Ticket 内的 fake 仅为测试，不得成为生产降级。",
        "集成必须可选：关闭时现有 Agent 执行与 tracing 行为完全不变；Opik 故障、慢响应、离线或队列饱和不得改变正常 Agent 结果，观测不进入运行关键路径。",
        "任何写入、评测或导出前完成脱敏投影：凭据、内部能力、连接串、账号标识、reasoning 内容与原始附件排除；无法可靠处理的自由文本降级为仅指标。canary 测试是必备证据，治理范围覆盖正文、metadata、异常、名称与 URL。",
        "授权复用现有 Bot 管理与管理员权限：public 聊天权与分享权不授予观测访问；列表、聚合、详情、span、数据集、实验、评分与导出全部校验；不暴露任意上游查询代理；移交或撤权立即影响历史查询、分页、缓存、下载与排队任务。",
        "企业租户只预留可替换 seam：不创建租户表、不伪造租户、不引入隐式租户头、不建租户角色层级、不把 workspace/project 布局当作授权；未知企业 scope 拒绝且不回退工作台 scope。",
        "上游调用只经单一 port，序列化只由 T04(#10) 的 VerifiedOpikContract manifest 驱动；缺失 provider usage 显示 unavailable 而不当 0；Opik 侧成本只是分析用途，计费台账保持权威。",
        "评测执行遵守适用 Credit Gate、Admission、Reservation/Settlement；每个样本执行前重新授权；取消、lease 恢复与外部未知结局不自动重复调用或重复扣费；隔离 thread 与测试工具不得写生产会话、memory、learning 或业务数据。",
        "外部真实 Opik 缺环境时完成本地确定性测试，并把对应能力保留为未验证/不可启用，不编造上游证据；测试库、测试账户与 Opik 实例必须与应用数据隔离，缺 TEST_DATABASE_URL 不回退开发数据库、不记为通过，skipped 不等于通过。",
    ],
    "execution_procedure": [
        "先读父 Spec #4 中本 Ticket 的 acceptance_ids 条目、所有前置 Ticket 的 handoff.produces 与本 Ticket 的 owned_scope；记录原始 BASE 与工作区状态。不需要读父会话或 v1/v2 全量计划。",
        "按仓库要求建立或核验工作区（优先独立 Git Worktree），先用 Superpowers writing-plans 产出文件级实施计划与 RED/GREEN 命令，再 SDD/TDD；不重新做产品发现。",
        "从本 Ticket 验收标准写公开边界失败测试（RED）；涉及事务或金额先建立隔离测试账户与专用 PostgreSQL（TEST_DATABASE_URL），涉及上游先准备可注入的对抗性 fixture，涉及界面先确定登录→看到→操作→状态变化的路径。",
        "按 owned_scope 完成最小业务路径，添加必要约束/迁移、认证与状态展示；前置产出的契约不兼容时先记录并解决，禁止静默改别人的接口。",
        "补齐故障注入与越权用例，运行 handoff.verification 全部命令，并运行受影响包 typecheck、biome lint/format 与前端 build；涉及并发时执行对应 race/双 worker 测试。",
        "由独立验证者 review，再按仓库流程完成 OCR/修复/复审；把实际变更范围、接口请求响应与错误语义、迁移与回退说明、验证命令与结果、检查点哈希写入 handoff.checkpoint。没有提交授权时使用未提交检查点，不自动提交、推送或改父 Issue。",
    ],
    "failure_policy": "可修复代码问题在本 Ticket 内完成修复及相关重验；缺权限/环境/真实 Opik 实例证据或发现已批准需求冲突时，记录精确阻塞及受影响能力，不反复猜测、不静默降级、不把 skipped 当通过。",
    "serialization_constraints": [
        "server/src/copilot.ts 必须串行：T10(#16) -> T14(#20) -> T23(#29)，不得并行派发。",
        "server/drizzle 迁移必须串行：T07(#13) -> T19(#25) -> T22(#28)，各自独立迁移编号。",
        "server/src/index.ts 只由 T01(#7) 建立单行注册、T24(#30) 加 worker 启动行，其余 Ticket 不得编辑。",
        "server/src/ai-observability/opik-http.ts 由 T08(#14) 建立，后续 Ticket 只追加自己的 endpoint 函数，且序列化由 #10 的 manifest 驱动。",
        "app/src/routeTree.gen.ts 是生成物；冲突时以重新生成为准，不手工合并。",
    ],
    "parallel_opportunities": [
        "起始 frontier（blocked_by=0，可 5 路并行）：T01(#7)、T02(#8)、T03(#9)、T05(#11)、T06(#12)。",
        "T15(#21) 与 T16(#22) 可并行（不同模块边界）。",
        "T26(#32) 规则评分不依赖 T23/T24/T25，可与执行编排并行。",
        "T29(#35)/T31(#37) 对比链不依赖 T27(#33) 模型 Judge，规则评分即可成立。",
        "T32(#38)/T33(#39) 运维链可与整个 Phase 05 并行。",
    ],
    "edge_relaxations": [
        "T37(#43) 前置收敛为全部 36 张终点，因为它是全范围验收而非新功能。",
        "T26(#32) 只等 T22(#28)，不等执行编排链 T23/T24/T25，使规则评分可提前落地。",
        "T29(#35) 与 T31(#37) 不等 T27(#33)，Judge 作为后续版本化评分定义参与对比而非前置。",
        "T16(#22) 只等 T14(#20)，不等 T15(#21)，使 LangGraph 接入可与工具/检索步骤并行。",
    ],
    "contention_analysis": {
        "method": "对每个被 >1 张 Ticket 拥有的文件，检查其全部拥有者两两是否在依赖图上可比较（一方是另一方的祖先）。不可比较即代表可被并行派发并冲突。",
        "files_owned_by_multiple_tickets": 19,
        "parallel_unsafe_pairs": 0,
        "result": "PASS — 所有共享文件的拥有者都被依赖边串行化，见 serialization_constraints",
        "evidence": "sync-report-v2.json",
    },
    "tickets": tickets,
    "publication_verification": {
        "file": "docs/plans/evidence/2026-10-14-opik/github/publication-verification-v2.json",
        "result": "PASS" if ver.get("ok") else "FAIL",
        "problems": ver.get("problems", []),
        "native_subissues_on_parent": ver.get("native_subissues_on_parent"),
        "native_blocked_by_edges": ver.get("native_blocked_by_edges"),
        "labels_ready_for_agent": ver.get("labels_ready_for_agent"),
        "parent_body_unmodified": ver.get("parent_body_unmodified"),
    },
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
print("wrote", OUT.relative_to(REPO_ROOT))
print("tickets:", len(tickets))
print("groups:", len({t["group"] for t in tickets}))
bad = [t["id"] for t in tickets if not t["handoff"]["owned_scope"]]
print("tickets missing owned_scope:", bad)
bad2 = [t["id"] for t in tickets if not t["handoff"]["verification"]]
print("tickets missing verification:", bad2)
print("sample verification T07:", json.dumps(next(t for t in tickets if t["id"]=="T07")["handoff"]["verification"], ensure_ascii=False, indent=1))
